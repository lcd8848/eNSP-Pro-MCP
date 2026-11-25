// 让页面把自己的接口能力暴露给本地桥，复用页面已有的登录态
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'ensp-console') {
    (async () => {
      try {
        const { action, ...params } = msg.params || {};
        const handler = self.enspConsole && self.enspConsole[action];
        if (!handler) {
          sendResponse({ ok: false, error: '未知控制台操作: ' + action });
          return;
        }
        const result = await handler(params);
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (!msg || msg.type !== 'ensp-api') return undefined;

  (async () => {
    try {
      const csrf = (document.cookie.match(/csrfToken=([^;]+)/) || [])[1] || '';
      const headers = { 'x-csrf-token': csrf };
      if (msg.body !== undefined && msg.body !== null) {
        headers['Content-Type'] = 'application/json';
      }
      const resp = await fetch(msg.path, {
        method: msg.method || 'GET',
        credentials: 'include',
        headers,
        body: msg.body === undefined || msg.body === null ? undefined : JSON.stringify(msg.body),
      });
      const text = await resp.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      sendResponse({
        ok: resp.ok,
        status: resp.status,
        json,
        text: json ? undefined : text.slice(0, 2000),
      });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();

  return true;
});
