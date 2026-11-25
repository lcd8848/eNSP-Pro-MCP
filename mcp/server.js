// eNSP WebMCP：MCP 服务端。工具调用经本地桥转发到已登录页面，全程不接触账号密码
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE = `http://127.0.0.1:${process.env.ENSP_BRIDGE_PORT || 8790}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_ENTRY = path.join(ROOT, 'bridge', 'server.js');

async function bridgeUp(timeoutMs = 800) {
  try {
    const resp = await fetch(`${BRIDGE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return resp.ok;
  } catch {
    return false;
  }
}

let bridgeStarting = null;
// MCP 启动时自动拉起本地桥：已在线则不重复启动；子进程分离且丢弃输出，避免污染 stdio 协议通道
async function ensureBridge() {
  if (await bridgeUp()) return true;
  if (!bridgeStarting) {
    bridgeStarting = (async () => {
      try {
        const child = spawn(process.execPath, [BRIDGE_ENTRY], {
          cwd: ROOT,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
      } catch {
        return false;
      }
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        if (await bridgeUp()) return true;
      }
      return false;
    })().finally(() => {
      bridgeStarting = null;
    });
  }
  return bridgeStarting;
}

async function call(method, path, body) {
  let resp;
  try {
    resp = await fetch(`${BRIDGE}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, path, body }),
    });
  } catch (e) {
    if (await ensureBridge()) {
      resp = await fetch(`${BRIDGE}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, path, body }),
      });
    } else {
      throw new Error('本地桥未启动且自动拉起失败，请手动运行 node bridge/server.js');
    }
  }
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
  if (!data.ok) throw new Error(`Web 接口失败: HTTP ${data.status} ${data.text || ''}`.trim());
  if (!data.json) throw new Error('返回不是 JSON: ' + String(data.text || '').slice(0, 300));
  return data.json;
}

function reply(value) {
  return {
    content: [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

async function consoleCall(params) {
  let resp;
  try {
    resp = await fetch(`${BRIDGE}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'console', params }),
    });
  } catch (e) {
    if (await ensureBridge()) {
      resp = await fetch(`${BRIDGE}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'console', params }),
      });
    } else {
      throw new Error('本地桥未启动且自动拉起失败，请手动运行 node bridge/server.js');
    }
  }
  const data = await resp.json();
  if (data.ok === false) throw new Error(data.error || '控制台执行失败');
  return data;
}

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// 设备存储坐标是 -0.5~0.5（中心点为 0），标注工具（add_graphics/add_text）坐标是 0~1（左上角为原点），两者差 0.5
function devicePositionView(d) {
  const pos = (d && d.devicePosition) || {};
  const px = typeof pos.positionX === 'number' ? pos.positionX : null;
  const py = typeof pos.positionY === 'number' ? pos.positionY : null;
  return {
    position_x: px,
    position_y: py,
    annotate_x: px === null ? null : Number((px + 0.5).toFixed(4)),
    annotate_y: py === null ? null : Number((py + 0.5).toFixed(4)),
  };
}

// 按型号的接口装配表展开成具体端口，规则与 Web 前端一致
function buildInterfaces(type) {
  const list = [];
  const assembles = [...(type.ifAssembles || [])].sort((a, b) => a.id - b.id);
  let serial = 0;
  for (const a of assembles) {
    for (let i = 0; i < a.ifNumber; i++) {
      const port = Number(a.ifPortStart) + i;
      const name =
        a.ifClassId === null || a.ifClassId === undefined
          ? `${a.ifType.name}${a.ifSlotId}/${a.ifPicId}/${port}`
          : `${a.ifType.name}${a.ifClassId}/${a.ifSlotId}/${a.ifPicId}/${port}`;
      list.push({ name, ifType: { id: a.ifType.id, name: a.ifType.name }, serialId: serial });
      serial += 1;
    }
  }
  return list;
}

function buildDevice(type, sandboxId, { name, x, y }) {
  const positionX = clamp(x ?? -0.3, -0.5, 0.5);
  const positionY = clamp(y ?? -0.1, -0.5, 0.5);
  return {
    id: null,
    name: name || type.displayName || type.name,
    deviceType: type,
    deviceIfs: buildInterfaces(type),
    deviceState: 0,
    displayStatus: 11,
    devicePosition: { positionX, positionY },
    namePosition: { id: null, positionX, positionY },
    sandboxId,
    deviceTypeId: type.id,
  };
}

async function loadSandbox(sandboxId) {
  const data = await call('GET', `/service/ensp/sandbox/getOneSandbox?sandboxId=${sandboxId}`);
  const sb = data.data || {};
  return {
    id: sb.id,
    name: sb.name,
    status: sb.status,
    maxVms: sb.maxVms,
    devices: sb.devices || [],
    links: sb.links || [],
  };
}

function pickDevice(sandbox, key) {
  const exact = sandbox.devices.find((d) => d.name === key);
  if (exact) return exact;
  const byId = sandbox.devices.find((d) => String(d.id) === String(key));
  if (byId) return byId;
  const fuzzy = sandbox.devices.filter((d) => String(d.name).includes(key));
  if (fuzzy.length === 1) return fuzzy[0];
  throw new Error(`找不到设备 ${key}，现有：${sandbox.devices.map((d) => d.name).join(', ')}`);
}

// 型号别名：兼容常见叫法，最终映射到 Web 返回的 name / displayName
const TYPE_ALIASES = {
  LSW: 'S',
  SWITCH: 'S',
  'ENSP-LSW': 'S',
  S5700: 'S',
  S3700: 'S',
  S12700: 'S',
  PC: 'PC-CLIENT',
  CLIENT: 'PC-CLIENT',
  SERVER: 'PC-SERVER',
  SRV: 'PC-SERVER',
  ROUTER: 'AR',
  ROUTE: 'AR',
  FIREWALL: 'USG',
  FW: 'USG',
  DUAL: 'PC-DUAL',
  HUB: 'EXTERNAL-HUB',
};

function pickType(types, key) {
  const raw = String(key || '').trim().toUpperCase();
  const key2 = TYPE_ALIASES[raw] || raw;
  return types.find((t) => {
    const name = String(t.name || '').toUpperCase();
    const display = String(t.displayName || '').toUpperCase();
    return name === key2 || display === key2;
  });
}

function normalizePort(name) {
  return String(name || '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

function findInterface(device, port) {
  const key = normalizePort(port);
  return (device.deviceIfs || []).find((i) => normalizePort(i.name) === key);
}

function interfaceNames(device) {
  return (device.deviceIfs || []).map((i) => i.name);
}

const MANAGEMENT_IF_TYPES = new Set(['METH', 'WLAN']);

function isManagementInterface(iface) {
  const t = iface && iface.ifType;
  const typeName = typeof t === 'string' ? t : t && t.name;
  return MANAGEMENT_IF_TYPES.has(normalizePort(typeName));
}

function usedPortIds(sandbox) {
  const used = new Map();
  for (const l of sandbox.links || []) {
    used.set(l.leftIfId, l);
    used.set(l.rightIfId, l);
  }
  return used;
}

const TERMINAL_TYPES = new Set(['PC-CLIENT', 'PC-SERVER', 'PC-DUAL', 'STA']);

function terminalType(device) {
  const t = device && device.deviceType;
  const candidates = [t && t.name, t && t.displayName, device && device.type]
    .filter(Boolean)
    .map((v) => String(v).toUpperCase().replace(/^ENSP-/, ''));
  return candidates.find((v) => TERMINAL_TYPES.has(v)) || candidates[0] || '';
}

function assertTerminal(device) {
  if (!TERMINAL_TYPES.has(terminalType(device))) {
    throw new Error(
      `${device.name} 不是终端节点，仅支持 PC-CLIENT、PC-SERVER、PC-DUAL、STA`
    );
  }
}

const TERMINAL_CONFIG_PREFIXES = [
  'basic.',
  'ipv4.',
  'ipv6.',
  'multicastsrc.',
  'multicastrcv.',
  'multicastsrcv6.',
  'multicastrcvv6.',
  'dns.',
  'dhcp.',
  'dhcpv6.',
  'ftp.',
  'http.',
];

function validateTerminalConfig(config, allowed = []) {
  const keys = Object.keys(config || {});
  if (!keys.length) throw new Error('config 不能为空');
  if (allowed.length) {
    const bad = keys.filter((k) => !allowed.includes(k));
    if (bad.length) {
      throw new Error(
        `该终端不支持的配置键：${bad.join(', ')}；可用键示例：${allowed.slice(0, 12).join(', ')}`
      );
    }
    return;
  }
  const bad = keys.filter((k) => !TERMINAL_CONFIG_PREFIXES.some((p) => k.startsWith(p)));
  if (bad.length) {
    throw new Error(
      `不支持的配置键：${bad.join(', ')}；允许前缀：${TERMINAL_CONFIG_PREFIXES.join(' ')}`
    );
  }
}

function assertApiOk(r, action) {
  if (r && r.code !== undefined && r.code !== 0 && r.code !== 200 && r.success !== true) {
    throw new Error(`${action}失败：${r.message || r.msg || 'code=' + r.code}`);
  }
  return r;
}

async function readTerminalConfig(deviceId) {
  const r = await call(
    'GET',
    `/service/ensp/device/property/refreshAttrs?deviceId=${deviceId}`
  );
  assertApiOk(r, '读取终端配置');
  if (typeof r.data === 'string') {
    try {
      return JSON.parse(r.data);
    } catch {
      return {};
    }
  }
  return r.data && typeof r.data === 'object' ? r.data : {};
}

async function updateTerminalConfig(deviceId, config) {
  const r = await call(
    'POST',
    `/service/ensp/device/property/updateAttrs?deviceId=${deviceId}`,
    config
  );
  assertApiOk(r, '更新终端配置');
  return r;
}

function isIpv4(value) {
  const parts = String(value || '').split('.');
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255)
  );
}

function flattenPropertyKeys(nodes, prefix = '') {
  const keys = [];
  for (const node of nodes || []) {
    if (!node || !node.name) continue;
    const path = prefix ? `${prefix}.${node.name}` : node.name;
    if (Array.isArray(node.properties) && node.properties.length) {
      keys.push(...flattenPropertyKeys(node.properties, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

async function terminalPropertyKeys(device, sandboxId) {
  const typeId = device.deviceTypeId || (device.deviceType && device.deviceType.id);
  if (!typeId) return [];
  const r = await call(
    'GET',
    `/service/ensp/device-type/oneDevProps?deviceTypeId=${typeId}&sandboxId=${sandboxId}`
  );
  assertApiOk(r, '读取终端属性定义');
  const nodes = Array.isArray(r.data) ? r.data : (r.data && r.data.properties) || [];
  return flattenPropertyKeys(nodes);
}



// ============ 拓扑标注（图元 / 文本）工具 ============
// 坐标约定：位置（positionX/Y、leftX/Y、rightX/Y）为画布归一化值 0~1（左上 0,0 → 右下 1,1）；
// 尺寸（width/height、椭圆半长轴）为像素。与前端 sandbox-63dabefb.js / index-4e14d765.js 一致。
const GRAPHIC_TYPE = { line: 0, ellipse: 1, rectangle: 2 };
const TYPE_TO_NAME = { 0: 'line', 1: 'ellipse', 2: 'rectangle' };
// 前端 topo 层给图元加的 nodeId 前缀（update 接口必须带 nodeId，否则后端返回 50020008 非法操作）
const NODE_TYPE_BY_KIND = { line: 'line', rectangle: 'rect', ellipse: 'ellipse' };
const BORDER_STYLES = {
  solid: '0, 0',
  dash: '10, 5',
  dot: '5, 5',
  dashdot: '10, 5, 5, 10',
  dashdotdot: '10, 5, 5, 5, 5, 5',
};
const GRAPHIC_DEFAULTS = { color: '#C6DEF7', boardStyle: '0, 0', boardWidth: 1, isFill: true };
const TEXT_DEFAULTS = { fontSize: 14, fontColor: '#000000', backgroundColor: '#90EE90' };

function resolveBoardStyle(v) {
  if (v === undefined || v === null || v === '') return GRAPHIC_DEFAULTS.boardStyle;
  const key = String(v).toLowerCase();
  if (BORDER_STYLES[key]) return BORDER_STYLES[key];
  if (/^[\d,\s]+$/.test(String(v))) return String(v).trim();
  throw new Error(
    `不支持的边框样式 board_style=${v}，可选 solid/dash/dot/dashdot/dashdotdot 或 "10, 5" 形式`
  );
}

function clamp01(v, name) {
  if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`${name} 必须是数字`);
  if (v < 0 || v > 1) {
    throw new Error(`${name}=${v} 超出范围，位置坐标必须是 0~1 的归一化值（画布左上 0,0，右下 1,1）`);
  }
  return v;
}

function graphicTypeValue(kind) {
  const k = String(kind || '').toLowerCase();
  if (!(k in GRAPHIC_TYPE)) {
    throw new Error(`不支持的图元类型 kind=${kind}，可选 line / rectangle / ellipse`);
  }
  return GRAPHIC_TYPE[k];
}

async function loadTopology(sandboxId) {
  const data = await call('GET', `/service/ensp/sandbox/getOneSandbox?sandboxId=${sandboxId}`);
  const sb = data.data || {};
  return {
    id: sb.id,
    name: sb.name,
    graphics: sb.graphicsVOList || [],
    textBoxes: sb.textBoxs || [],
  };
}

function findGraphic(topo, typeValue, id) {
  const g = topo.graphics.find((x) => Number(x.type) === Number(typeValue) && Number(x.id) === Number(id));
  if (!g) {
    throw new Error(`找不到图元 kind=${TYPE_TO_NAME[typeValue] || typeValue} id=${id}，请先调用 list_graphics 确认`);
  }
  return g;
}

function findText(topo, id) {
  const t = topo.textBoxes.find((x) => Number(x.id) === Number(id));
  if (!t) throw new Error(`找不到文本 id=${id}，请先调用 list_graphics 确认`);
  return t;
}

// 构造 createGraphics 的单个图元 VO；coverLevel 由调用方按现有图元数量递增传入
function buildCreateGraphic(kind, item, sandboxId, coverLevel) {
  const typeValue = graphicTypeValue(kind);
  const vo = {
    type: typeValue,
    color: item.color || GRAPHIC_DEFAULTS.color,
    boardStyle: resolveBoardStyle(item.board_style),
    boardWidth: item.board_width === undefined ? GRAPHIC_DEFAULTS.boardWidth : clamp(item.board_width, 1, 10),
    isFill: item.fill === undefined ? GRAPHIC_DEFAULTS.isFill : Boolean(item.fill),
    sandboxId,
    coverLevel,
  };
  const need = (fields) => {
    for (const f of fields) {
      if (item[f] === undefined) throw new Error(`${kind} 缺少字段 ${f}`);
    }
  };
  if (kind === 'line') {
    need(['x1', 'y1', 'x2', 'y2']);
    vo.leftX = clamp01(item.x1, 'x1');
    vo.leftY = clamp01(item.y1, 'y1');
    vo.rightX = clamp01(item.x2, 'x2');
    vo.rightY = clamp01(item.y2, 'y2');
  } else if (kind === 'rectangle') {
    need(['x', 'y', 'width', 'height']);
    if (item.width <= 0 || item.height <= 0) throw new Error('矩形 width/height 必须为正数（像素）');
    vo.positionX = clamp01(item.x, 'x');
    vo.positionY = clamp01(item.y, 'y');
    vo.width = item.width;
    vo.height = item.height;
  } else {
    need(['x', 'y', 'width', 'height']);
    if (item.width <= 0 || item.height <= 0) throw new Error('椭圆 width/height 必须为正数（像素）');
    vo.positionX = clamp01(item.x, 'x');
    vo.positionY = clamp01(item.y, 'y');
    vo.horizontalLength = item.width / 2;
    vo.verticalLength = item.height / 2;
  }
  return vo;
}

const server = new McpServer({ name: 'ensp-webmcp', version: '0.3.0' });

server.registerTool(
  'get_sandboxes',
  {
    title: '列出沙箱',
    description: '列出 eNSP 沙箱，包含设备数与连线数。数据取自当前已登录的 Web 页面。',
    inputSchema: {},
  },
  async () => {
    const data = await call('POST', '/service/ensp/sandbox/getByPage', {
      currentPage: 1,
      pageSize: 50,
      projectId: 1,
    });
    const list = (data.data || []).map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      devices: (s.devices || []).length,
      links: (s.links || []).length,
    }));
    return reply(list);
  }
);

server.registerTool(
  'get_sandbox',
  {
    title: '读取沙箱拓扑',
    description: '读取指定沙箱的设备、接口与连线，接口带 id 与端口名，可直接用于后续连线。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID，可先调用 get_sandboxes 获取'),
    },
  },
  async ({ sandbox_id }) => {
    const data = await call('GET', `/service/ensp/sandbox/getOneSandbox?sandboxId=${sandbox_id}`);
    const sb = data.data || {};
    const deviceMap = new Map((sb.devices || []).map((d) => [d.id, d]));
    const endpoint = (deviceId, ifId) => {
      const device = deviceMap.get(deviceId);
      const iface = ((device && device.deviceIfs) || []).find((i) => i.id === ifId);
      return {
        deviceId,
        ifId,
        device: device ? device.name : null,
        port: iface ? iface.name : null,
      };
    };
    return reply({
      id: sb.id,
      name: sb.name,
      status: sb.status,
      devices: (sb.devices || []).map((d) => ({
        id: d.id,
        name: d.name,
        type: d.deviceType && d.deviceType.name,
        status: d.status,
        ...devicePositionView(d),
        interfaces: (d.deviceIfs || []).map((i) => ({ id: i.id, name: i.name, status: i.status })),
      })),
      links: (sb.links || []).map((l) => ({
        id: l.id,
        left: endpoint(l.leftDeviceId, l.leftIfId),
        right: endpoint(l.rightDeviceId, l.rightIfId),
        status: l.status,
      })),
    });
  }
);

server.registerTool(
  'get_device_positions',
  {
    title: '读取设备画布坐标',
    description:
      '读取沙箱内所有设备的画布坐标，标注时无需手录。返回两套坐标：position_x/y（创建设备用的 -0.5~0.5，中心点为 0）和 annotate_x/y（add_graphics/add_text 用的 0~1，左上角为原点，= position+0.5）。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
    },
  },
  async ({ sandbox_id }) => {
    const sb = await loadSandbox(sandbox_id);
    return reply({
      sandbox_id,
      devices: (sb.devices || []).map((d) => ({
        id: d.id,
        name: d.name,
        type: d.deviceType && d.deviceType.name,
        ...devicePositionView(d),
      })),
    });
  }
);

server.registerTool(
  'get_resource_usage',
  {
    title: '查询系统资源负载',
    description:
      '读取 eNSP Web 顶部资源面板显示的系统负载：CPU、内存、磁盘使用率，与 Web 显示完全一致。数据来自 GET /service/ensp/system/summary；可选附带 /system/detail 详情（Web 前端对详情有 10 秒冷却，频繁调用可能被限流）。',
    inputSchema: {
      include_detail: z
        .boolean()
        .optional()
        .describe('是否同时获取资源详情（/system/detail 的 sysDetail）。默认 false，避免触发详情接口的 10 秒冷却'),
    },
  },
  async ({ include_detail }) => {
    // 与 Web 前端 initSystemInfo/updateSystemInfo 完全一致的换算：
    // parseFloat(s) 后 Math.round(i*100) + '%'，NaN 显示 '-'
    const fmt = (s) => {
      const i = parseFloat(s);
      if (Number.isNaN(i)) return { value: null, percent: '-', percent_number: null };
      return { value: i, percent: `${Math.round(i * 100)}%`, percent_number: Math.round(i * 100) };
    };
    const raw = await call('GET', '/service/ensp/system/summary');
    const d = (raw && raw.data) || raw || {};
    const result = {
      cpu: fmt(d.cpu),
      memory: fmt(d.memory),
      disk: fmt(d.disk),
      summary_raw: d,
      fetched_at: new Date().toISOString(),
    };
    if (include_detail) {
      try {
        const dr = await call('GET', '/service/ensp/system/detail');
        result.detail = (dr && dr.data && dr.data.sysDetail) || (dr && dr.data) || dr || null;
      } catch (e) {
        result.detail_error = String((e && e.message) || e);
      }
    }
    return reply(result);
  }
);

server.registerTool(
  'get_device_types',
  {
    title: '列出设备型号',
    description: '列出沙箱可用的设备型号及其接口清单，创建设备前用它确认型号名。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
    },
  },
  async ({ sandbox_id }) => {
    const data = await call('GET', `/service/ensp/device-type/all?sandboxId=${sandbox_id}`);
    const devices = (data.data && data.data.devices) || [];
    return reply(
      devices.map((d) => ({
        id: d.id,
        name: d.name,
        displayName: d.displayName,
        category: d.superDeviceType && d.superDeviceType.name,
        available: d.available,
        interfaces: (d.ifAssembles || []).map(
          (i) => `${(i.ifType && i.ifType.name) || ''}x${i.ifNumber}`
        ),
        ports: buildInterfaces(d).map((i) => i.name),
      }))
    );
  }
);

server.registerTool(
  'get_terminal_config',
  {
    title: '读取终端配置',
    description:
      '读取终端节点（PC-CLIENT、PC-SERVER、PC-DUAL、STA）的属性配置，包含 IPv4、IPv6、MAC、组播参数等。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_name: z.string().describe('终端设备名'),
    },
  },
  async ({ sandbox_id, device_name }) => {
    const sb = await loadSandbox(sandbox_id);
    const device = pickDevice(sb, device_name);
    assertTerminal(device);
    const [config, keys] = await Promise.all([
      readTerminalConfig(device.id),
      terminalPropertyKeys(device, sandbox_id),
    ]);
    return reply({
      device: { id: device.id, name: device.name, type: terminalType(device) },
      config,
      keys,
    });
  }
);

server.registerTool(
  'set_terminal_config',
  {
    title: '更新终端配置',
    description:
      '按点号键更新终端配置，只提交传入的键，未传字段保持不变。示例：{"ipv4.config.ip":"192.168.1.10","ipv4.config.ipmask":"255.255.255.0","multicastsrc.config.group":"239.1.1.1"}。组播接收运行态不在本工具范围。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_name: z.string().describe('终端设备名'),
      config: z
        .record(z.string(), z.string())
        .describe('点号键值表，如 ipv4.ip、ipv4.ipmask、ipv6.addr、multicastsrc.group'),
    },
  },
  async ({ sandbox_id, device_name, config }) => {
    const sb = await loadSandbox(sandbox_id);
    const device = pickDevice(sb, device_name);
    assertTerminal(device);
    const allowed = await terminalPropertyKeys(device, sandbox_id);
    validateTerminalConfig(config, allowed);
    const response = await updateTerminalConfig(device.id, config);
    const after = await readTerminalConfig(device.id);
    return reply({
      device: { id: device.id, name: device.name, type: terminalType(device) },
      updated: Object.keys(config),
      response,
      config: after,
    });
  }
);

server.registerTool(
  'set_terminal_ipv4',
  {
    title: '设置终端 IPv4',
    description:
      '设置终端 IPv4 地址、掩码、网关和 DNS；mode=dhcp 时只切换为 DHCP。配置在设备启动后生效。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_name: z.string().describe('终端设备名'),
      mode: z.enum(['static', 'dhcp']).optional().describe('static 或 dhcp，默认 static'),
      ip: z.string().optional().describe('IPv4 地址，static 时必填'),
      mask: z.string().optional().describe('子网掩码，static 时必填'),
      gateway: z.string().optional().describe('网关'),
      dns1: z.string().optional().describe('首选 DNS'),
      dns2: z.string().optional().describe('备用 DNS'),
    },
  },
  async ({ sandbox_id, device_name, mode = 'static', ip, mask, gateway, dns1, dns2 }) => {
    const sb = await loadSandbox(sandbox_id);
    const device = pickDevice(sb, device_name);
    assertTerminal(device);
    const allowed = await terminalPropertyKeys(device, sandbox_id);
    if (!allowed.includes('ipv4.config.ip')) {
      throw new Error(`${device.name}（${terminalType(device)}）不支持 IPv4 配置`);
    }

    const config = {};
    if (allowed.includes('ipv4.type')) config['ipv4.type'] = mode;
    else if (mode === 'dhcp') {
      throw new Error(`${device.name}（${terminalType(device)}）不支持 DHCP 模式切换，请使用 static`);
    }

    if (mode === 'static') {
      if (!isIpv4(ip)) throw new Error(`IPv4 地址不合法：${ip || '空'}`);
      if (!isIpv4(mask)) throw new Error(`子网掩码不合法：${mask || '空'}`);
      config['ipv4.config.ip'] = ip;
      config['ipv4.config.ipmask'] = mask;
      if (gateway !== undefined) {
        if (!isIpv4(gateway)) throw new Error(`网关不合法：${gateway}`);
        config['ipv4.config.gateway'] = gateway;
      }
      if (dns1 !== undefined) config['ipv4.config.dns1'] = dns1;
      if (dns2 !== undefined) config['ipv4.config.dns2'] = dns2;
    }

    const response = await updateTerminalConfig(device.id, config);
    const after = await readTerminalConfig(device.id);
    return reply({
      device: { id: device.id, name: device.name, type: terminalType(device) },
      updated: config,
      response,
      config: after,
    });
  }
);

server.registerTool(
  'set_terminal_ipv6',
  {
    title: '设置终端 IPv6',
    description:
      '设置终端 IPv6 地址、前缀长度、网关和 DNS；mode=dhcp 时只切换为 DHCP。配置在设备启动后生效。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_name: z.string().describe('终端设备名'),
      mode: z.enum(['static', 'dhcp']).optional().describe('static 或 dhcp，默认 static'),
      addr: z.string().optional().describe('IPv6 地址，static 时必填'),
      prefix_len: z.number().int().min(0).max(128).optional().describe('前缀长度，static 时必填'),
      gateway: z.string().optional().describe('IPv6 网关'),
      dns: z.string().optional().describe('IPv6 DNS'),
    },
  },
  async ({ sandbox_id, device_name, mode = 'static', addr, prefix_len, gateway, dns }) => {
    const sb = await loadSandbox(sandbox_id);
    const device = pickDevice(sb, device_name);
    assertTerminal(device);
    const allowed = await terminalPropertyKeys(device, sandbox_id);
    if (!allowed.includes('ipv6.config.addr')) {
      throw new Error(`${device.name}（${terminalType(device)}）不支持 IPv6 配置`);
    }

    const config = {};
    if (allowed.includes('ipv6.type')) config['ipv6.type'] = mode;
    else if (mode === 'dhcp') {
      throw new Error(`${device.name}（${terminalType(device)}）不支持 DHCP 模式切换，请使用 static`);
    }

    if (mode === 'static') {
      if (!addr || !addr.includes(':') || !/^[0-9a-fA-F:]+$/.test(addr)) {
        throw new Error(`IPv6 地址不合法：${addr || '空'}`);
      }
      if (prefix_len === undefined) throw new Error('static 模式必须提供 prefix_len');
      config['ipv6.config.addr'] = addr;
      config['ipv6.config.prefixlen'] = String(prefix_len);
      if (gateway !== undefined) config['ipv6.config.gateway'] = gateway;
      if (dns !== undefined) config['ipv6.config.dns'] = dns;
    }

    const response = await updateTerminalConfig(device.id, config);
    const after = await readTerminalConfig(device.id);
    return reply({
      device: { id: device.id, name: device.name, type: terminalType(device) },
      updated: config,
      response,
      config: after,
    });
  }
);

server.registerTool(
  'create_devices',
  {
    title: '批量创建设备',
    description:
      '在沙箱里创建设备，直接写入 Web 层并出现在界面上。type 支持型号名或简称：AR/Router、S/S5700/LSW/Switch、PC/Client、Server、USG/Firewall、NE、CE、AC、AP、STA、PC-DUAL、CLOUD。设备名不可与沙箱内已有设备重复。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      devices: z
        .array(
          z.object({
            type: z.string().describe('型号名或简称，如 AR、S5700、PC'),
            name: z.string().optional().describe('设备名，省略则按型号自动编号'),
            x: z.number().optional().describe('画布横向位置，-0.5~0.5，默认 -0.3'),
            y: z.number().optional().describe('画布纵向位置，-0.5~0.5，默认 -0.1'),
          })
        )
        .min(1),
    },
  },
  async ({ sandbox_id, devices }) => {
    const [typeData, sb] = await Promise.all([
      call('GET', `/service/ensp/device-type/all?sandboxId=${sandbox_id}`),
      loadSandbox(sandbox_id),
    ]);
    const types = (typeData.data && typeData.data.devices) || [];
    const usedNames = new Set(sb.devices.map((d) => String(d.name).toUpperCase()));
    const payload = [];

    for (let index = 0; index < devices.length; index += 1) {
      const item = devices[index];
      const type = pickType(types, item.type);
      if (!type) {
        const available = types
          .filter((t) => t.available)
          .map((t) => `${t.name}/${t.displayName}`)
          .join(', ');
        throw new Error(`未知型号 ${item.type}，可用：${available}`);
      }
      if (!type.available) throw new Error(`型号 ${type.displayName} 当前不可用`);

      let name = String(item.name || '').trim();
      if (!name) {
        const base = type.displayName || type.name;
        let n = 1;
        while (usedNames.has(`${base}-${n}`.toUpperCase())) n += 1;
        name = `${base}-${n}`;
      } else if (usedNames.has(name.toUpperCase())) {
        throw new Error(`设备名重复：${name}，沙箱内已存在同名设备，请换一个名字`);
      }
      usedNames.add(name.toUpperCase());

      payload.push(
        buildDevice(type, sandbox_id, {
          name,
          x: item.x ?? -0.3 + index * 0.25,
          y: item.y ?? -0.1,
        })
      );
    }

    if (sb.maxVms && sb.devices.length + payload.length > sb.maxVms) {
      throw new Error(
        `超出沙箱设备上限：已有 ${sb.devices.length} 台，新增 ${payload.length} 台，上限 ${sb.maxVms} 台`
      );
    }

    const created = await call('POST', '/service/ensp/device/batchCreate', {
      sandboxId: sandbox_id,
      devices: payload,
    });
    const after = await loadSandbox(sandbox_id);
    return reply({
      requested: payload.map((d) => d.name),
      response: created,
      devices: after.devices.map((d) => ({
        id: d.id,
        name: d.name,
        type: d.deviceType && d.deviceType.name,
        status: d.status,
        ports: interfaceNames(d),
      })),
    });
  }
);

server.registerTool(
  'create_link',
  {
    title: '连接两台设备',
    description:
      '按设备名和端口名连接两台设备。端口名不区分大小写和空格；默认禁止连接 MEth/Wlan 管理或无线口。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      left_device: z.string().describe('左侧设备名'),
      left_port: z.string().describe('左侧端口名，如 GE0/0/0'),
      right_device: z.string().describe('右侧设备名'),
      right_port: z.string().describe('右侧端口名，如 GE0/0/0'),
      allow_management: z
        .boolean()
        .optional()
        .describe('是否允许连接 MEth/Wlan 管理或无线口，默认 false'),
    },
  },
  async ({ sandbox_id, left_device, left_port, right_device, right_port, allow_management = false }) => {
    const sb = await loadSandbox(sandbox_id);
    const left = pickDevice(sb, left_device);
    const right = pickDevice(sb, right_device);
    if (left.id === right.id) throw new Error('不能把一台设备连接到它自己');

    const leftIf = findInterface(left, left_port);
    const rightIf = findInterface(right, right_port);
    if (!leftIf) {
      throw new Error(`${left.name} 没有端口 ${left_port}，可用：${interfaceNames(left).join(', ')}`);
    }
    if (!rightIf) {
      throw new Error(`${right.name} 没有端口 ${right_port}，可用：${interfaceNames(right).join(', ')}`);
    }

    if (!allow_management) {
      if (isManagementInterface(leftIf)) {
        throw new Error(`端口 ${left.name}:${leftIf.name} 是管理/无线口，默认禁止连线；如确需连接请设置 allow_management=true`);
      }
      if (isManagementInterface(rightIf)) {
        throw new Error(`端口 ${right.name}:${rightIf.name} 是管理/无线口，默认禁止连线；如确需连接请设置 allow_management=true`);
      }
    }

    const used = usedPortIds(sb);
    if (used.has(leftIf.id)) {
      throw new Error(`端口已被占用：${left.name}:${leftIf.name}，一个端口只能连一条线`);
    }
    if (used.has(rightIf.id)) {
      throw new Error(`端口已被占用：${right.name}:${rightIf.name}，一个端口只能连一条线`);
    }

    const created = await call('POST', '/service/ensp/link/create', {
      leftDeviceId: left.id,
      leftIfId: leftIf.id,
      rightDeviceId: right.id,
      rightIfId: rightIf.id,
      linkTypeId: 1,
      sandboxId: sandbox_id,
    });
    const after = await loadSandbox(sandbox_id);
    return reply({
      response: created,
      links: after.links.map((l) => ({
        id: l.id,
        left: { deviceId: l.leftDeviceId, ifId: l.leftIfId },
        right: { deviceId: l.rightDeviceId, ifId: l.rightIfId },
        status: l.status,
      })),
    });
  }
);

server.registerTool(
  'validate_topology',
  {
    title: '预检拓扑',
    description:
      '在真正创建设备和链路前做只读预检：型号、重名、端口存在性、管理口、端口占用、设备上限。返回 ok 与错误列表，不修改沙箱。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      devices: z
        .array(
          z.object({
            type: z.string().describe('型号名或简称'),
            name: z.string().optional().describe('设备名，省略则按型号自动编号'),
          })
        )
        .optional()
        .describe('计划新增的设备'),
      links: z
        .array(
          z.object({
            left_device: z.string(),
            left_port: z.string(),
            right_device: z.string(),
            right_port: z.string(),
          })
        )
        .optional()
        .describe('计划新增的链路'),
      allow_management: z.boolean().optional().describe('是否允许连接 MEth/Wlan，默认 false'),
    },
  },
  async ({ sandbox_id, devices = [], links = [], allow_management = false }) => {
    const [typeData, sb] = await Promise.all([
      call('GET', `/service/ensp/device-type/all?sandboxId=${sandbox_id}`),
      loadSandbox(sandbox_id),
    ]);
    const types = (typeData.data && typeData.data.devices) || [];
    const errors = [];

    const index = new Map();
    const addDevice = (name, id, deviceIfs) => {
      index.set(String(name).toUpperCase(), { name, id, deviceIfs });
    };
    for (const d of sb.devices) addDevice(d.name, d.id, d.deviceIfs || []);

    const usedNames = new Set(index.keys());
    let planned = 0;
    for (const item of devices) {
      const type = pickType(types, item.type);
      if (!type) {
        errors.push(`未知型号 ${item.type}`);
        continue;
      }
      if (!type.available) {
        errors.push(`型号 ${type.displayName} 当前不可用`);
        continue;
      }
      let name = String(item.name || '').trim();
      if (!name) {
        const base = type.displayName || type.name;
        let n = 1;
        while (usedNames.has(`${base}-${n}`.toUpperCase())) n += 1;
        name = `${base}-${n}`;
      } else if (usedNames.has(name.toUpperCase())) {
        errors.push(`设备名重复：${name}`);
        continue;
      }
      usedNames.add(name.toUpperCase());
      addDevice(name, null, buildInterfaces(type));
      planned += 1;
    }

    if (sb.maxVms && sb.devices.length + planned > sb.maxVms) {
      errors.push(`设备总数将达 ${sb.devices.length + planned}，超过上限 ${sb.maxVms}`);
    }

    const used = usedPortIds(sb);
    const plannedUsed = new Set();
    for (const l of links) {
      const left = index.get(String(l.left_device).toUpperCase());
      const right = index.get(String(l.right_device).toUpperCase());
      if (!left) {
        errors.push(`找不到设备 ${l.left_device}`);
        continue;
      }
      if (!right) {
        errors.push(`找不到设备 ${l.right_device}`);
        continue;
      }
      if (left === right) {
        errors.push(`不能自连：${left.name}`);
        continue;
      }
      const leftIf = findInterface(left, l.left_port);
      const rightIf = findInterface(right, l.right_port);
      if (!leftIf) {
        errors.push(`${left.name} 没有端口 ${l.left_port}`);
        continue;
      }
      if (!rightIf) {
        errors.push(`${right.name} 没有端口 ${l.right_port}`);
        continue;
      }
      if (!allow_management && (isManagementInterface(leftIf) || isManagementInterface(rightIf))) {
        errors.push(`管理/无线口默认禁止连线：${left.name}:${leftIf.name} <-> ${right.name}:${rightIf.name}`);
        continue;
      }
      const lk = `${left.name.toUpperCase()}|${normalizePort(leftIf.name)}`;
      const rk = `${right.name.toUpperCase()}|${normalizePort(rightIf.name)}`;
      if ((leftIf.id && used.has(leftIf.id)) || plannedUsed.has(lk)) {
        errors.push(`端口已被占用：${left.name}:${leftIf.name}`);
      }
      if ((rightIf.id && used.has(rightIf.id)) || plannedUsed.has(rk)) {
        errors.push(`端口已被占用：${right.name}:${rightIf.name}`);
      }
      plannedUsed.add(lk);
      plannedUsed.add(rk);
    }

    return reply({
      ok: errors.length === 0,
      errors,
      summary: {
        existingDevices: sb.devices.length,
        plannedDevices: planned,
        checkedLinks: links.length,
      },
    });
  }
);

server.registerTool(
  'start_devices',
  {
    title: '启动设备',
    description: '启动沙箱内指定设备，设备会真正拉起虚拟机。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_names: z.array(z.string()).min(1).describe('要启动的设备名列表'),
    },
  },
  async ({ sandbox_id, device_names }) => {
    const sb = await loadSandbox(sandbox_id);
    const targets = device_names.map((name) => pickDevice(sb, name));
    const result = await call('POST', '/service/ensp/device/batchStart', {
      deviceIds: targets.map((d) => d.id),
      sandboxId: sandbox_id,
    });
    return reply({ started: targets.map((d) => d.name), response: result });
  }
);

const READY_STATUS = new Set([1, 4]);

function deviceState(d) {
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    displayStatus: d.displayStatus,
    ready: READY_STATUS.has(d.status),
  };
}

async function controlDevices(sandbox_id, device_names, api, action) {
  const sb = await loadSandbox(sandbox_id);
  const targets = device_names.map((name) => pickDevice(sb, name));
  const result = await call('POST', `/service/ensp/device/${api}`, {
    deviceIds: targets.map((d) => d.id),
    sandboxId: sandbox_id,
  });
  return { done: targets.map((d) => d.name), action, response: result };
}

server.registerTool(
  'stop_devices',
  {
    title: '停止设备',
    description: '关闭沙箱内指定设备，释放虚拟机资源。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_names: z.array(z.string()).min(1).describe('要停止的设备名列表'),
    },
  },
  async ({ sandbox_id, device_names }) => {
    return reply(await controlDevices(sandbox_id, device_names, 'batchStop', 'stop'));
  }
);

server.registerTool(
  'reboot_devices',
  {
    title: '重启设备',
    description: '重启沙箱内指定设备，适合配置异常后恢复。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_names: z.array(z.string()).min(1).describe('要重启的设备名列表'),
    },
  },
  async ({ sandbox_id, device_names }) => {
    try {
      return reply(await controlDevices(sandbox_id, device_names, 'batchReboot', 'reboot'));
    } catch (e) {
      // 部分终端型号不支持 batchReboot（返回 405），退化为停止后启动
      if (!/HTTP 405/.test(String(e && e.message))) throw e;
      await controlDevices(sandbox_id, device_names, 'batchStop', 'stop');
      await new Promise((r) => setTimeout(r, 2000));
      const started = await controlDevices(sandbox_id, device_names, 'batchStart', 'start');
      return reply({ done: device_names, action: 'stop+start', response: started.response });
    }
  }
);

server.registerTool(
  'delete_devices',
  {
    title: '删除设备',
    description: '从拓扑中删除指定设备，同时清理其连线。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_names: z.array(z.string()).min(1).describe('要删除的设备名列表'),
    },
  },
  async ({ sandbox_id, device_names }) => {
    const sb = await loadSandbox(sandbox_id);
    const targets = device_names.map((name) => pickDevice(sb, name));
    const result = await call('POST', '/service/ensp/device/batchDelete', {
      deviceIds: targets.map((d) => d.id),
      sandboxId: sandbox_id,
    });
    const after = await loadSandbox(sandbox_id);
    return reply({
      deleted: targets.map((d) => d.name),
      response: result,
      remaining: after.devices.map((d) => d.name),
      links: after.links.length,
    });
  }
);

server.registerTool(
  'delete_link',
  {
    title: '删除连线',
    description: '按连线 ID 或两端设备端口删除一条连线。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      link_id: z.number().int().optional().describe('连线 ID，优先使用'),
      left_device: z.string().optional().describe('左侧设备名'),
      left_port: z.string().optional().describe('左侧端口名'),
      right_device: z.string().optional().describe('右侧设备名'),
      right_port: z.string().optional().describe('右侧端口名'),
    },
  },
  async ({ sandbox_id, link_id, left_device, left_port, right_device, right_port }) => {
    const sb = await loadSandbox(sandbox_id);
    let target = null;
    if (link_id !== undefined) {
      target = sb.links.find((l) => Number(l.id) === Number(link_id));
    } else if (left_device && left_port && right_device && right_port) {
      const left = pickDevice(sb, left_device);
      const right = pickDevice(sb, right_device);
      const leftIf = (left.deviceIfs || []).find((i) => i.name === left_port);
      const rightIf = (right.deviceIfs || []).find((i) => i.name === right_port);
      if (!leftIf) throw new Error(`${left.name} 没有端口 ${left_port}`);
      if (!rightIf) throw new Error(`${right.name} 没有端口 ${right_port}`);
      target = sb.links.find(
        (l) =>
          (Number(l.leftDeviceId) === Number(left.id) && Number(l.leftIfId) === Number(leftIf.id) &&
            Number(l.rightDeviceId) === Number(right.id) && Number(l.rightIfId) === Number(rightIf.id)) ||
          (Number(l.leftDeviceId) === Number(right.id) && Number(l.leftIfId) === Number(rightIf.id) &&
            Number(l.rightDeviceId) === Number(left.id) && Number(l.rightIfId) === Number(leftIf.id))
      );
    }
    if (!target) throw new Error('找不到匹配的连线，请先用 get_sandbox 查看链接 ID');

    const result = await call('POST', '/service/ensp/link/deleteLink', { linkId: target.id });
    const after = await loadSandbox(sandbox_id);
    return reply({ deleted: target.id, response: result, remaining_links: after.links.length });
  }
);

server.registerTool(
  'get_device_status',
  {
    title: '查看设备状态',
    description: '查看沙箱内设备运行状态；ready 表示设备已真正就绪，可登录控制台。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_names: z.array(z.string()).optional().describe('只关注这些设备，省略则返回全部'),
    },
  },
  async ({ sandbox_id, device_names }) => {
    const sb = await loadSandbox(sandbox_id);
    const list = device_names
      ? device_names.map((name) => pickDevice(sb, name))
      : sb.devices;
    return reply(list.map(deviceState));
  }
);

server.registerTool(
  'wait_devices_ready',
  {
    title: '等待设备就绪',
    description:
      '轮询设备状态直到全部就绪或超时。超时会返回 pending 列表，可再次调用继续等待。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_names: z.array(z.string()).optional().describe('要等待的设备，省略则等待全部'),
      timeout_seconds: z.number().int().optional().describe('单次最长等待秒数，默认 45，上限 50；未就绪返回 pending，可再次调用'),
      interval_seconds: z.number().int().optional().describe('轮询间隔秒数，默认 5'),
      auto_restart: z.boolean().optional().describe('对卡死在 status=6 的设备是否自动 stop+start 重启，默认 true'),
      restart_after_seconds: z.number().int().optional().describe('设备卡在 status=6 超过多少秒后触发重启，默认 15，下限 5'),
      max_restarts: z.number().int().optional().describe('单台设备最多自动重启次数，默认 1'),
    },
  },
  async ({ sandbox_id, device_names, timeout_seconds, interval_seconds, auto_restart, restart_after_seconds, max_restarts }) => {
    const timeoutMs = Math.min(timeout_seconds || 45, 50) * 1000;
    const intervalMs = Math.max(interval_seconds || 5, 2) * 1000;
    const doAutoRestart = auto_restart !== false;
    const restartAfterMs = Math.max(restart_after_seconds || 15, 5) * 1000;
    const maxRestarts = Math.max(max_restarts || 1, 0);
    const started = Date.now();
    let names = device_names;
    let states = [];
    const stuckSince = new Map();
    const restartCount = new Map();
    const restarts = [];

    while (true) {
      const sb = await loadSandbox(sandbox_id);
      const list = names ? names.map((name) => pickDevice(sb, name)) : sb.devices;
      states = list.map(deviceState);
      const pending = states.filter((d) => !d.ready);
      if (pending.length === 0) {
        return reply({
          all_ready: true,
          waited_seconds: Math.round((Date.now() - started) / 1000),
          restarts,
          devices: states,
        });
      }

      // 自动重启卡死（status=6）的设备：先 stop 再 start，避免一直挂在启动中
      if (doAutoRestart && maxRestarts > 0) {
        for (const d of pending) {
          if (d.status !== 6) {
            stuckSince.delete(d.name);
            continue;
          }
          if (!stuckSince.has(d.name)) stuckSince.set(d.name, Date.now());
          const done = restartCount.get(d.name) || 0;
          if (Date.now() - stuckSince.get(d.name) > restartAfterMs && done < maxRestarts) {
            try {
              const dev = pickDevice(sb, d.name);
              await call('POST', '/service/ensp/device/batchStop', { deviceIds: [dev.id], sandboxId: sandbox_id });
              await new Promise((r) => setTimeout(r, 2500));
              await call('POST', '/service/ensp/device/batchStart', { deviceIds: [dev.id], sandboxId: sandbox_id });
              restartCount.set(d.name, done + 1);
              stuckSince.set(d.name, Date.now());
              restarts.push({ device: d.name, attempt: done + 1, at: new Date().toISOString() });
            } catch (e) {
              restarts.push({ device: d.name, error: String((e && e.message) || e) });
            }
          }
        }
      }

      if (Date.now() - started + intervalMs > timeoutMs) {
        return reply({
          all_ready: false,
          waited_seconds: Math.round((Date.now() - started) / 1000),
          pending: pending.map((d) => d.name),
          restarts,
          devices: states,
        });
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
);

async function resolveDevice(sandbox_id, device_name) {
  const sb = await loadSandbox(sandbox_id);
  const dev = pickDevice(sb, device_name);
  if (dev.status === 0 || dev.status === 11) {
    throw new Error(`设备 ${dev.name} 未启动（status=${dev.status}），请先调用 start_devices`);
  }
  if (dev.status === 14 || dev.status === 17) {
    throw new Error(`设备 ${dev.name} 已删除或已丢失（status=${dev.status}）`);
  }
  return dev;
}

server.registerTool(
  'console_open',
  {
    title: '打开设备控制台',
    description:
      '建立设备控制台会话并立即返回，不等待设备启动。设备启动后用 console_wait_ready 等待提示符，它会自动处理回车、首次设置密码和登录。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_name: z.string().describe('设备名，如 AR-1'),
      password: z.string().optional().describe('控制台密码，默认 Admin@123'),
      timeout_seconds: z
        .number()
        .int()
        .optional()
        .describe('本次顺便等待就绪的秒数，默认 0 表示只建立连接'),
    },
  },
  async ({ sandbox_id, device_name, password, timeout_seconds }) => {
    const dev = await resolveDevice(sandbox_id, device_name);
    const result = await consoleCall({
      action: 'open',
      sandboxId: sandbox_id,
      deviceId: dev.id,
      password: password || 'Admin@123',
      timeoutMs: (timeout_seconds || 0) * 1000,
    });
    return reply({ device: dev.name, ...result });
  }
);

server.registerTool(
  'console_wait_ready',
  {
    title: '等待控制台就绪',
    description:
      '等待设备控制台出现命令提示符，自动处理启动回车、首次设置密码、登录和“设备未就绪”提示。单次最多 50 秒，未就绪可再次调用。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_name: z.string().describe('设备名，如 AR-1'),
      password: z.string().optional().describe('控制台密码，默认 Admin@123'),
      timeout_seconds: z
        .number()
        .int()
        .optional()
        .describe('本次等待秒数，默认 40，最大 40'),
    },
  },
  async ({ sandbox_id, device_name, password, timeout_seconds }) => {
    const dev = await resolveDevice(sandbox_id, device_name);
    const seconds = Math.max(1, Math.min(timeout_seconds || 40, 40));
    const result = await consoleCall({
      action: 'wait',
      sandboxId: sandbox_id,
      deviceId: dev.id,
      password: password || 'Admin@123',
      timeoutMs: seconds * 1000,
    });
    return reply({ device: dev.name, ...result });
  }
);

server.registerTool(
  'console_write',
  {
    title: '发送终端输入',
    description: '向已打开的设备控制台发送原始输入；enter=true 时自动补回车。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_name: z.string().describe('设备名'),
      data: z.string().describe('要发送的内容'),
      enter: z.boolean().optional().describe('是否自动补回车，默认 true'),
    },
  },
  async ({ sandbox_id, device_name, data, enter }) => {
    const dev = await resolveDevice(sandbox_id, device_name);
    const result = await consoleCall({
      action: 'write',
      sandboxId: sandbox_id,
      deviceId: dev.id,
      data,
      enter: enter !== false,
    });
    return reply({ device: dev.name, ...result });
  }
);

server.registerTool(
  'console_read',
  {
    title: '读取终端输出',
    description: '读取自上次读取以来的新增终端输出；reset=true 时先清空游标。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_name: z.string().describe('设备名'),
      reset: z.boolean().optional().describe('是否从当前位置重新开始，默认 false'),
    },
  },
  async ({ sandbox_id, device_name, reset }) => {
    const dev = await resolveDevice(sandbox_id, device_name);
    const result = await consoleCall({
      action: 'read',
      sandboxId: sandbox_id,
      deviceId: dev.id,
      reset: reset === true,
    });
    return reply({ device: dev.name, ...result });
  }
);

server.registerTool(
  'console_execute',
  {
    title: '执行命令并等待结果',
    description: '在已打开的控制台会话里按顺序执行命令，等待回显稳定后返回输出。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_name: z.string().describe('设备名，如 AR-1'),
      commands: z.array(z.string()).min(1).describe('按顺序执行的命令'),
      timeout_seconds: z.number().int().optional().describe('等待输出的秒数，默认 20'),
      auto_confirm: z.boolean().optional().describe('遇到 [Y/N]/[Y/N/C] 等确认提示时是否自动应答，默认 true'),
      confirm_answer: z.string().optional().describe('自动应答的内容，默认 Y'),
    },
  },
  async ({ sandbox_id, device_name, commands, timeout_seconds, auto_confirm, confirm_answer }) => {
    const dev = await resolveDevice(sandbox_id, device_name);
    const result = await consoleCall({
      action: 'execute',
      sandboxId: sandbox_id,
      deviceId: dev.id,
      commands,
      timeoutMs: (timeout_seconds || 20) * 1000,
      auto_confirm: auto_confirm !== false,
      confirm_answer: confirm_answer || 'Y',
    });
    return reply({ device: dev.name, ...result });
  }
);

server.registerTool(
  'console_close',
  {
    title: '关闭设备控制台',
    description: '关闭并释放设备控制台会话。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_name: z.string().describe('设备名'),
    },
  },
  async ({ sandbox_id, device_name }) => {
    const sb = await loadSandbox(sandbox_id);
    const dev = pickDevice(sb, device_name);
    const result = await consoleCall({
      action: 'close',
      sandboxId: sandbox_id,
      deviceId: dev.id,
    });
    return reply({ device: dev.name, ...result });
  }
);

server.registerTool(
  'create_sandbox',
  {
    title: '新建沙箱',
    description: '创建新沙箱用于做实验，返回新沙箱 ID，后续拓扑操作都用这个 ID。',
    inputSchema: {
      name: z.string().describe('沙箱名称，2~50 位字母数字或中文'),
      max_vms: z.number().int().optional().describe('最大设备数，默认 1'),
      keep_time: z.number().int().optional().describe('保留时长（分钟），默认 0'),
      is_public: z.boolean().optional().describe('是否公开，默认 false'),
      project_id: z.number().int().optional().describe('所属项目 ID，省略则自动取当前用户默认项目'),
    },
  },
  async ({ name, max_vms, keep_time, is_public, project_id }) => {
    let projectId = project_id;
    if (projectId === undefined) {
      const user = await call('GET', '/api/getUserInfo');
      projectId = Number((user.data && user.data.projectId) || 1);
    }
    const created = await call('POST', '/service/ensp/sandbox/create', {
      id: '',
      name,
      isPublic: is_public ? 1 : 0,
      maxVms: max_vms ?? 1,
      keepTime: keep_time ?? 0,
      type: 0,
      projectId,
    });
    return reply({ sandbox: created.data || created });
  }
);

server.registerTool(
  'delete_sandbox',
  {
    title: '删除沙箱',
    description: '删除一个或多个沙箱；删除前建议先调用 stop_devices 释放设备资源。',
    inputSchema: {
      sandbox_ids: z.array(z.number().int()).min(1).describe('要删除的沙箱 ID 列表'),
    },
  },
  async ({ sandbox_ids }) => {
    const result = await call('POST', '/service/ensp/sandbox/batchDeleteSandbox', {
      sandboxIds: sandbox_ids,
    });
    return reply({ deleted: sandbox_ids, response: result });
  }
);

server.registerTool(
  'move_device',
  {
    title: '移动设备位置',
    description: '调整设备在拓扑画布上的位置，坐标为 -0.5~0.5 的相对值。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_name: z.string().describe('设备名'),
      x: z.number().describe('横向位置，-0.5~0.5'),
      y: z.number().describe('纵向位置，-0.5~0.5'),
    },
  },
  async ({ sandbox_id, device_name, x, y }) => {
    const sb = await loadSandbox(sandbox_id);
    const dev = pickDevice(sb, device_name);
    const result = await call('POST', '/service/ensp/device/modifyComponent', {
      id: sandbox_id,
      devices: [
        {
          id: dev.id,
          devicePosition: { positionX: clamp(x, -0.5, 0.5), positionY: clamp(y, -0.5, 0.5) },
        },
      ],
    });
    return reply({ device: dev.name, position: { x, y }, response: result });
  }
);

server.registerTool(
  'ws_diagnostics',
  {
    title: 'WebSocket 诊断',
    description:
      '统计当前 eNSP 页面的 WebSocket 连接、控制台会话和标签页数量，区分 MCP 控制台连接与页面自身连接。页面需刷新一次以启用统计。',
    inputSchema: {},
  },
  async () => {
    return reply(await consoleCall({ action: 'diag' }));
  }
);

server.registerTool(
  'run_commands',
  {
    title: '批量执行命令',
    description:
      '在多台已启动设备上并行执行同一组命令，自动打开控制台并返回每台设备的回显。可用于批量配置、巡检、导出现网配置。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      device_names: z.array(z.string()).min(1).describe('目标设备名列表'),
      commands: z.array(z.string()).min(1).describe('要执行的命令，按顺序'),
      timeout_seconds: z.number().int().optional().describe('每台设备等待输出的秒数，默认 20'),
      auto_confirm: z
        .boolean()
        .optional()
        .describe('遇到 [Y/N]/[Y/N/C] 等确认提示时是否自动应答，默认 true；关闭后保持原有行为（提示会被误判为提示符导致后续命令错位）'),
      confirm_answer: z.string().optional().describe('自动应答的内容，默认 Y'),
    },
  },
  async ({ sandbox_id, device_names, commands, timeout_seconds, auto_confirm, confirm_answer }) => {
    const perDeviceMs = (timeout_seconds || 20) * 1000;
    const results = await Promise.all(
      device_names.map(async (name) => {
        try {
          const dev = await resolveDevice(sandbox_id, name);
          await consoleCall({
            action: 'open',
            sandboxId: sandbox_id,
            deviceId: dev.id,
            password: 'Admin@123',
            timeoutMs: 0,
          });
          const ready = await consoleCall({
            action: 'wait',
            sandboxId: sandbox_id,
            deviceId: dev.id,
            password: 'Admin@123',
            timeoutMs: Math.min(perDeviceMs, 30000),
          });
          if (!ready.ready) {
            return {
              device: name,
              ok: false,
              error: ready.error || '控制台未就绪',
              tail: ready.tail,
            };
          }
          const out = await consoleCall({
            action: 'execute',
            sandboxId: sandbox_id,
            deviceId: dev.id,
            commands,
            timeoutMs: perDeviceMs,
            auto_confirm: auto_confirm !== false,
            confirm_answer: confirm_answer || 'Y',
          });
          return { device: name, ok: true, ...out };
        } catch (e) {
          return { device: name, ok: false, error: String((e && e.message) || e) };
        }
      })
    );
    return reply(results);
  }
);

// ----- 拓扑标注工具：图元（直线/矩形/椭圆）与文本的增删改查 -----
server.registerTool(
  'list_graphics',
  {
    title: '列出拓扑标注',
    description:
      '列出沙箱拓扑画布上的所有标注图元（直线/矩形/椭圆）和文本框，返回它们的 id、类型、位置与样式，便于后续修改或删除。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID，可先调用 get_sandboxes 获取'),
    },
  },
  async ({ sandbox_id }) => {
    const topo = await loadTopology(sandbox_id);
    const graphics = topo.graphics.map((g) => {
      const kind = TYPE_TO_NAME[g.type] || String(g.type);
      const out = {
        id: g.id,
        kind,
        type: g.type,
        coverLevel: g.coverLevel,
        color: g.color,
        boardStyle: g.boardStyle,
        boardWidth: g.boardWidth,
        isFill: g.isFill,
      };
      if (g.type === 0) Object.assign(out, { x1: g.leftX, y1: g.leftY, x2: g.rightX, y2: g.rightY });
      else if (g.type === 2) Object.assign(out, { x: g.positionX, y: g.positionY, width: g.width, height: g.height });
      else if (g.type === 1)
        Object.assign(out, {
          x: g.positionX,
          y: g.positionY,
          width: (g.horizontalLength || 0) * 2,
          height: (g.verticalLength || 0) * 2,
        });
      return out;
    });
    const texts = topo.textBoxes.map((t) => ({
      id: t.id,
      x: t.positionX,
      y: t.positionY,
      content: t.content,
      fontSize: t.fontSize,
      fontColor: t.fontColor,
      backgroundColor: t.backgroundColor,
    }));
    return reply({ sandbox_id, graphics, texts });
  }
);

server.registerTool(
  'add_graphics',
  {
    title: '添加标注图元',
    description:
      '在拓扑画布上批量添加直线、矩形或椭圆，用于区域划分与标注。位置坐标为 0~1 归一化值（左上 0,0 → 右下 1,1），宽高为像素。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      items: z
        .array(
          z.object({
            kind: z.string().describe('图元类型：line（直线）/ rectangle（矩形）/ ellipse（椭圆）'),
            x1: z.number().optional().describe('直线起点横坐标，0~1（仅 line）'),
            y1: z.number().optional().describe('直线起点纵坐标，0~1（仅 line）'),
            x2: z.number().optional().describe('直线终点横坐标，0~1（仅 line）'),
            y2: z.number().optional().describe('直线终点纵坐标，0~1（仅 line）'),
            x: z.number().optional().describe('矩形/椭圆中心横坐标，0~1'),
            y: z.number().optional().describe('矩形/椭圆中心纵坐标，0~1'),
            width: z.number().optional().describe('矩形/椭圆宽度，像素（正数）'),
            height: z.number().optional().describe('矩形/椭圆高度，像素（正数）'),
            color: z.string().optional().describe('填充/线条颜色，如 "#1e90ff"，默认 #C6DEF7'),
            board_style: z.string().optional().describe('边框样式：solid/dash/dot/dashdot/dashdotdot，默认 solid'),
            board_width: z.number().int().optional().describe('边框粗细 1~10，默认 1'),
            fill: z.boolean().optional().describe('是否填充，默认 true'),
          })
        )
        .min(1)
        .describe('要添加的图元列表，可混合不同类型'),
    },
  },
  async ({ sandbox_id, items }) => {
    const topo = await loadTopology(sandbox_id);
    let cover = topo.graphics.length;
    const vos = items.map((it) => buildCreateGraphic(it.kind, it, sandbox_id, cover++));
    const resp = await call('POST', '/service/ensp/graphics/createGraphics', {
      sandboxId: sandbox_id,
      graphics: vos,
    });
    const created = (resp.data || []).map((g) => ({ id: g.id, kind: TYPE_TO_NAME[g.type], type: g.type }));
    return reply({ sandbox_id, created, response: resp });
  }
);

server.registerTool(
  'add_text',
  {
    title: '添加文本标注',
    description: '在拓扑画布上添加一个文本框，用于标注说明。位置为 0~1 归一化坐标，内容长度 1~255。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      x: z.number().describe('文本横坐标，0~1'),
      y: z.number().describe('文本纵坐标，0~1'),
      content: z.string().min(1).max(255).describe('文本内容，1~255 字符'),
      font_size: z.number().int().optional().describe('字号 8~20，默认 14'),
      font_color: z.string().optional().describe('字体颜色，默认 #000000'),
      background_color: z.string().optional().describe('背景颜色，默认 #90EE90'),
    },
  },
  async ({ sandbox_id, x, y, content, font_size, font_color, background_color }) => {
    const body = {
      positionX: clamp01(x, 'x'),
      positionY: clamp01(y, 'y'),
      content,
      fontSize: font_size === undefined ? TEXT_DEFAULTS.fontSize : clamp(font_size, 8, 20),
      fontColor: font_color || TEXT_DEFAULTS.fontColor,
      backgroundColor: background_color || TEXT_DEFAULTS.backgroundColor,
      sandboxId: sandbox_id,
    };
    const resp = await call('POST', '/service/ensp/textBox/createTextBox', body);
    const d = resp.data || {};
    return reply({
      sandbox_id,
      created: { id: d.id, content: d.content, x: d.positionX, y: d.positionY },
      response: resp,
    });
  }
);

server.registerTool(
  'update_graphic',
  {
    title: '修改标注图元',
    description:
      '修改已有图元的位置、尺寸或样式。图元 id 按类型独立编号，需同时指定 kind 与 graphic_id；只传要改的字段即可。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      kind: z.string().describe('图元类型：line / rectangle / ellipse'),
      graphic_id: z.number().int().describe('图元 id（与 kind 共同定位，可从 list_graphics 获取）'),
      x1: z.number().optional(),
      y1: z.number().optional(),
      x2: z.number().optional(),
      y2: z.number().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      color: z.string().optional(),
      board_style: z.string().optional(),
      board_width: z.number().int().optional(),
      fill: z.boolean().optional(),
    },
  },
  async (args) => {
    const { sandbox_id, kind, graphic_id } = args;
    const typeValue = graphicTypeValue(kind);
    const topo = await loadTopology(sandbox_id);
    const cur = findGraphic(topo, typeValue, graphic_id);
    const next = { ...cur };
    if (args.color !== undefined) next.color = args.color;
    if (args.board_style !== undefined) next.boardStyle = resolveBoardStyle(args.board_style);
    if (args.board_width !== undefined) next.boardWidth = clamp(args.board_width, 1, 10);
    if (args.fill !== undefined) next.isFill = Boolean(args.fill);
    if (typeValue === 0) {
      if (args.x1 !== undefined) next.leftX = clamp01(args.x1, 'x1');
      if (args.y1 !== undefined) next.leftY = clamp01(args.y1, 'y1');
      if (args.x2 !== undefined) next.rightX = clamp01(args.x2, 'x2');
      if (args.y2 !== undefined) next.rightY = clamp01(args.y2, 'y2');
    } else if (typeValue === 2) {
      if (args.x !== undefined) next.positionX = clamp01(args.x, 'x');
      if (args.y !== undefined) next.positionY = clamp01(args.y, 'y');
      if (args.width !== undefined) {
        if (args.width <= 0) throw new Error('width 必须为正数（像素）');
        next.width = args.width;
      }
      if (args.height !== undefined) {
        if (args.height <= 0) throw new Error('height 必须为正数（像素）');
        next.height = args.height;
      }
    } else {
      if (args.x !== undefined) next.positionX = clamp01(args.x, 'x');
      if (args.y !== undefined) next.positionY = clamp01(args.y, 'y');
      if (args.width !== undefined) {
        if (args.width <= 0) throw new Error('width 必须为正数（像素）');
        next.horizontalLength = args.width / 2;
      }
      if (args.height !== undefined) {
        if (args.height <= 0) throw new Error('height 必须为正数（像素）');
        next.verticalLength = args.height / 2;
      }
    }
    // update 接口必须带 nodeId / nodeType，否则后端返回 50020008 非法操作
    next.nodeId = `${NODE_TYPE_BY_KIND[kind]}-${cur.id}`;
    next.nodeType = NODE_TYPE_BY_KIND[kind];
    const resp = await call('POST', '/service/ensp/graphics/updateGraphics', {
      sandboxId: sandbox_id,
      graphics: [next],
    });
    return reply({ sandbox_id, updated: { id: cur.id, kind }, response: resp });
  }
);

server.registerTool(
  'update_text',
  {
    title: '修改文本标注',
    description: '修改已有文本框的位置、内容或样式。只传要改的字段即可；字号会被限制在 8~20。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      text_id: z.number().int().describe('文本 id，可从 list_graphics 获取'),
      x: z.number().optional(),
      y: z.number().optional(),
      content: z.string().min(1).max(255).optional(),
      font_size: z.number().int().optional(),
      font_color: z.string().optional(),
      background_color: z.string().optional(),
    },
  },
  async (args) => {
    const { sandbox_id, text_id } = args;
    const topo = await loadTopology(sandbox_id);
    const cur = findText(topo, text_id);
    const next = { ...cur };
    if (args.x !== undefined) next.positionX = clamp01(args.x, 'x');
    if (args.y !== undefined) next.positionY = clamp01(args.y, 'y');
    if (args.content !== undefined) next.content = args.content;
    if (args.font_size !== undefined) next.fontSize = clamp(args.font_size, 8, 20);
    if (args.font_color !== undefined) next.fontColor = args.font_color;
    if (args.background_color !== undefined) next.backgroundColor = args.background_color;
    next.nodeId = `text-${cur.id}`;
    const resp = await call('POST', '/service/ensp/textBox/updateTextBox', {
      sandboxId: sandbox_id,
      textBoxes: [next],
    });
    return reply({ sandbox_id, updated: { id: cur.id }, response: resp });
  }
);

server.registerTool(
  'delete_graphics',
  {
    title: '删除标注图元',
    description: '删除一个或多个标注图元。图元 id 按类型独立编号，需同时指定 kind 与 id。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      items: z
        .array(
          z.object({
            kind: z.string().describe('图元类型：line / rectangle / ellipse'),
            id: z.number().int().describe('图元 id'),
          })
        )
        .min(1),
    },
  },
  async ({ sandbox_id, items }) => {
    const topo = await loadTopology(sandbox_id);
    const vos = items.map((it) => {
      const typeValue = graphicTypeValue(it.kind);
      const cur = findGraphic(topo, typeValue, it.id);
      return { id: cur.id, type: cur.type, sandboxId: sandbox_id, coverLevel: cur.coverLevel };
    });
    const resp = await call('POST', '/service/ensp/graphics/deleteGraphics', { graphicsVOs: vos });
    return reply({
      sandbox_id,
      deleted: items.map((i) => ({ kind: i.kind, id: i.id })),
      response: resp,
    });
  }
);

server.registerTool(
  'delete_texts',
  {
    title: '删除文本标注',
    description: '删除一个或多个文本标注。',
    inputSchema: {
      sandbox_id: z.number().int().describe('沙箱 ID'),
      text_ids: z.array(z.number().int()).min(1).describe('要删除的文本 id 列表'),
    },
  },
  async ({ sandbox_id, text_ids }) => {
    const topo = await loadTopology(sandbox_id);
    for (const id of text_ids) findText(topo, id);
    const resp = await call('POST', '/service/ensp/textBox/deleteTextBoxes', {
      textBoxIdVOList: text_ids.map((id) => ({ id })),
    });
    return reply({ sandbox_id, deleted: text_ids, response: resp });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[ensp-webmcp] MCP 已启动，桥地址 ' + BRIDGE);
// 启动即自动拉起本地桥（后台进行，不阻塞 MCP 握手）；失败则在首次工具调用时兜底重试
ensureBridge()
  .then((up) => {
    if (!up) console.error('[ensp-webmcp] 本地桥暂未就绪，首次调用时会再次尝试自动拉起');
  })
  .catch(() => {});
