// 页面主世界 WebSocket 计数器：区分页面自身连接与 MCP 控制台连接
(() => {
  if (window.__enspWsMonitor) return;
  const Native = window.WebSocket;
  if (!Native) return;
  const stats = { total: 0, records: [] };

  function Wrapped(url, protocols) {
    const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    const rec = {
      id: ++stats.total,
      url: String(url),
      state: 'connecting',
      createdAt: Date.now(),
    };
    stats.records.push(rec);
    if (stats.records.length > 200) stats.records.shift();
    ws.addEventListener('open', () => {
      rec.state = 'open';
      rec.openedAt = Date.now();
    });
    ws.addEventListener('close', (e) => {
      rec.state = 'closed';
      rec.code = e.code;
      rec.closedAt = Date.now();
    });
    ws.addEventListener('error', () => {
      rec.state = 'error';
      rec.errorAt = Date.now();
    });
    return ws;
  }

  Wrapped.prototype = Native.prototype;
  for (const name of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    Object.defineProperty(Wrapped, name, { value: Native[name] });
  }
  Object.setPrototypeOf(Wrapped, Native);
  window.WebSocket = Wrapped;

  window.__enspWsMonitor = {
    snapshot() {
      const byState = (state) => stats.records.filter((r) => r.state === state).length;
      return {
        total: stats.total,
        open: byState('open'),
        connecting: byState('connecting'),
        closed: byState('closed'),
        error: byState('error'),
        active: stats.records
          .filter((r) => r.state === 'open' || r.state === 'connecting')
          .map((r) => ({ ...r })),
        recent: stats.records.slice(-20).map((r) => ({ ...r })),
      };
    },
  };
})();
