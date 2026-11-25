// 插件后台：主动连本地桥（浏览器不能监听端口），把调用转发给页面里的 content script
const BRIDGE_URL = 'ws://127.0.0.1:8790/ws';
const PAGE_MATCH = 'https://10.10.10.130:8443/*';

let socket = null;
let retry = 0;
let keepalive = null;
let pinnedTabId = null;

chrome.tabs.onRemoved.addListener((tabId) => {
  if (pinnedTabId === tabId) pinnedTabId = null;
});

function startKeepalive() {
  clearInterval(keepalive);
  keepalive = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'ping' }));
      } catch {
        /* ignore */
      }
    }
  }, 20000);
}

function scheduleReconnect() {
  const delay = Math.min(10000, 500 * 2 ** retry);
  retry += 1;
  setTimeout(connect, delay);
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  socket = new WebSocket(BRIDGE_URL);

  socket.addEventListener('open', () => {
    retry = 0;
    console.log('[ensp-webmcp] 已连接本地桥');
    try {
      socket.send(JSON.stringify({ type: 'hello', role: 'extension', version: 2 }));
    } catch {
      /* ignore */
    }
    chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
    chrome.action.setBadgeText({ text: 'ON' });
    startKeepalive();
  });

  socket.addEventListener('message', (event) => {
    let msg = null;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg && msg.type === 'call') void handleCall(msg);
    if (msg && msg.type === 'reload') void hotReload();
  });

  socket.addEventListener('close', () => {
    socket = null;
    clearInterval(keepalive);
    chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
    chrome.action.setBadgeText({ text: 'OFF' });
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  });
}

async function handleCall(msg) {
  let reply;
  try {
    const tabs = await chrome.tabs.query({ url: PAGE_MATCH });
    if (!tabs.length) throw new Error('请先打开并登录 eNSP 页面');
    const ordered = [];
    const pinned = pinnedTabId ? tabs.find((t) => t.id === pinnedTabId) : null;
    if (pinned) ordered.push(pinned);
    ordered.push(
      ...tabs
        .filter((t) => t.id !== pinnedTabId)
        .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)))
    );
    const payload =
      msg.kind === 'console'
        ? { type: 'ensp-console', params: msg.params }
        : { type: 'ensp-api', method: msg.method, path: msg.path, body: msg.body };
    let lastError = null;
    for (const tab of ordered) {
      try {
        const res = await chrome.tabs.sendMessage(tab.id, payload);
        if (res) {
          reply = res;
          pinnedTabId = tab.id;
          break;
        }
        lastError = new Error('页面没有响应，请刷新 eNSP 页面后重试');
      } catch (e) {
        lastError = e;
      }
    }
    if (!reply) throw lastError || new Error('页面没有响应，请刷新 eNSP 页面后重试');

    if (msg.kind === 'console' && msg.params && msg.params.action === 'diag' && pinnedTabId) {
      try {
        const [page] = await chrome.scripting.executeScript({
          target: { tabId: pinnedTabId },
          world: 'MAIN',
          func: () => (window.__enspWsMonitor ? window.__enspWsMonitor.snapshot() : null),
        });
        reply.pageWs = page ? page.result : null;
        if (!reply.pageWs) {
          reply.pageWsNote = '页面尚未加载 WS 监控脚本，请刷新一次 eNSP 页面';
        }
      } catch (e) {
        reply.pageWsError = String((e && e.message) || e);
      }
      const allTabs = await chrome.tabs.query({ url: PAGE_MATCH });
      reply.pinnedTab = pinnedTabId;
      reply.tabs = allTabs.map((t) => ({
        id: t.id,
        active: Boolean(t.active),
        title: t.title,
        url: t.url,
      }));
    }
  } catch (e) {
    reply = { ok: false, error: String((e && e.message) || e) };
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'result', id: msg.id, ...reply }));
  }
}

// 开发模式：本地桥检测到代码变更后通知重载，重载完自动刷新 eNSP 页面
async function hotReload() {
  try {
    await chrome.storage.local.set({ enspHotReload: true });
  } catch (e) {
    /* storage 不可用时忽略，仍执行重载 */
  }
  chrome.runtime.reload();
}

(async () => {
  try {
    const { enspHotReload } = await chrome.storage.local.get('enspHotReload');
    if (!enspHotReload) return;
    await chrome.storage.local.remove('enspHotReload');
    const tabs = await chrome.tabs.query({ url: PAGE_MATCH });
    for (const t of tabs) {
      if (!t.id) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: t.id },
          world: 'MAIN',
          files: ['ws-monitor.js'],
        });
        await chrome.scripting.executeScript({
          target: { tabId: t.id },
          files: ['console-driver.js', 'content.js'],
        });
        console.log('[ensp-webmcp] 已热注入页面脚本');
      } catch (e) {
        console.warn('[ensp-webmcp] 热注入失败，改为刷新页面：' + ((e && e.message) || e));
        try {
          await chrome.tabs.reload(t.id);
        } catch {
          /* ignore */
        }
      }
    }
  } catch (e) {
    console.warn('[ensp-webmcp] 热重载后刷新页面失败：' + ((e && e.message) || e));
  }
})();

connect();
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// service worker 会被浏览器休眠，用闹钟定时唤醒并补连
chrome.alarms.create('ensp-bridge-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (!socket || socket.readyState !== WebSocket.OPEN) connect();
});
