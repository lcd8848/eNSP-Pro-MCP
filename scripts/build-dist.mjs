// 构建 dist 发布目录。
// 默认增量：代码目录整目录覆盖，依赖按 package-lock 指纹判断是否需要重新复制。
// 用法：
//   node scripts/build-dist.mjs            增量构建
//   node scripts/build-dist.mjs --clean    清空 dist 后重建
//   node scripts/build-dist.mjs --force-deps  强制重新复制 node_modules
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const CODE_DIRS = ['mcp', 'bridge', 'extension', 'scripts'];
const ROOT_FILES = ['package.json', 'package-lock.json', 'README.md'];

const args = new Set(process.argv.slice(2));
const clean = args.has('--clean');
const forceDeps = args.has('--force-deps');

const log = (msg) => console.log('[dist] ' + msg);
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

function countFiles(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        files += 1;
        bytes += fs.statSync(p).size;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { files, bytes };
}

function lockHash() {
  const lock = fs.readFileSync(path.join(ROOT, 'package-lock.json'));
  return crypto.createHash('sha256').update(lock).digest('hex').slice(0, 16);
}

// 1. 准备目录
if (clean) {
  log('清理旧 dist ...');
  rm(DIST);
}
fs.mkdirSync(DIST, { recursive: true });

// 2. 同步代码目录（先删后拷，避免残留已删除的源文件）
for (const dir of CODE_DIRS) {
  const src = path.join(ROOT, dir);
  if (!fs.existsSync(src)) {
    log(`跳过不存在的目录 ${dir}/`);
    continue;
  }
  rm(path.join(DIST, dir));
  fs.cpSync(src, path.join(DIST, dir), { recursive: true, force: true });
  log(`已同步 ${dir}/`);
}

// 3. 同步根清单与说明文件
for (const file of ROOT_FILES) {
  const src = path.join(ROOT, file);
  if (!fs.existsSync(src)) {
    log(`警告：缺少 ${file}，已跳过`);
    continue;
  }
  fs.copyFileSync(src, path.join(DIST, file));
  log(`已同步 ${file}`);
}

// 4. 同步依赖（按 lock 指纹判断，未变化则跳过）
const stampFile = path.join(DIST, '.deps-stamp');
const hash = lockHash();
const depsExists = fs.existsSync(path.join(DIST, 'node_modules'));
const stamped = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : '';
let depsState = '无需更新';

if (forceDeps || !depsExists || stamped !== hash) {
  const srcModules = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(srcModules)) {
    log('警告：根目录没有 node_modules，请先执行 npm install');
    process.exitCode = 1;
  } else {
    try {
      rm(path.join(DIST, 'node_modules'));
      fs.cpSync(srcModules, path.join(DIST, 'node_modules'), { recursive: true, force: true });
      fs.writeFileSync(stampFile, hash);
      depsState = '已重新复制';
      log('已同步 node_modules/');
    } catch (e) {
      depsState = '复制失败';
      process.exitCode = 1;
      log('依赖复制失败：' + (e.message || e));
      log('可能被运行中的 MCP 进程占用，请先重载/关闭客户端后重试');
    }
  }
} else {
  log('依赖未变化，跳过 node_modules 复制');
}

// 5. 汇总
const total = countFiles(DIST);
log(`构建完成：${total.files} 个文件，${(total.bytes / 1024 / 1024).toFixed(1)} MB；依赖状态：${depsState}`);
log('提示：dist 被 MCP 引用时，构建后需重载客户端才会加载新代码');
