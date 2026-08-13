'use strict';
/**
 * CleanFnOS api/tmp.js — /tmp 与 /var/tmp 24h+ 未访问文件清理
 * 参考 fnclearup：扫描 /tmp 和 /var/tmp 下 24h+ 未访问的文件。
 * 安全：只处理普通文件，跳过符号链接（不跟随）、跳过 socket/设备等特殊文件；
 * 路径必须位于 tmp 白名单根内；删除默认移入回收站（跨文件系统自动复制+删除）。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const TRASH_DIR = process.env.TRASH_DIR || (process.env.TRIM_PKGVAR || '/tmp') + '/trash';
const TMP_ROOTS = ['/tmp', '/var/tmp'];
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_DEPTH = 10;
const MAX_FILES = 50000; // 扫描文件数上限，防卡死

// ---------------- 工具 ----------------

/** 路径是否在 tmp 白名单根内（防路径穿越） */
function isSafeTmpPath(p) {
  if (typeof p !== 'string') return false;
  return TMP_ROOTS.some((root) => p === root || p.startsWith(root + '/'));
}

function fmtSize(n) {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function fmtTime(ms) {
  try {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch (e) { return ''; }
}

/** 是否应跳过该目录（系统关键 tmp 目录） */
function isSkippedDir(name) {
  return name.startsWith('systemd-private-') ||
    name === '.X11-unix' || name === '.XIM-unix' || name === '.ICE-unix' ||
    name === '.Test-unix' || name === 'vmware-root' || name === '.font-unix';
}

// ---------------- 扫描 ----------------

/** 递归扫描一个 tmp 根，收集 atime 超过 24h 的普通文件 */
function scanRoot(root, depth, out) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
  const now = Date.now();
  for (const ent of entries) {
    if (out.length >= MAX_FILES) break;
    const p = path.join(root, ent.name);
    if (ent.isSymbolicLink()) continue;       // 不跟随符号链接
    if (ent.isDirectory()) {
      if (isSkippedDir(ent.name)) continue;
      scanRoot(p, depth + 1, out);
    } else if (ent.isFile()) {
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (now - st.atimeMs > MAX_AGE_MS) {
        out.push({ path: p, size: st.size, atime: st.atimeMs });
      }
    }
    // socket/设备/fifo 等特殊文件一律跳过
  }
}

/** 扫描所有 tmp 根，返回 24h+ 未访问文件列表 */
function scanTmp() {
  const files = [];
  for (const root of TMP_ROOTS) scanRoot(root, 0, files);
  files.sort((a, b) => b.size - a.size);
  return files.map((f) => ({
    path: f.path,
    size: f.size,
    sizeText: fmtSize(f.size),
    atime: f.atime,
    atimeText: fmtTime(f.atime),
    risk: 'low',
    riskLabel: '低',
  }));
}

// ---------------- 删除 ----------------

/** 移入回收站：目录化存放（回收站条目为目录，内含原文件；元数据存同级 <name>.meta.json）
 *  同卷 rename；跨文件系统（EXDEV）复制+删除。meta 记录 kind:'file' 供恢复。 */
async function moveToTrash(p, meta) {
  await fsp.mkdir(TRASH_DIR, { recursive: true });
  const base = path.basename(p);
  const name = `${Date.now()}-${base}`;
  const dest = path.join(TRASH_DIR, name);
  await fsp.mkdir(dest, { recursive: true });
  const target = path.join(dest, base);
  try {
    await fsp.rename(p, target);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(p, target);
    await fsp.unlink(p);
  }
  await fsp.writeFile(path.join(TRASH_DIR, name + '.meta.json'), JSON.stringify({ ...meta, original: p, kind: 'file' }, null, 2));
  return name;
}

async function deleteTmpFiles({ paths = [], mode = 'trash' }) {
  const permanent = mode === 'permanent';
  const failed = [];
  const moved = [];
  for (const target of paths) {
    if (!isSafeTmpPath(target)) { failed.push(`${target} (路径不合法)`); continue; }
    let st;
    try { st = await fsp.lstat(target); } catch (e) { failed.push(`${target} (不存在)`); continue; }
    if (st.isSymbolicLink()) { failed.push(`${target} (符号链接，拒绝)`); continue; }
    if (!st.isFile()) { failed.push(`${target} (非普通文件，拒绝)`); continue; }
    try {
      if (permanent) {
        await fsp.unlink(target);
        moved.push({ path: target, action: 'permanent' });
      } else {
        const name = await moveToTrash(target, { app: '', type: 'tmp', mode: 'trash' });
        moved.push({ path: target, trash: name, action: 'trash' });
      }
    } catch (e) {
      failed.push(`${target} (${e.message})`);
    }
  }
  return { moved, failed };
}

module.exports = {
  scanTmp,
  deleteTmpFiles,
  isSafeTmpPath,
};
