#!/usr/bin/env node
/**
 * 拓扑自动标注脚本：给沙箱拓扑的每个接口标注 IP，并按区域画框。
 *
 * 用法：
 *   node scripts/annotate-topology.mjs --sandbox 15 --dry-run      # 只看计划，不写入
 *   node scripts/annotate-topology.mjs --sandbox 15 --spec plan.json
 *   node scripts/annotate-topology.mjs --sandbox 15 --clear        # 只清理已有标注
 *   node scripts/annotate-topology.mjs --help
 *
 * 数据源优先级：
 *   1) --spec 规划书（JSON）——不依赖设备开机，直接按规划值标注
 *   2) 未提供 spec 时实时采集：
 *      - 终端（PC/服务器）：get_terminal_config，无需开机
 *      - 网络设备：仅在线(status=4)时 run_commands 读取；离线则跳过并提示
 *
 * 区域框必须由 spec.zones 明确定义，脚本不擅自猜测业务分组。
 *
 * 规划书格式（JSON）：
 * {
 *   "zones": [
 *     { "name": "出口区", "shape": "rectangle", "color": "#E67E22", "devices": ["AR-1","AR-2"] }
 *   ],
 *   "devices": {
 *     "AR-1": { "interfaces": [ { "name": "GE0/0/0", "ip": "10.0.1.1/30" } ] }
 *   }
 * }
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = process.env.ENSP_BRIDGE || 'http://127.0.0.1:8790';

// ---- 画布与排版参数（与实机验证过的取值一致）----
const CANVAS_WIDTH = 1920;          // 前端设计基准宽，横向像素换算基准
const DEFAULT_CANVAS_HEIGHT = 1080; // 画布高度取不到时的兜底
const LABEL_OFFSET = 0.04;          // 标签相对设备中心的纵向起始偏移（归一化）
const LABEL_STEP = 0.024;           // 多接口标签堆叠步长（归一化）
const ZONE_PAD_X = 0.055;           // 区域框横向留白（归一化）
const ZONE_PAD_Y = 0.032;           // 区域框纵向留白（归一化）
const LABEL_BG = '#FFF9E6';
const LABEL_FG = '#222222';

// ---- 参数解析 ----
function parseArgs(argv) {
  const out = { sandbox: null, spec: null, configDir: null, dryRun: false, clear: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sandbox') out.sandbox = Number(argv[++i]);
    else if (a === '--spec') out.spec = argv[++i];
    else if (a === '--config-dir') out.configDir = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--clear') out.clear = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`拓扑自动标注脚本

用法:
  node scripts/annotate-topology.mjs --sandbox <id> [--spec <plan.json>] [--config-dir <dir>] [--dry-run] [--clear]

参数:
  --sandbox <id>   沙箱 ID（必填）
  --spec <file>    规划书 JSON 路径；提供则优先按规划值标注，不依赖设备开机
  --config-dir <dir>  本地配置目录（文件名=设备名.cfg/.txt），有则优先使用，避免开机
  --dry-run        只输出计划，不写入画布
  --clear          清理该沙箱已有的全部标注（图元+文本）后退出
  --help           显示帮助

规划书格式:
{
  "zones": [
    { "name": "出口区", "shape": "rectangle", "color": "#E67E22", "devices": ["AR-1","AR-2"] }
  ],
  "devices": {
    "AR-1": { "interfaces": [ { "name": "GE0/0/0", "ip": "10.0.1.1/30" } ] }
  }
}`);
}

// ---- 桥直连（用于读取设备坐标与画布尺寸）----
async function bridgeApi(method, apiPath) {
  const res = await fetch(BRIDGE + '/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'api', method, path: apiPath }),
  });
  const msg = JSON.parse(await res.text());
  if (msg.error) throw new Error('桥调用失败: ' + msg.error);
  return msg.json;
}

// ---- 工具函数 ----
const isTerminal = (typeName) => /PC|STA|CLIENT|SERVER|终端/i.test(String(typeName || ''));

function maskToCidr(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  const s = String(raw).trim();
  if (s.startsWith('0x')) {                            // 十六进制掩码，如 0xffffff00
    const v = parseInt(s, 16);
    let bits = 0;
    for (let i = 31; i >= 0; i--) { if ((v >>> i) & 1) bits++; else break; }
    return '/' + bits;
  }
  if (/^\d{1,2}$/.test(s)) return '/' + s;            // 已是位长
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(s)) return '';
  let bits = 0;
  for (const p of s.split('.').map(Number)) bits += (p >>> 0).toString(2).split('1').length - 1;
  return '/' + bits;
}

// display ip interface brief 解析：只保留已配置 IP 的接口
function parseNetworkIps(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})\b/);
    if (m) out.push({ name: m[1], ip: m[2] });
  }
  return out;
}

// ifconfig 解析：用于 DHCP 等运行态地址（静态配置里读不到时回落）
function parseIfconfigIps(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/inet\s+(?:addr:)?(\d{1,3}(?:\.\d{1,3}){3})/);
    if (!m || m[1].startsWith('127.')) continue;
    const nm = line.match(/netmask\s+(0x[0-9a-fA-F]+|\d{1,3}(?:\.\d{1,3}){3})/);
    out.push({ name: 'IPv4', ip: m[1] + (nm ? maskToCidr(nm[1]) : '') });
  }
  return out;
}

// 接口名缩写：GigabitEthernet0/0/0 -> GE0/0/0
function shortIfName(n) {
  return String(n)
    .replace(/^XGigabitEthernet/i, 'XGE')
    .replace(/^TenGigabitEthernet/i, 'TE')
    .replace(/^GigabitEthernet/i, 'GE')
    .replace(/^Ethernet/i, 'Eth');
}

// 解析设备配置文件中的接口 IP（interface X / ip address A MASK）
function parseCfgIps(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    const mi = line.match(/^interface\s+(\S+)/i);
    if (mi) { cur = mi[1]; continue; }
    const ma = line.match(/^\s+ip address\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})/i);
    if (ma && cur) out.push({ name: shortIfName(cur), ip: ma[1] + maskToCidr(ma[2]) });
  }
  return out;
}

// 扫描本地配置目录：文件名（去扩展名）= 设备名
function loadLocalConfigs(dir) {
  const map = {};
  if (!dir || !fs.existsSync(dir)) return map;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(cfg|txt|conf)$/i.test(f)) continue;
    const name = path.basename(f).replace(/\.[^.]+$/, '');
    try {
      const ips = parseCfgIps(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (ips.length) map[name] = ips;
    } catch (e) { /* 跳过不可读文件 */ }
  }
  return map;
}

function labelY(devY, i) {
  return devY < 0.5 ? devY - LABEL_OFFSET - i * LABEL_STEP : devY + LABEL_OFFSET + i * LABEL_STEP;
}

const clamp01 = (v) => Math.max(0.005, Math.min(0.995, v));

// 由一组设备（含其标签占用范围）计算区域框，返回中心与像素宽高
function computeZoneBox(devices, ipMap, canvas) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const d of devices) {
    minX = Math.min(minX, d.x); maxX = Math.max(maxX, d.x);
    minY = Math.min(minY, d.y); maxY = Math.max(maxY, d.y);
    const labels = ipMap[d.name] || [];
    for (let i = 0; i < labels.length; i++) {
      const ly = labelY(d.y, i);
      minY = Math.min(minY, ly); maxY = Math.max(maxY, ly);
    }
  }
  minX = clamp01(minX - ZONE_PAD_X); maxX = clamp01(maxX + ZONE_PAD_X);
  minY = clamp01(minY - ZONE_PAD_Y); maxY = clamp01(maxY + ZONE_PAD_Y);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    x: cx,
    y: cy,
    width: Math.max(320, Math.round((maxX - minX) * canvas.width)),
    height: Math.max(150, Math.round((maxY - minY) * canvas.height)),
    top: minY,
    left: minX,
  };
}

// ---- 主流程 ----
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (!args.sandbox || Number.isNaN(args.sandbox)) {
    console.error('缺少 --sandbox <id>，用 --help 查看用法');
    process.exit(1);
  }

  const spec = args.spec ? JSON.parse(fs.readFileSync(path.resolve(args.spec), 'utf8')) : null;
  const cfgDir = args.configDir ? path.resolve(args.configDir) : path.join(ROOT, 'configs');

  // 1) 连接 MCP
  const transport = new StdioClientTransport({ command: 'node', args: ['mcp/server.js'], cwd: ROOT });
  const client = new Client({ name: 'annotate-topology', version: '1.0.0' });
  await client.connect(transport);
  const call = async (name, params) => {
    const r = await client.callTool({ name, arguments: params });
    const text = (r.content && r.content[0] && r.content[0].text) || '';
    if (r.isError) throw new Error(`${name} 失败: ${String(text).slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  };

  try {
    // 2) 读拓扑（MCP 拿设备/类型/在线状态，桥补设备坐标）
    const topo = await call('get_sandbox', { sandbox_id: args.sandbox });
    const raw = await bridgeApi('GET', `/service/ensp/sandbox/getOneSandbox?sandboxId=${args.sandbox}`);
    const rawSb = (raw && raw.data) || {};
    const canvas = {
      width: CANVAS_WIDTH,
      height: rawSb.height || rawSb.canvasHeight || DEFAULT_CANVAS_HEIGHT,
    };

    const posOf = new Map((rawSb.devices || []).map((d) => [d.name, d.devicePosition || {}]));
    const devices = (topo.devices || []).map((d) => {
      const p = posOf.get(d.name) || {};
      return {
        name: d.name,
        type: d.type,
        status: d.status,
        online: d.status === 4,
        x: clamp01((p.positionX ?? 0) + 0.5),
        y: clamp01((p.positionY ?? 0) + 0.5),
      };
    });
    const byName = new Map(devices.map((d) => [d.name, d]));
    // 终端通常只有一个网口，用其第一个接口名作为标签前缀
    const ifaceOf = new Map((topo.devices || []).map((d) => [d.name, (d.interfaces || [])[0]?.name]));

    // 3) 仅清理
    if (args.clear) {
      const cur = await call('list_graphics', { sandbox_id: args.sandbox });
      if (cur.texts && cur.texts.length) {
        await call('delete_texts', { sandbox_id: args.sandbox, text_ids: cur.texts.map((t) => t.id) });
      }
      if (cur.graphics && cur.graphics.length) {
        await call('delete_graphics', {
          sandbox_id: args.sandbox,
          items: cur.graphics.map((g) => ({ kind: g.kind, id: g.id })),
        });
      }
      console.log(`已清理：图元 ${cur.graphics?.length || 0} 个、文本 ${cur.texts?.length || 0} 个`);
      return;
    }

    // 4) 取接口 IP：本地记录优先（规划书 > 本地配置目录），缺失的再按需读取
    const ipMap = {};    // deviceName -> [{name, ip}]
    const sourceOf = {}; // deviceName -> 数据来源
    const skipped = [];
    const localCfg = loadLocalConfigs(cfgDir);
    const specDevs = (spec && spec.devices) || {};
    console.log(`本地配置目录：${cfgDir}${fs.existsSync(cfgDir) ? '（已发现）' : '（不存在，跳过）'}`);

    for (const d of devices) {
      // 4.1 规划书优先
      if (specDevs[d.name]) {
        const ips = (specDevs[d.name].interfaces || []).filter((i) => i && i.ip).map((i) => ({ name: i.name || '', ip: i.ip }));
        if (ips.length) { ipMap[d.name] = ips; sourceOf[d.name] = '规划书'; continue; }
      }
      // 4.2 本地配置文件
      if (localCfg[d.name] && localCfg[d.name].length) {
        ipMap[d.name] = localCfg[d.name];
        sourceOf[d.name] = '本地配置';
        continue;
      }
      // 4.3 终端属性（不开机即可读）
      if (isTerminal(d.type)) {
        let got = [];
        try {
          const r = await call('get_terminal_config', { sandbox_id: args.sandbox, device_name: d.name });
          const cfg = r.config || {};
          const ip = cfg['ipv4.config.ip'];
          if (ip) {
            const cidr = maskToCidr(cfg['ipv4.config.ipmask'] ?? cfg['ipv4.config.mask'] ?? cfg['ipv4.config.netmask']);
            got = [{ name: 'IPv4', ip: ip + cidr }];
          }
        } catch (e) { /* 静态配置不可读时继续尝试运行态 */ }
        // 静态配置为空（典型为 DHCP 客户端）且设备在线时，读运行态
        if (!got.length && d.online) {
          try {
            const r = await call('run_commands', {
              sandbox_id: args.sandbox,
              device_names: [d.name],
              commands: ['ifconfig'],
              timeout_seconds: 30,
            });
            const out = Array.isArray(r) ? r[0] : r;
            got = parseIfconfigIps(out && (out.output || out.tail));
          } catch (e) { /* 读不到就保持空 */ }
        }
        ipMap[d.name] = got.map((g) => ({ name: ifaceOf.get(d.name) || g.name, ip: g.ip }));
        if (got.length) sourceOf[d.name] = '终端属性';
        else skipped.push(`${d.name}(无IP)`);
        continue;
      }
      // 4.4 网络设备：仅在线时读取
      if (!d.online) { skipped.push(`${d.name}(未开机且无本地记录)`); ipMap[d.name] = []; continue; }
      try {
        const r = await call('run_commands', {
          sandbox_id: args.sandbox,
          device_names: [d.name],
          commands: ['display ip interface brief'],
          timeout_seconds: 30,
        });
        const out = Array.isArray(r) ? r[0] : r;
        ipMap[d.name] = parseNetworkIps(out && (out.output || out.tail));
        sourceOf[d.name] = '设备在线读取';
      } catch (e) {
        skipped.push(`${d.name}(命令执行失败)`);
        ipMap[d.name] = [];
      }
    }

    // 5) 组装计划
    const labels = [];
    for (const d of devices) {
      const ips = ipMap[d.name] || [];
      ips.forEach((it, i) => {
        labels.push({
          device: d.name,
          x: d.x,
          y: clamp01(labelY(d.y, i)),
          content: it.name ? `${it.name} ${it.ip}` : it.ip,
        });
      });
    }

    const zoneDefs = (spec && spec.zones) || [];
    const zones = [];
    for (const z of zoneDefs) {
      const members = (z.devices || []).map((n) => byName.get(n)).filter(Boolean);
      if (!members.length) { console.warn(`区域「${z.name}」没有匹配到设备，跳过`); continue; }
      const box = computeZoneBox(members, ipMap, canvas);
      zones.push({ ...z, shape: z.shape || 'rectangle', color: z.color || '#C6DEF7', box, members: members.map((m) => m.name) });
    }

    // 6) 输出计划
    console.log(`\n沙箱 ${args.sandbox} 画布 ${canvas.width}x${canvas.height}`);
    console.log('设备接口 IP:');
    for (const d of devices) {
      const ips = ipMap[d.name] || [];
      const src = sourceOf[d.name] ? ` [${sourceOf[d.name]}]` : '';
      console.log(`  ${d.name.padEnd(8)} (${d.x.toFixed(3)},${d.y.toFixed(3)}) ${ips.length ? ips.map((i) => `${i.name}=${i.ip}`).join(', ') : '无 IP'}${src}`);
    }
    if (skipped.length) console.log('跳过: ' + skipped.join(', '));
    console.log(`\n标签 ${labels.length} 个，区域 ${zones.length} 个`);
    for (const z of zones) {
      console.log(`  区域「${z.name}」${z.shape} ${z.box.width}x${z.box.height} 中心(${z.box.x.toFixed(3)},${z.box.y.toFixed(3)}) 成员:${z.members.join('/')}`);
    }
    if (!zoneDefs.length) console.log('  提示：未提供 spec.zones，已跳过区域框（脚本不擅自猜测业务分组）');

    if (args.dryRun) {
      console.log('\n[dry-run] 未写入画布。');
      return;
    }

    // 7) 写入：先区域形状 → 区域标题 → IP 标签
    if (zones.length) {
      const created = await call('add_graphics', {
        sandbox_id: args.sandbox,
        items: zones.map((z) => ({
          kind: z.shape,
          x: z.box.x,
          y: z.box.y,
          width: z.box.width,
          height: z.box.height,
          color: z.color,
          board_style: 'solid',
          board_width: 2,
          fill: false,
        })),
      });
      console.log(`\n已画区域框 ${created.created?.length || 0} 个`);
      for (const z of zones) {
        await call('add_text', {
          sandbox_id: args.sandbox,
          x: clamp01(z.box.left + 0.015),
          y: clamp01(z.box.top - 0.018),
          content: z.name,
          font_size: 12,
          font_color: '#FFFFFF',
          background_color: z.color,
        });
      }
      console.log(`已加区域标题 ${zones.length} 个`);
    }

    let done = 0;
    for (const l of labels) {
      await call('add_text', {
        sandbox_id: args.sandbox,
        x: l.x,
        y: l.y,
        content: l.content,
        font_size: 10,
        font_color: LABEL_FG,
        background_color: LABEL_BG,
      });
      done++;
    }
    console.log(`已加 IP 标签 ${done} 个`);

    // 8) 回读校验
    const after = await call('list_graphics', { sandbox_id: args.sandbox });
    console.log(`\n校验：画布现有图元 ${after.graphics?.length || 0} 个、文本 ${after.texts?.length || 0} 个`);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error('执行失败:', e.message || e);
  process.exit(1);
});
