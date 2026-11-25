// 冒烟测试：以 MCP 客户端身份连上本地 MCP 服务端。
// 用法：
//   node mcp/selftest.js read|create|start|lifecycle|console|cleanup   需要浏览器插件已连接
//   node mcp/selftest.js mock                                        使用内置模拟桥，不需要浏览器
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const mode = process.argv[2] || 'read';

const scenarios = {
  read: [
    ['get_sandboxes', {}],
    ['get_sandbox', { sandbox_id: 3 }],
  ],
  create: [
    [
      'create_devices',
      {
        sandbox_id: 3,
        devices: [
          { type: 'AR', name: 'AR-1', x: -0.35, y: -0.15 },
          { type: 'AR', name: 'AR-2', x: -0.05, y: -0.15 },
        ],
      },
    ],
    [
      'create_link',
      {
        sandbox_id: 3,
        left_device: 'AR-1',
        left_port: 'GE0/0/0',
        right_device: 'AR-2',
        right_port: 'GE0/0/0',
      },
    ],
  ],
  start: [['start_devices', { sandbox_id: 3, device_names: ['AR-1', 'AR-2'] }]],
  lifecycle: [
    ['get_device_status', { sandbox_id: 3 }],
    ['wait_devices_ready', { sandbox_id: 3, timeout_seconds: 30 }],
  ],
  cleanup: [['delete_devices', { sandbox_id: 3, device_names: ['AR-1', 'AR-2'] }]],
  console: [
    ['console_open', { sandbox_id: 3, device_name: 'AR-1' }],
    ['console_execute', { sandbox_id: 3, device_name: 'AR-1', commands: ['display version'] }],
    ['console_read', { sandbox_id: 3, device_name: 'AR-1' }],
    ['console_close', { sandbox_id: 3, device_name: 'AR-1' }],
  ],
  guard: [
    [
      'create_devices',
      {
        sandbox_id: 1,
        devices: [
          { type: 'AR', name: 'G1' },
          { type: 'AR', name: 'g1' },
        ],
      },
    ],
    [
      'create_devices',
      {
        sandbox_id: 1,
        devices: [
          { type: 'Router', name: 'G1' },
          { type: 'AR', name: 'G2' },
        ],
      },
    ],
    [
      'create_link',
      {
        sandbox_id: 1,
        left_device: 'G1',
        left_port: 'ge 0/0/0',
        right_device: 'G2',
        right_port: 'GE0/0/0',
      },
    ],
    [
      'create_link',
      {
        sandbox_id: 1,
        left_device: 'G1',
        left_port: 'GE0/0/0',
        right_device: 'G2',
        right_port: 'GE0/0/1',
      },
    ],
    [
      'create_link',
      {
        sandbox_id: 1,
        left_device: 'G1',
        left_port: 'MEth0/0/0',
        right_device: 'G2',
        right_port: 'MEth0/0/0',
      },
    ],
    [
      'validate_topology',
      {
        sandbox_id: 1,
        devices: [{ type: 'S5700', name: 'G3' }],
        links: [{ left_device: 'G1', left_port: 'GE0/0/1', right_device: 'G3', right_port: 'GE1/0/1' }],
      },
    ],
    [
      'validate_topology',
      {
        sandbox_id: 1,
        links: [{ left_device: 'G1', left_port: 'GE0/0/0', right_device: 'G2', right_port: 'GE0/0/1' }],
      },
    ],
    ['delete_devices', { sandbox_id: 1, device_names: ['G1', 'G2'] }],
  ],
  mock: [
    ['get_sandboxes', {}],
    ['create_sandbox', { name: 'mock-lab', max_vms: 4, keep_time: 60 }],
    [
      'create_devices',
      {
        sandbox_id: 1,
        devices: [
          { type: 'AR', name: 'AR-1', x: -0.3, y: -0.1 },
          { type: 'AR', name: 'AR-2', x: 0.1, y: -0.1 },
        ],
      },
    ],
    [
      'create_link',
      {
        sandbox_id: 1,
        left_device: 'AR-1',
        left_port: 'GE0/0/0',
        right_device: 'AR-2',
        right_port: 'GE0/0/0',
      },
    ],
    ['get_device_status', { sandbox_id: 1 }],
    ['move_device', { sandbox_id: 1, device_name: 'AR-1', x: -0.4, y: 0.2 }],
    ['start_devices', { sandbox_id: 1, device_names: ['AR-1', 'AR-2'] }],
    ['wait_devices_ready', { sandbox_id: 1, timeout_seconds: 10, interval_seconds: 2 }],
    ['stop_devices', { sandbox_id: 1, device_names: ['AR-1'] }],
    ['reboot_devices', { sandbox_id: 1, device_names: ['AR-1'] }],
    ['delete_link', { sandbox_id: 1, left_device: 'AR-1', left_port: 'GE0/0/0', right_device: 'AR-2', right_port: 'GE0/0/0' }],
    ['delete_devices', { sandbox_id: 1, device_names: ['AR-1', 'AR-2'] }],
  ],
  // 拓扑标注（图元/文本）增删改查全链路
  graphics: [
    ['list_graphics', { sandbox_id: 1 }],
    [
      'add_graphics',
      {
        sandbox_id: 1,
        items: [
          { kind: 'rectangle', x: 0.3, y: 0.3, width: 200, height: 120, color: '#1e90ff' },
          { kind: 'ellipse', x: 0.6, y: 0.4, width: 160, height: 100 },
          { kind: 'line', x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2, board_style: 'dash' },
        ],
      },
    ],
    ['add_text', { sandbox_id: 1, x: 0.5, y: 0.5, content: 'CORE 区域' }],
    ['list_graphics', { sandbox_id: 1 }],
    ['update_graphic', { sandbox_id: 1, kind: 'rectangle', graphic_id: 1, x: 0.35, color: '#ff0000' }],
    ['update_text', { sandbox_id: 1, text_id: 1, content: '核心区', font_size: 18 }],
    ['list_graphics', { sandbox_id: 1 }],
    ['delete_graphics', { sandbox_id: 1, items: [{ kind: 'line', id: 3 }] }],
    ['delete_texts', { sandbox_id: 1, text_ids: [1] }],
    ['list_graphics', { sandbox_id: 1 }],
  ],
};

// ---------- 本地模拟桥：拦截 MCP 发出的请求，返回可控数据 ----------
function startMockBridge() {
  const log = [];
  const state = {
    sandbox: {
      id: 1,
      name: 'mock-lab',
      status: 1,
      devices: [],
      links: [],
      graphicsVOList: [],
      textBoxs: [],
    },
    nextDeviceId: 100,
    nextLinkId: 200,
    nextGraphicId: 1,
    nextTextId: 1,
  };
  const ok = (data) => ({ ok: true, status: 200, json: { code: 0, data } });

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const payload = JSON.parse(raw || '{}');
      const { method = 'GET', path, body, kind } = payload;
      const p = String(path || '').split('?')[0];
      log.push({ kind, method, path, body });
      let out = { ok: true, status: 200, json: { code: 0 } };

      if (kind === 'console') {
        out = { ok: true, console: true, output: 'mock-console-output' };
      } else if (path && p.startsWith('/service/ensp/sandbox/getOneSandbox')) {
        out = ok({ ...state.sandbox });
      } else if (p === '/service/ensp/sandbox/getByPage') {
        out = ok([{ id: 1, name: 'mock-lab', status: 1, devices: state.sandbox.devices, links: state.sandbox.links }]);
      } else if (p === '/service/ensp/sandbox/create') {
        out = ok({ id: 2, name: body.name, maxVms: body.maxVms, keepTime: body.keepTime });
      } else if (p === '/service/ensp/device-type/all') {
        out = ok({
          devices: [
            {
              id: 7,
              name: 'AR',
              displayName: 'AR',
              available: true,
              superDeviceType: { name: 'router' },
              ifAssembles: [
                {
                  id: 1,
                  ifNumber: 3,
                  ifPortStart: 0,
                  ifClassId: null,
                  ifSlotId: 0,
                  ifPicId: 0,
                  ifType: { id: 1, name: 'GE' },
                },
                {
                  id: 2,
                  ifNumber: 1,
                  ifPortStart: 0,
                  ifClassId: null,
                  ifSlotId: 0,
                  ifPicId: 0,
                  ifType: { id: 9, name: 'MEth' },
                },
              ],
            },
            {
              id: 8,
              name: 'S',
              displayName: 'S',
              available: true,
              superDeviceType: { name: 'switch' },
              ifAssembles: [
                {
                  id: 3,
                  ifNumber: 3,
                  ifPortStart: 1,
                  ifClassId: null,
                  ifSlotId: 1,
                  ifPicId: 0,
                  ifType: { id: 2, name: 'GE' },
                },
              ],
            },
          ],
        });
      } else if (p === '/service/ensp/device/batchCreate') {
        for (const d of body.devices) {
          const id = state.nextDeviceId++;
          state.sandbox.devices.push({
            ...d,
            id,
            status: 0,
            displayStatus: 11,
            deviceIfs: (d.deviceIfs || []).map((i, idx) => ({ ...i, id: id * 10 + idx })),
          });
        }
        out = ok(null);
      } else if (p === '/service/ensp/device/batchStart') {
        for (const d of state.sandbox.devices) if (body.deviceIds.includes(d.id)) d.status = 4;
        out = ok(null);
      } else if (p === '/service/ensp/device/batchStop') {
        for (const d of state.sandbox.devices) if (body.deviceIds.includes(d.id)) d.status = 0;
        out = ok(null);
      } else if (p === '/service/ensp/device/batchReboot') {
        for (const d of state.sandbox.devices) if (body.deviceIds.includes(d.id)) d.status = 1;
        out = ok(null);
      } else if (p === '/service/ensp/device/batchDelete') {
        state.sandbox.devices = state.sandbox.devices.filter((d) => !body.deviceIds.includes(d.id));
        state.sandbox.links = state.sandbox.links.filter(
          (l) => !body.deviceIds.includes(l.leftDeviceId) && !body.deviceIds.includes(l.rightDeviceId)
        );
        out = ok(null);
      } else if (p === '/service/ensp/device/modifyComponent') {
        for (const d of body.devices) {
          const cur = state.sandbox.devices.find((x) => x.id === d.id);
          if (cur && d.devicePosition) cur.devicePosition = d.devicePosition;
        }
        out = ok(null);
      } else if (p === '/service/ensp/link/create') {
        state.sandbox.links.push({ id: state.nextLinkId++, ...body, status: 1 });
        out = ok(null);
      } else if (p === '/service/ensp/link/deleteLink') {
        state.sandbox.links = state.sandbox.links.filter((l) => l.id !== body.linkId);
        out = ok(null);
      } else if (p === '/service/ensp/graphics/createGraphics') {
        const created = [];
        for (const g of body.graphics || []) {
          const item = { ...g, id: state.nextGraphicId++ };
          state.sandbox.graphicsVOList.push(item);
          created.push(item);
        }
        out = ok(created);
      } else if (p === '/service/ensp/graphics/updateGraphics') {
        for (const g of body.graphics || []) {
          const idx = state.sandbox.graphicsVOList.findIndex((x) => x.id === g.id && x.type === g.type);
          if (idx > -1) {
            const { nodeId, nodeType, ...rest } = g;
            state.sandbox.graphicsVOList.splice(idx, 1, { ...state.sandbox.graphicsVOList[idx], ...rest });
          }
        }
        out = ok(null);
      } else if (p === '/service/ensp/graphics/deleteGraphics') {
        const ids = new Set((body.graphicsVOs || []).map((v) => `${v.type}:${v.id}`));
        state.sandbox.graphicsVOList = state.sandbox.graphicsVOList.filter(
          (g) => !ids.has(`${g.type}:${g.id}`)
        );
        out = ok(null);
      } else if (p === '/service/ensp/textBox/createTextBox') {
        const t = { ...body, id: state.nextTextId++ };
        state.sandbox.textBoxs.push(t);
        out = ok(t);
      } else if (p === '/service/ensp/textBox/updateTextBox') {
        for (const t of body.textBoxes || []) {
          const idx = state.sandbox.textBoxs.findIndex((x) => x.id === t.id);
          if (idx > -1) {
            const { nodeId, ...rest } = t;
            state.sandbox.textBoxs.splice(idx, 1, { ...state.sandbox.textBoxs[idx], ...rest });
          }
        }
        out = ok(null);
      } else if (p === '/service/ensp/textBox/deleteTextBoxes') {
        const ids = new Set((body.textBoxIdVOList || []).map((v) => v.id));
        state.sandbox.textBoxs = state.sandbox.textBoxs.filter((t) => !ids.has(t.id));
        out = ok(null);
      }

      const text = JSON.stringify(out);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, server, log, state }));
  });
}

const failures = [];
const assert = (cond, msg) => {
  if (!cond) failures.push(msg);
};

let mock = null;
let env = process.env;
if (mode === 'mock' || mode === 'guard' || mode === 'graphics') {
  mock = await startMockBridge();
  env = { ...process.env, ENSP_BRIDGE_PORT: String(mock.port) };
}

const transport = new StdioClientTransport({
  command: 'node',
  args: ['mcp/server.js'],
  cwd: process.cwd(),
  env,
});
const client = new Client({ name: 'selftest', version: '0.0.1' });
await client.connect(transport);

const steps = scenarios[mode] || scenarios.read;
const tools = await client.listTools();
console.log('TOOLS ' + tools.tools.map((t) => t.name).join(', '));

const results = {};
const resultsSeq = [];
for (const [name, args] of steps) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content && r.content[0] && r.content[0].text;
    const rec = { name, isError: r.isError, text: String(text || '') };
    results[name] = rec;
    resultsSeq.push(rec);
    console.log(`\n== ${name} ==${r.isError ? ' [ERROR]' : ''}\n` + String(text).slice(0, 900));
  } catch (e) {
    results[name] = { isError: true, text: String(e.message || e) };
    resultsSeq.push({ name, isError: true, text: String(e.message || e) });
    console.log(`\n== ${name} == [EXCEPTION]\n` + String(e.message || e));
    break;
  }
}

if (mode === 'guard' && mock) {
  const parse = (r) => {
    if (!r || r.isError) return null;
    try {
      return JSON.parse(r.text);
    } catch {
      return null;
    }
  };
  const seq = (name) => resultsSeq.filter((r) => r.name === name);

  const cds = seq('create_devices');
  assert(cds.length === 2 && cds[0].isError, '设备重名应被拒绝');
  assert(cds.length === 2 && !cds[1].isError, '型号别名 Router 应可用');

  const cls = seq('create_link');
  assert(cls.length === 3, '连线用例数量不对');
  assert(cls[0] && !cls[0].isError, '大小写/空格端口名应可连接');
  assert(cls[1] && cls[1].isError && /已被占用/.test(cls[1].text), '端口重复占用应被拒绝');
  assert(cls[2] && cls[2].isError && /管理\/无线口/.test(cls[2].text), 'MEth 管理口应默认禁止');

  const vts = seq('validate_topology');
  const v1 = parse(vts[0]);
  const v2 = parse(vts[1]);
  assert(v1 && v1.ok === true, '预检合法拓扑应返回 ok');
  assert(
    v2 && v2.ok === false && v2.errors.some((e) => /已被占用/.test(e)),
    '预检应发现端口占用'
  );

  console.log('\n===== GUARD TEST ' + (failures.length ? 'FAILED' : 'PASSED') + ' =====');
  if (failures.length) for (const f of failures) console.log('- ' + f);
  mock.server.close();
}

if (mode === 'mock' && mock) {
  const paths = mock.log.map((l) => `${l.method} ${String(l.path).split('?')[0]}`);
  const has = (p) => paths.includes(p);
  const find = (p) => mock.log.find((l) => String(l.path).split('?')[0] === p);
  const parse = (r) => {
    if (!r || r.isError) return null;
    try {
      return JSON.parse(r.text);
    } catch {
      return null;
    }
  };
  const firstError = Object.entries(results).find(([, r]) => r.isError);

  const created = parse(results.create_sandbox) || {};
  assert(created.sandbox && created.sandbox.id === 2, 'create_sandbox 未返回沙箱 ID');
  const sandboxCall = find('/service/ensp/sandbox/create');
  assert(sandboxCall && sandboxCall.body.maxVms === 4 && sandboxCall.body.keepTime === 60, '创建沙箱参数未按预期传入');

  const devCall = find('/service/ensp/device/batchCreate');
  assert(devCall && devCall.body.devices.length === 2, '批量创建设备数量不对');
  assert(
    devCall && devCall.body.devices[0].deviceTypeId === 7 && devCall.body.devices[0].devicePosition,
    '创建设备缺少 deviceTypeId 或位置'
  );

  const linkCall = find('/service/ensp/link/create');
  assert(linkCall && linkCall.body.leftIfId && linkCall.body.rightIfId, '创建连线缺少接口 ID');

  const status = parse(results.get_device_status) || [];
  assert(Array.isArray(status) && status.length === 2 && status.every((d) => d.ready === false), '初始设备状态应为未就绪');

  const moveCall = find('/service/ensp/device/modifyComponent');
  assert(moveCall && moveCall.body.id === 1 && moveCall.body.devices[0].devicePosition.positionX === -0.4, '移动设备参数不对');

  assert(has('POST /service/ensp/device/batchStart'), '未调用批量启动');
  const wait = parse(results.wait_devices_ready) || {};
  assert(wait.all_ready === true, '启动后应等待到全部就绪');

  assert(has('POST /service/ensp/device/batchStop'), '未调用批量停止');
  assert(has('POST /service/ensp/device/batchReboot'), '未调用批量重启');

  const unlink = parse(results.delete_link) || {};
  assert(unlink.remaining_links === 0, '删除连线后剩余连线应为 0');

  const del = parse(results.delete_devices) || {};
  assert(Array.isArray(del.remaining) && del.remaining.length === 0, '删除设备后应无剩余设备');

  if (firstError) assert(false, `工具 ${firstError[0]} 返回错误：${firstError[1].text.slice(0, 120)}`);

  console.log('\n===== MOCK TEST ' + (failures.length ? 'FAILED' : 'PASSED') + ' =====');
  if (failures.length) {
    for (const f of failures) console.log('- ' + f);
  } else {
    console.log('22 项工具调用与请求参数校验全部通过');
  }
  mock.server.close();
}

if (mode === 'graphics' && mock) {
  const find = (p) => mock.log.find((l) => String(l.path).split('?')[0] === p);
  const parse = (r) => {
    if (!r || r.isError) return null;
    try {
      return JSON.parse(r.text);
    } catch {
      return null;
    }
  };
  const firstError = Object.entries(results).find(([, r]) => r.isError);

  // 1) 批量创建 3 个图元（矩形/椭圆/直线）
  const add = parse(results.add_graphics) || {};
  assert(Array.isArray(add.created) && add.created.length === 3, 'add_graphics 应创建 3 个图元');
  const createCall = find('/service/ensp/graphics/createGraphics');
  assert(createCall && createCall.body.graphics.length === 3, 'createGraphics 请求体应含 3 个图元');
  const kinds = (add.created || []).map((c) => c.kind).sort();
  assert(
    JSON.stringify(kinds) === JSON.stringify(['ellipse', 'line', 'rectangle']),
    '图元类型应为 rect/ellipse/line'
  );

  // 2) 添加文本
  const addText = parse(results.add_text) || {};
  assert((addText.created || {}).content === 'CORE 区域', 'add_text 内容不对');
  const textCall = find('/service/ensp/textBox/createTextBox');
  assert(textCall && textCall.body.positionX === 0.5, 'createTextBox 位置参数未传入');

  // 3) update_graphic 必须带 nodeId（否则后端返回 50020008 非法操作）
  const upd = find('/service/ensp/graphics/updateGraphics');
  assert(upd && upd.body.graphics[0].nodeId === 'rect-1', 'update_graphic 必须带 nodeId=rect-1');
  assert(upd && upd.body.graphics[0].color === '#ff0000', 'update_graphic 颜色未更新');

  // 4) update_text 必须带 nodeId，字号限制在 8~20
  const updText = find('/service/ensp/textBox/updateTextBox');
  assert(updText && updText.body.textBoxes[0].nodeId === 'text-1', 'update_text 必须带 nodeId=text-1');
  assert(updText && updText.body.textBoxes[0].fontSize === 18, 'update_text 字号应为 18');

  // 5) 最终 list：删除直线和文本后剩 2 图元、0 文本，且矩形颜色已更新
  const finalList = parse(results.list_graphics) || {};
  assert(Array.isArray(finalList.graphics) && finalList.graphics.length === 2, '删除后应剩 2 个图元');
  assert(Array.isArray(finalList.texts) && finalList.texts.length === 0, '删除后应无文本');
  const rect = finalList.graphics.find((g) => g.kind === 'rectangle');
  assert(rect && rect.color === '#ff0000', '矩形颜色更新未生效');
  const remainKinds = finalList.graphics.map((g) => g.kind).sort();
  assert(JSON.stringify(remainKinds) === JSON.stringify(['ellipse', 'rectangle']), '剩余图元类型不对');

  // 6) 删除接口均已调用
  assert(find('/service/ensp/graphics/deleteGraphics'), '未调用 deleteGraphics');
  assert(find('/service/ensp/textBox/deleteTextBoxes'), '未调用 deleteTextBoxes');

  if (firstError) assert(false, `工具 ${firstError[0]} 返回错误：${firstError[1].text.slice(0, 120)}`);

  console.log('\n===== GRAPHICS TEST ' + (failures.length ? 'FAILED' : 'PASSED') + ' =====');
  if (failures.length) {
    for (const f of failures) console.log('- ' + f);
  } else {
    console.log('图元/文本增删改查 ' + Object.keys(results).length + ' 步调用全部通过');
  }
  mock.server.close();
}

await client.close();
if (mode === 'mock' || mode === 'guard' || mode === 'graphics')
  process.exit(failures.length ? 1 : 0);
