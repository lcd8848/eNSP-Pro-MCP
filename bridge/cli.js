// 命令行验证工具：不经过 MCP，直接打本地桥，确认「页面 → 插件 → 桥」链路
const PORT = Number(process.env.ENSP_BRIDGE_PORT || 8790);
const BASE = `http://127.0.0.1:${PORT}`;

async function call(method, path, body) {
  const resp = await fetch(`${BASE}/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, path, body }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
  if (!data.ok) throw new Error(`HTTP ${data.status} ${data.text || ''}`.trim());
  if (!data.json) throw new Error('返回不是 JSON：' + (data.text || '').slice(0, 300));
  return data.json;
}

async function health() {
  const resp = await fetch(`${BASE}/health`);
  console.log(JSON.stringify(await resp.json(), null, 2));
}

async function sandboxes() {
  const data = await call('POST', '/service/ensp/sandbox/getByPage', {
    currentPage: 1,
    pageSize: 50,
    projectId: 1,
  });
  const list = Array.isArray(data.data) ? data.data : [];
  if (!list.length) {
    console.log('没有沙箱');
    return;
  }
  for (const s of list) {
    console.log(
      `${s.id}\t${s.name}\tstatus=${s.status}\t设备=${(s.devices || []).length}\t连线=${(s.links || []).length}`
    );
  }
}

async function sandbox(id) {
  const data = await call('GET', `/service/ensp/sandbox/getOneSandbox?sandboxId=${id}`);
  const sb = data.data || {};
  console.log(`沙箱 ${sb.id} ${sb.name} status=${sb.status}`);
  console.log(`设备 ${(sb.devices || []).length} 台，连线 ${(sb.links || []).length} 条`);
  for (const d of sb.devices || []) {
    console.log(`  [设备] id=${d.id} name=${d.name} status=${d.status}`);
  }
  for (const l of sb.links || []) {
    console.log(`  [连线] id=${l.id} ${l.leftDeviceId}:${l.leftIfId} -> ${l.rightDeviceId}:${l.rightIfId}`);
  }
}

async function types(id) {
  const data = await call('GET', `/service/ensp/device-type/all?sandboxId=${id}`);
  const devices = (data.data && data.data.devices) || [];
  for (const d of devices) {
    console.log(`${d.id}\t${d.name}\t${d.displayName}\t${d.superDeviceType?.name || ''}\tavailable=${d.available}`);
  }
}

async function consoleExec(action, devId, extra) {
  const params = { action, sandboxId: 3, deviceId: Number(devId) };
  if (action === 'open') params.password = extra || 'Admin@123';
  if (action === 'wait') {
    params.password = extra || 'Admin@123';
    params.timeoutMs = 50000;
  }
  if (action === 'execute') params.commands = extra || ['display version'];
  if (action === 'write') params.data = extra || '';
  const started = Date.now();
  const resp = await fetch(`${BASE}/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'console', params }),
  });
  const data = await resp.json();
  console.log('elapsed=' + (Date.now() - started) + 'ms');
  console.log(JSON.stringify(data, null, 2));
}

async function raw(method, path, json) {
  const data = await call(method, path, json ? JSON.parse(json) : undefined);
  console.log(JSON.stringify(data, null, 2));
}

const [cmd, ...args] = process.argv.slice(2);

try {
  if (cmd === 'health') await health();
  else if (cmd === 'sandboxes') await sandboxes();
  else if (cmd === 'sandbox') await sandbox(args[0] || 3);
  else if (cmd === 'types') await types(args[0] || 3);
  else if (cmd === 'console') await consoleExec(args[0] || 'open', args[1] || 13, args[2]);
  else if (cmd === 'call') await raw(args[0] || 'GET', args[1], args[2]);
  else {
    console.log('用法：');
    console.log('  node bridge/cli.js health');
    console.log('  node bridge/cli.js sandboxes');
    console.log('  node bridge/cli.js sandbox <sandboxId>');
    console.log('  node bridge/cli.js types <sandboxId>');
    console.log('  node bridge/cli.js console <deviceId> <command...>');
    console.log('  node bridge/cli.js call <METHOD> <path> [jsonBody]');
  }
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
}
