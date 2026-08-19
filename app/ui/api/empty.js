'use strict';
/**
 * CleanFnOS api/empty.js — 空目录清理
 * 参考 fnclearup：扫描指定根目录下的空目录，支持移入回收站 / 永久删除。
 * 安全：跳过 @app* 系统目录、.@#local 回收站目录、符号链接、挂载点；
 * 只报告「完全为空」的目录（无任何子项），删除时二次确认防止误删。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const TRASH_DIR = process.env.TRASH_DIR || (process.env.TRIM_PKGVAR || '/tmp') + '/trash';
const MAX_DIRS = 50000; // 扫描目录数上限，防卡死

// ---------------- 工具 ----------------

/** 校验扫描/删除根路径：仅 /volN 下的普通目录 */
function isSafeRoot(p) {
  if (typeof p !== 'string') return false;
  const m = p.match(/^\/vol\d+(\/[^/]+)?$/);
  if (!m) return false;
  // 拒绝系统保留目录
  const base = m[1] ? m[1].slice(1) : '';
  if (base.startsWith('@app') || base.startsWith('.@#') || base === 'docker' || base === 'lost+found') return false;
  return true;
}

/** 校验空目录删除路径：/volN/<name>/... 但拒绝 @app* / .@#local / docker / lost+found 等系统目录 */
function isSafeEmptyPath(p) {
  if (typeof p !== 'string') return false;
  if (!/^\/vol\d+\/[^/]+/.test(p)) return false;
  const segs = p.split('/').filter(Boolean);
  if (segs.length < 2) return false;
  if (segs[0].startsWith('@app') || segs[0].startsWith('.@#')) return false;
  for (let i = 1; i < segs.length; i++) {
    if (segs[i] === '.@#local' || segs[i].startsWith('.@#') || segs[i] === '@appshare' ||
        segs[i] === 'docker' || segs[i] === 'lost+found') return false;
  }
  return true;
}

/** 判断是否为挂载点（/proc/mounts 第二列） */
function isMountPoint(p) {
  try {
    const data = fs.readFileSync('/proc/mounts', 'utf8');
    return data.split('\n').some((line) => line.split(/\s+/)[1] === p);
  } catch (e) { return false; }
}

function fmtSize(n) {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

// ---------------- 扫描 ----------------

/**
 * 递归扫描根目录，收集空目录（无任何子项）。
 * 跳过：@app* 系统目录、.@#local 回收站目录、符号链接、挂载点、以及其下仍可能含文件的目录。
 */
function scanEmptyDirs(root, depth, out, seen) {
  if (depth > 20 || out.length >= MAX_DIRS) return;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of entries) {
    if (out.length >= MAX_DIRS) return;
    if (ent.isSymbolicLink()) continue; // 不跟随符号链接
    if (!ent.isDirectory()) continue;
    const p = path.join(root, ent.name);
    if (seen.has(p)) continue;
    seen.add(p);
    if (ent.name.startsWith('@app') || ent.name.startsWith('.@#') || ent.name === 'lost+found') continue;
    // 与 isSafeEmptyPath 白名单保持一致：docker 数据目录、应用中心下载目录不列入空目录清理
    if (ent.name === 'docker' || ent.name === 'appcenter-downloads') continue;
    if (isMountPoint(p)) continue; // 挂载点目录不算空目录
    let sub = [];
    try { sub = fs.readdirSync(p); } catch (e) { continue; }
    if (sub.length === 0) {
      out.push({ path: p, size: 0, sizeText: '0 B' });
    } else {
      scanEmptyDirs(p, depth + 1, out, seen);
    }
  }
}

/** 扫描空目录（默认根：/vol1，可指定任意 /volN 根） */
function scanEmpty({ root = '/vol1' } = {}) {
  if (!isSafeRoot(root)) return { error: '根路径不合法' };
  const out = [];
  scanEmptyDirs(root, 0, out, new Set());
  return { root, dirs: out };
}

// ---------------- 删除 ----------------

/** 移入回收站：目录移入 TRASH_DIR/<name>，元数据存同级 <name>.meta.json（不污染原目录内容） */
async function moveToTrash(p, meta) {
  await fsp.mkdir(TRASH_DIR, { recursive: true });
  const base = path.basename(p);
  const name = `${Date.now()}-${base}`;
  const dest = path.join(TRASH_DIR, name);
  try {
    await fsp.rename(p, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.cp(p, dest, { recursive: true });
    await fsp.rm(p, { recursive: true, force: true });
  }
  await fsp.writeFile(path.join(TRASH_DIR, name + '.meta.json'), JSON.stringify({ ...meta, original: p }, null, 2));
  return name;
}

async function deleteEmptyDirs({ paths = [], mode = 'trash' }) {
  const permanent = mode === 'permanent';
  const failed = [];
  const moved = [];
  for (const target of paths) {
    if (!isSafeEmptyPath(target)) { failed.push(`${target} (路径不合法)`); continue; }
    let st;
    try { st = await fsp.lstat(target); } catch (e) {
      if (e.code === 'ENOENT') continue; // 目标已消失（扫描后并发删除），视为已达成清理目标
      failed.push(`${target} (不存在)`); continue;
    }
    if (st.isSymbolicLink()) { failed.push(`${target} (符号链接，拒绝)`); continue; }
    if (!st.isDirectory()) { failed.push(`${target} (非目录，拒绝)`); continue; }
    // 再次确认是空目录
    let sub = [];
    try { sub = await fsp.readdir(target); } catch (e) { failed.push(`${target} (读取失败)`); continue; }
    if (sub.length > 0) { failed.push(`${target} (非空目录，拒绝)`); continue; }
    try {
      if (permanent) {
        await fsp.rmdir(target);
        moved.push({ path: target, action: 'permanent' });
      } else {
        const name = await moveToTrash(target, { app: '', type: 'empty', mode: 'trash' });
        moved.push({ path: target, trash: name, action: 'trash' });
      }
    } catch (e) {
      failed.push(`${target} (${e.message})`);
    }
  }
  return { moved, failed };
}

module.exports = {
  scanEmpty,
  deleteEmptyDirs,
  isSafeEmptyPath,
};
