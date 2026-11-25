// 本地桥：接收 MCP 的调用请求，转发给已连接插件的 content script，再把结果带回来
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.ENSP_BRIDGE_PORT || 8790);
const TIMEOUT_MS = Number(process.env.ENSP_BRIDGE_TIMEOUT || 120000);

let extension = null;
const extensionClients = new Set();
const pending = new Map();

function sendJson(res, status, data) {
  const text = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 4 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function callExtension({ kind = 'api', method = 'GET', path, body, params }) {
  return new Promise((resolve, reject) => {
    if (!extension || extension.readyState !== 1) {
      reject(new Error('插件未连接：请打开并登录 eNSP 页面，确认扩展已启用'));
      return;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('插件响应超时'));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    extension.send(JSON.stringify({ type: 'call', id, kind, method, path, body, params }));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, extension: Boolean(extension) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/call') {
    try {
      const payload = JSON.parse((await readBody(req)) || '{}');
      const result = await callExtension(payload);
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 502, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      extensionClients.add(ws);
      extension = ws;
      console.log('[bridge] 插件已连接');
      return;
    }
    if (msg.type === 'ping') {
      try {
        ws.send(JSON.stringify({ type: 'pong' }));
      } catch {
        /* ignore */
      }
      return;
    }
    if (msg.type === 'result') {
      const item = pending.get(msg.id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(msg.id);
      item.resolve(msg);
    }
  });

  ws.on('close', () => {
    extensionClients.delete(ws);
    if (extension === ws) {
      extension = null;
      for (const client of extensionClients) {
        if (client.readyState === 1) {
          extension = client;
          break;
        }
      }
      if (!extension) console.log('[bridge] 插件已断开');
    }
  });
});

setInterval(() => {
  if (extension && extension.readyState === 1) extension.ping();
}, 20000);

// 开发模式热重载：extension 目录文件一变更，就通知插件自动重载并刷新页面
// 开关：ENSP_HOT_RELOAD=0 或启动加 --no-hot 时关闭（真机做长时间实验时建议关闭，避免保存即刷新页面）
const HOT_RELOAD = process.env.ENSP_HOT_RELOAD !== '0' && !process.argv.includes('--no-hot');
const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension');
let reloadTimer = null;

function watchExtension() {
  if (!HOT_RELOAD) {
    console.log('[bridge] 热重载已关闭，改动插件后需手动刷新页面（恢复：去掉 --no-hot / ENSP_HOT_RELOAD=0）');
    return;
  }
  try {
    fs.watch(EXT_DIR, { persistent: true }, (_event, filename) => {
      if (!filename || filename.startsWith('.')) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        console.log(`[bridge] 检测到插件变更：${filename}，通知扩展重载`);
        if (extension && extension.readyState === 1) {
          extension.send(JSON.stringify({ type: 'reload' }));
        } else {
          console.log('[bridge] 扩展未连接，跳过本次重载通知');
        }
      }, 400);
    });
    console.log('[bridge] 已监听插件目录，改动保存后自动重载：' + EXT_DIR);
  } catch (e) {
    console.warn('[bridge] 插件目录监听失败：' + e.message);
  }
}

watchExtension();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[bridge] 监听 http://127.0.0.1:${PORT}  ws://127.0.0.1:${PORT}/ws`);
});
