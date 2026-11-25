// 设备控制台会话驱动：在页面上下文里走 SockJS + STOMP，会话常驻，供 MCP 分步调用
(function () {
  const previous = self.__enspConsoleSessions;
  if (previous && typeof previous.values === 'function') {
    for (const session of previous.values()) {
      try {
        session.close();
      } catch {
        /* ignore */
      }
    }
  }
  if (self.__enspConsoleSessions) {
    for (const old of self.__enspConsoleSessions.values()) {
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
  }
  const sessions = new Map();
  self.__enspConsoleSessions = sessions;
  const driverId = Math.random().toString(36).slice(2, 8);
  const debug = [];
  self.__enspConsoleDebug = debug;
  const dbg = (event, data = '') => {
    debug.push(`${Date.now() % 100000} ${event} ${data}`);
    if (debug.length > 80) debug.shift();
  };
  let sidSeq = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) =>
    String(s)
      .replace(/\u0000/g, '')
      .replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/\r/g, '')
      .replace(/\x07/g, '')
      .replace(/[ \t]*---- More ----[ \t]*/g, '\n')
      .replace(/[ \t]+$/gm, '');
  const key = (sandboxId, deviceId) => `${sandboxId}:${deviceId}`;
  const PROMPT = /(?:<[^<>\r\n]+>|\[[^\[\]\r\n]+\]|PC>)\s*$/;
  // 设备的确认提示（如 "Save the configuration? [Y/N]"、"commit them before exiting [Y/N/C]"）。
  // 注意：PROMPT 正则也会匹配 [...]，所以必须先于 PROMPT 检测，否则确认提示会被误判为"命令已结束"，导致下一条命令错位。
  // 兼容末尾带冒号或默认值说明的写法：[Y/N]、[Y/N/C]:、[Y/N] (N):、[Y/N](default N):
  const CONFIRM_PROMPT = /\[(?:Y\/N|Y\/N\/C|y\/n|yes\/no)\](?:\s*\([^)]*\))?\s*:?\s*$/i;

  function frame(cmd, headers = {}, body = '') {
    const h = Object.entries(headers)
      .map(([k, v]) => `${k}:${v}`)
      .join('\n');
    return `${cmd}\n${h}${h ? '\n' : ''}\n${body}\u0000`;
  }

  async function connect(sandboxId, deviceId) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const server = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
      const session = Math.random().toString(36).slice(2, 14);
      const url = `${location.origin.replace('https', 'wss')}/web.socket/${server}/${session}/websocket`;
      const ws = new WebSocket(url);
      const state = { opened: false, connected: false, chunks: [], closed: false, error: null };

      ws.onmessage = (ev) => {
        const data = String(ev.data);
        if (data === 'o') {
          state.opened = true;
          return;
        }
        if (data === 'h') return;
        if (data.startsWith('c')) {
          state.closed = true;
          try {
            state.error = JSON.parse(data.slice(1))[1] || '控制台连接被关闭';
          } catch {
            state.error = '控制台连接被关闭';
          }
          return;
        }
        if (!data.startsWith('a')) return;
        let arr;
        try {
          arr = JSON.parse(data.slice(1));
        } catch {
          return;
        }
        for (const part of arr) {
          const idx = part.indexOf('\n\n');
          if (idx < 0) continue;
          const head = part.slice(0, idx);
          const body = part.slice(idx + 2).replace(/\u0000/g, '');
          const lines = head.split('\n');
          if (lines[0] === 'CONNECTED') state.connected = true;
          if (lines[0] === 'ERROR') state.error = body;
          if (lines[0] !== 'MESSAGE') continue;
          let destination = '';
          for (let i = 1; i < lines.length; i++) {
            const p = lines[i].indexOf(':');
            if (p > 0 && lines[i].slice(0, p).trim() === 'destination') {
              destination = lines[i].slice(p + 1).trim();
            }
          }
          if (!destination || destination.includes('/console/message/')) {
            state.chunks.push(body);
          }
        }
      };

      try {
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = () => reject(new Error('控制台连接失败'));
          setTimeout(() => reject(new Error('控制台连接超时')), 8000);
        });
        for (let i = 0; i < 40 && !state.opened; i++) await sleep(100);
        ws.send(
          JSON.stringify([
            frame('CONNECT', { 'accept-version': '1.2', 'heart-beat': '30000,30000' }),
          ])
        );
        for (let i = 0; i < 60 && !state.connected; i++) await sleep(100);
        if (!state.connected) throw new Error('控制台协议未连接');

        const send = (text) => ws.send(JSON.stringify([text]));
        const base = `/console`;
        send(
          frame('SUBSCRIBE', {
            id: 'sub-msg-' + deviceId,
            destination: `/user/topic${base}/message/${sandboxId}/${deviceId}`,
          })
        );
        send(
          frame('SUBSCRIBE', {
            id: 'sub-hb-' + deviceId,
            destination: `/user/topic${base}/heartbeat/${sandboxId}/${deviceId}`,
          })
        );
        // 先释放服务端可能残留的旧控制台连接，否则新连接收不到输出
        send(frame('SEND', { destination: `/app${base}/close/${sandboxId}/${deviceId}` }, ''));
        await sleep(350);
        send(frame('SEND', { destination: `/app${base}/connect/${sandboxId}/${deviceId}` }, ''));

        const heartbeat = setInterval(() => {
          try {
            send(frame('SEND', { destination: `/app${base}/heartbeat/${sandboxId}/${deviceId}` }, ''));
          } catch {
            /* ignore */
          }
        }, 30000);

        return {
          state,
          text: () => state.chunks.join(''),
          sendBody: (body) => {
            if (state.closed) throw new Error(state.error || '控制台连接已关闭');
            send(frame('SEND', { destination: `/app${base}/message/${sandboxId}/${deviceId}` }, body));
          },
          close: () => {
            clearInterval(heartbeat);
            try {
              send(frame('SEND', { destination: `/app${base}/close/${sandboxId}/${deviceId}` }, ''));
              send(frame('DISCONNECT', {}));
              ws.close();
            } catch {
              /* ignore */
            }
          },
        };
      } catch (e) {
        lastError = e;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        await sleep(2000);
      }
    }
    throw lastError || new Error('无法打开设备控制台');
  }

  async function waitReady(session, password, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let actions = 0;
    let lastLen = -1;
    let lastChangeAt = Date.now();
    let lastProbeAt = 0;
    let probes = 0;

    while (Date.now() < deadline) {
      const all = clean(session.text());
      const tail = all.slice(-1000).trimEnd();
      const atEnd = tail;
      if (all.length !== lastLen) {
        lastLen = all.length;
        lastChangeAt = Date.now();
      }

      if (session.state && session.state.closed) {
        return {
          ready: false,
          tail,
          log: session.log,
          error: (session.state && session.state.error) || '控制台连接已关闭',
        };
      }
      if (session.state && session.state.error) {
        return { ready: false, tail, log: session.log, error: session.state.error };
      }

      // 已经出现提示符时优先判定就绪，避免旧启动文案干扰
      if (PROMPT.test(atEnd)) {
        session.log.push('提示符就绪');
        return { ready: true, tail, log: session.log };
      }
      if (/Login authentication failed|Error:.*(authentication|password)/i.test(atEnd)) {
        return { ready: false, tail, log: session.log, error: '控制台登录失败' };
      }
      if (/The device is not available yet/i.test(atEnd)) {
        session.log.push('设备尚未就绪，继续等待');
        await sleep(1500);
        continue;
      }
      if (/Confirm Password:\s*$/.test(atEnd)) {
        if (actions >= 12) break;
        session.log.push('确认登录密码');
        session.sendBody(password + '\r');
        actions += 1;
        await sleep(2500);
        continue;
      }
      if (/Enter Password:\s*$/.test(atEnd)) {
        if (actions >= 12) break;
        session.log.push('设置登录密码');
        session.sendBody(password + '\r');
        actions += 1;
        await sleep(2000);
        continue;
      }
      if (/Username:\s*$/.test(atEnd)) {
        if (actions >= 12) break;
        session.log.push('登录用户名');
        session.sendBody('admin\r');
        actions += 1;
        await sleep(900);
        continue;
      }
      if (/(^|\n)\s*Password:\s*$/.test(atEnd) && !/Enter Password|Confirm Password/.test(atEnd)) {
        if (actions >= 12) break;
        session.log.push('登录密码');
        session.sendBody(password + '\r');
        actions += 1;
        await sleep(2000);
        continue;
      }
      // 重连时设备只打印横幅，不主动输出提示符，需要按一次回车触发
      if (
        /(eNSP can only be used for practice|This device is an emulator|Please read the feature list carefully)/i.test(atEnd) &&
        /-{20,}\s*$/.test(atEnd)
      ) {
        if (actions >= 30) break;
        session.log.push('控制台横幅后按回车');
        session.sendBody('\r');
        actions += 1;
        await sleep(1500);
        continue;
      }
      if (
        /(^|\n)\s*Please\s+press\s+"?ENTER"?\.?\s*$/i.test(atEnd) ||
        /(^|\n)\s*Please\s+press\s+"?Enter"?\s+to start command line\s*$/i.test(atEnd)
      ) {
        if (actions >= 30) break;
        session.log.push('按回车');
        session.sendBody('\r');
        actions += 1;
        await sleep(1500);
        continue;
      }
      // 长时间无新输出时主动按回车，促使设备重绘当前提示符
      if (
        Date.now() - lastChangeAt > 3000 &&
        Date.now() - lastProbeAt > 3000 &&
        probes < 5 &&
        actions < 30
      ) {
        session.log.push('无输出，探测回车');
        session.sendBody('\r');
        probes += 1;
        lastProbeAt = Date.now();
        await sleep(1000);
        continue;
      }
      await sleep(400);
    }

    return {
      ready: false,
      tail: clean(session.text()).slice(-1000).trimEnd(),
      log: session.log,
      error: '等待控制台就绪超时',
    };
  }

  async function openImpl({ sandboxId, deviceId, password = 'Admin@123', timeoutMs = 0 }) {
    const k = key(sandboxId, deviceId);
    const existing = sessions.get(k);
    dbg('open-check', `${k} sid=${existing && existing.sid} len=${existing ? existing.text().length : -1}`);
    if (existing && existing.text().length === 0 && !(existing.state && existing.state.closed)) {
      // 本地有会话但没有任何输出，通常是对端还挂着旧连接，直接重建
      try {
        existing.close();
      } catch {
        /* ignore */
      }
      sessions.delete(k);
      await sleep(350);
    }
    const current = sessions.get(k);
    if (current) {
      if (timeoutMs > 0) {
        const w = await waitReady(current, password, timeoutMs);
        current.cursor = current.text().length;
        return {
          ok: true,
          reused: true,
          ready: w.ready,
          log: current.log,
          tail: w.tail,
          error: w.ready ? undefined : w.error,
        };
      }
      return {
        ok: true,
        reused: true,
        connected: !(current.state && current.state.closed),
        tail: clean(current.text()).slice(-400),
        driver: driverId,
        sessions: sessions.size,
        debug: debug.slice(-20),
      };
    }

    try {
      const conn = await connect(sandboxId, deviceId);
      const session = { ...conn, sandboxId, deviceId, log: [], cursor: conn.text().length };
      session.sid = ++sidSeq;
      dbg('open-new', `${k} sid=${session.sid} len=${session.text().length}`);
      sessions.set(k, session);
      if (timeoutMs > 0) {
        const w = await waitReady(session, password, timeoutMs);
        session.cursor = session.text().length;
        return {
          ok: true,
          reused: false,
          ready: w.ready,
          log: session.log,
          tail: w.tail,
          error: w.ready ? undefined : w.error,
        };
      }
      return {
        ok: true,
        reused: false,
        connected: true,
        tail: clean(session.text()).slice(-400),
        driver: driverId,
        sessions: sessions.size,
        debug: debug.slice(-20),
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async function waitImpl({ sandboxId, deviceId, password = 'Admin@123', timeoutMs = 50000 }) {
    const k = key(sandboxId, deviceId);
    let session = sessions.get(k);
    if (!session) {
      const opened = await openImpl({ sandboxId, deviceId, password, timeoutMs: 0 });
      if (!opened.ok) return opened;
      session = sessions.get(k);
    }
    if (!session) return { ok: false, error: '控制台会话创建失败' };

    const w = await waitReady(session, password, timeoutMs);
    session.cursor = session.text().length;
    dbg('wait-end', `sid=${session.sid} len=${session.text().length} ready=${w.ready}`);
    return {
      ok: true,
      ready: w.ready,
      log: w.log,
      tail: w.tail,
      error: w.ready ? undefined : w.error,
      driver: driverId,
      sessions: sessions.size,
      debug: debug.slice(-20),
    };
  }

  self.enspConsole = {
    // 打开控制台会话；timeoutMs>0 时顺便等待提示符
    async open({ sandboxId, deviceId, password = 'Admin@123', timeoutMs = 0 }) {
      return openImpl({ sandboxId, deviceId, password, timeoutMs });
    },

    // 等待控制台可用，自动处理回车、首次密码、登录和启动提示
    async wait({ sandboxId, deviceId, password = 'Admin@123', timeoutMs = 50000 }) {
      return waitImpl({ sandboxId, deviceId, password, timeoutMs });
    },

    // 发送原始终端输入；enter=true 时自动补回车
    async write({ sandboxId, deviceId, data = '', enter = true }) {
      const session = sessions.get(key(sandboxId, deviceId));
      if (!session) return { ok: false, error: '控制台未打开，请先 console_open' };
      dbg('write', `sid=${session.sid} data=${JSON.stringify(String(data)).slice(0, 40)}`);
      const body = enter && !String(data).endsWith('\r') ? String(data) + '\r' : String(data);
      try {
        session.sendBody(body);
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
      return { ok: true, sent: body };
    },

    // 读取自上次读取以来的新输出
    async read({ sandboxId, deviceId, reset = false }) {
      const session = sessions.get(key(sandboxId, deviceId));
      if (!session) return { ok: false, error: '控制台未打开，请先 console_open' };
      if (reset) session.cursor = session.text().length;
      const raw = session.text();
      dbg('read', `sid=${session.sid} len=${raw.length}`);
      const output = clean(raw.slice(session.cursor));
      session.cursor = raw.length;
      return { ok: true, output: output.slice(-8000) };
    },

    // 执行命令并等待回显稳定；自动处理 ---- More ----
    async execute({ sandboxId, deviceId, commands = [], timeoutMs = 20000, auto_confirm = true, confirm_answer = 'Y' }) {
      const session = sessions.get(key(sandboxId, deviceId));
      if (!session) return { ok: false, error: '控制台未打开，请先 console_open' };
      if (session.state && session.state.closed) {
        return { ok: false, error: session.state.error || '控制台连接已关闭' };
      }

      const deadline = Date.now() + timeoutMs;
      let pages = 0;
      const autoConfirm = auto_confirm !== false;
      const confirmAnswer = String(confirm_answer || 'Y');
      let answered = 0;
      const perCommand = commands.length === 1 ? timeoutMs : Math.min(timeoutMs, 15000);

      // 清除可能残留的分页器，再把终端对齐到稳定提示符
      try {
        session.sendBody('\x03');
        await sleep(200);
        session.sendBody('\r');
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
      await sleep(1000);
      const start = session.text().length;

      for (const command of commands) {
        if (Date.now() >= deadline) break;
        const cmdStart = session.text().length;
        try {
          session.sendBody(String(command) + '\r');
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
        const cmdDeadline = Math.min(deadline, Date.now() + perCommand);
        let sentPages = 0;
        let confirmed = 0;
        while (Date.now() < cmdDeadline) {
          const raw = session.text().slice(cmdStart);
          const seenPages = (raw.match(/----\s*More\s*----/g) || []).length;
          if (seenPages > sentPages) {
            try {
              session.sendBody(' ');
            } catch (e) {
              return { ok: false, error: String((e && e.message) || e) };
            }
            sentPages += 1;
            pages += 1;
            await sleep(350);
            continue;
          }
          const view = clean(raw).trimEnd();
          if (view && autoConfirm && CONFIRM_PROMPT.test(view) && confirmed < 8) {
            try {
              session.sendBody(confirmAnswer + '\r');
            } catch (e) {
              return { ok: false, error: String((e && e.message) || e) };
            }
            confirmed += 1;
            answered += 1;
            await sleep(500);
            continue;
          }
          if (view && PROMPT.test(view)) break;
          await sleep(200);
        }
        // 给终端留出处理上一条命令尾部的时间，避免下一条首字符被吞
        await sleep(300);
      }

      const output = clean(session.text().slice(start));
      session.cursor = session.text().length;
      return { ok: true, output: output.slice(-12000), log: session.log, pages, answered };
    },

    async diag() {
      const list = [];
      for (const [k, s] of sessions) {
        const st = s.state || {};
        list.push({
          key: k,
          sid: s.sid,
          sandboxId: s.sandboxId,
          deviceId: s.deviceId,
          wsState: st.ws
            ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][st.ws.readyState] || String(st.ws.readyState)
            : 'none',
          connected: Boolean(st.connected),
          closed: Boolean(st.closed),
          textLength: s.text().length,
          cursor: s.cursor,
          log: s.log.slice(-5),
        });
      }
      return {
        ok: true,
        driver: driverId,
        page: location.href,
        title: document.title,
        summary: {
          sessions: list.length,
          open: list.filter((x) => x.wsState === 'OPEN').length,
          closed: list.filter((x) => x.closed).length,
        },
        sessions: list,
        debug: debug.slice(-30),
      };
    },

    async close({ sandboxId, deviceId }) {
      const k = key(sandboxId, deviceId);
      const session = sessions.get(k);
      if (!session) return { ok: true, closed: false };
      session.close();
      sessions.delete(k);
      return { ok: true, closed: true };
    },
  };
})();
