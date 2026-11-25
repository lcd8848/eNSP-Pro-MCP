// 全型号端口回归：每种可用型号各建一台（不启动），比对端口后清理。
// 用法：node mcp/coverage.js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'coverage', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['mcp/server.js'],
  cwd: process.cwd(),
});
await client.connect(transport);

async function tool(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content || []).map((c) => c.text || '').join('\n');
  if (r.isError) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const sameSet = (a, b) => {
  const x = [...a].sort().join(',');
  const y = [...b].sort().join(',');
  return x === y;
};

const sandbox = await tool('create_sandbox', {
  name: `cov-${Date.now() % 100000}`,
  max_vms: 20,
  keep_time: 0,
});
const sandboxId = sandbox.sandbox.id;
const createdNames = [];
const failures = [];
const rows = [];

try {
  const types = (await tool('get_device_types', { sandbox_id: sandboxId })).filter(
    (t) => t.available
  );
  console.log(`沙箱 ${sandboxId}，可用型号 ${types.length} 个`);

  for (let i = 0; i < types.length; i += 1) {
    const t = types[i];
    const name = `COV-${i + 1}`;
    try {
      const r = await tool('create_devices', {
        sandbox_id: sandboxId,
        devices: [{ type: t.name, name, x: -0.4 + (i % 5) * 0.2, y: 0.3 - Math.floor(i / 5) * 0.2 }],
      });
      const dev = r.devices.find((d) => d.name === name);
      createdNames.push(name);
      const ok = dev && sameSet(dev.ports, t.ports);
      rows.push({ type: t.displayName, ports: (dev && dev.ports.length) || 0, ok });
      if (!ok) {
        failures.push(
          `${t.displayName} 端口不一致：实际=${(dev && dev.ports.join(',')) || '无'} 期望=${t.ports.join(',')}`
        );
      }
    } catch (e) {
      rows.push({ type: t.displayName, ports: 0, ok: false });
      failures.push(`${t.displayName} 创建失败：${e.message.split('\n')[0]}`);
    }
  }

  for (const r of rows) {
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.type.padEnd(14)} ports=${r.ports}`);
  }
} finally {
  if (createdNames.length) {
    try {
      await tool('delete_devices', { sandbox_id: sandboxId, device_names: createdNames });
    } catch (e) {
      failures.push(`清理设备失败：${e.message.split('\n')[0]}`);
    }
  }
  try {
    await tool('delete_sandbox', { sandbox_ids: [sandboxId] });
  } catch (e) {
    failures.push(`删除沙箱失败：${e.message.split('\n')[0]}`);
  }
  await client.close();
}

if (failures.length) {
  console.log('\n===== COVERAGE FAILED =====');
  for (const f of failures) console.log('- ' + f);
  process.exit(1);
}
console.log('\n===== COVERAGE PASSED =====');
