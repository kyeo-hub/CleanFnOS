'use strict';
/**
 * CleanFnOS api/netdisk.js — 网盘挂载残余扫描与清理
 * 参考 fnclearup：扫描 /vol02/ 目录，对比 /etc/mountmgr/mount_info.json 的 mountPoint，
 * 识别已卸载网盘残留的挂载点目录。删除默认移入回收站（TRASH_DIR），可恢复。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const TRASH_DIR = process.env.TRASH_DIR || (process.env.TRIM_PKGVAR || '/tmp') + '/trash';
const MOUNT_INFO = '/etc/mountmgr/mount_info.json';
const NETDISK_ROOT = '/vol02';

// ---------------- 工具 ----------------

/** 读取 mount_info.json 中所有 mountPoint（去尾部斜杠） */
function collectMountPoints() {
  const mps = new Set();
  let data;
  try { data = JSON.parse(fs.readFileSync(MOUNT_INFO, 'utf8')); } catch (e) { return mps; }
  for (const uid of Object.keys(data)) {
    const obj = data[uid];
    if (!obj || typeof obj !== 'object') continue;
    for (const id of Object.keys(obj)) {
      const item = obj[id];
      if (item && typeof item.mountPoint === 'string' && item.mountPoint) {
        mps.add(item.mountPoint.replace(/\/+$/, ''));
      }
    }
  }
  return mps;
}

/** 读取 /proc/mounts 中当前实际挂载点（防御：挂载中的目录拒绝删除） */
function collectMountedPoints() {
  const mps = new Set();
  let data = '';
  try { data = fs.readFileSync('/proc/mounts', 'utf8'); } catch (e) { return mps; }
  for (const line of data.split('\n')) {
    const parts = line.split(/\s+/);
    if (parts.length >= 2 && parts[1]) mps.add(parts[1]);
  }
  return mps;
}

/** 网盘残留目录名格式：{uid}-{n}-{hex}，如 1000-1-2deb6cec（防误判用户自建目录） */
function isNetdiskName(name) {
  return /^\d+-\d+-[A-Za-z0-9_-]+$/.test(name);
}

/** 删除路径白名单：仅 /vol02/<name>，且 name 符合网盘目录格式 */
function isSafeNetdiskPath(p) {
  if (typeof p !== 'string') return false;
  const m = p.match(/^\/vol02\/([^/]+)$/);
  if (!m) return false;
  return isNetdiskName(m[1]);
}

/** 目录体积（浅层统计，不跟随符号链接） */
function dirSize(p) {
  let total = 0;
  try {
    const stack = [p];
    let guard = 0;
    while (stack.length && guard < 20000) {
      guard++;
      const cur = stack.pop();
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        total += st.size;
        for (const n of fs.readdirSync(cur)) stack.push(path.join(cur, n));
      } else {
        total += st.size;
      }
    }
  } catch (e) { /* 忽略单个失败 */ }
  return total;
}

function fmtSize(n) {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

// ---------------- 扫描 ----------------

/** 扫描 /vol02 下不在 mount_info.json 配置中的残留挂载点目录 */
function scanNetdiskResiduals() {
  const mps = collectMountPoints();
  const mounted = collectMountedPoints();
  const residuals = [];
  let names = [];
  try { names = fs.readdirSync(NETDISK_ROOT); } catch (e) { return residuals; }
  for (const name of names) {
    const p = path.join(NETDISK_ROOT, name);
    let st;
    try { st = fs.lstatSync(p); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    if (mps.has(p)) continue;          // 仍在 mount_info.json 配置中，不是残留
    if (mounted.has(p)) continue;      // 仍在挂载中，不是残留
    if (!isNetdiskName(name)) continue; // 格式不符，可能是用户自建目录，不误报
    residuals.push({ id: name, path: p, size: dirSize(p), sizeText: fmtSize(dirSize(p)) });
  }
  residuals.sort((a, b) => b.size - a.size);
  return residuals;
}

// ---------------- 删除 ----------------

async function moveToTrash(p, meta) {
  await fsp.mkdir(TRASH_DIR, { recursive: true });
  const base = path.basename(p);
  const name = `${Date.now()}-${base}`;
  const dest = path.join(TRASH_DIR, name);
  await fsp.rename(p, dest);
  await fsp.writeFile(path.join(dest, 'manifest.json'), JSON.stringify({ ...meta, original: p }, null, 2));
  return name;
}

async function deleteNetdiskItems({ paths = [], mode = 'trash' }) {
  const permanent = mode === 'permanent';
  const failed = [];
  const moved = [];
  const mps = collectMountPoints();
  const mounted = collectMountedPoints();

  for (const target of paths) {
    if (!isSafeNetdiskPath(target)) { failed.push(`${target} (路径不合法)`); continue; }
    if (mps.has(target)) { failed.push(`${target} (仍在网盘配置中，拒绝删除)`); continue; }
    if (mounted.has(target)) { failed.push(`${target} (仍在挂载中，拒绝删除)`); continue; }
    let st;
    try { st = await fsp.lstat(target); } catch (e) { failed.push(`${target} (不存在)`); continue; }
    if (st.isSymbolicLink()) { failed.push(`${target} (符号链接，拒绝)`); continue; }
    try {
      if (permanent) {
        await fsp.rm(target, { recursive: true, force: true });
        moved.push({ path: target, action: 'permanent' });
      } else {
        const name = await moveToTrash(target, { app: '', type: 'netdisk', mode: 'trash' });
        moved.push({ path: target, trash: name, action: 'trash' });
      }
    } catch (e) {
      failed.push(`${target} (${e.message})`);
    }
  }
  return { moved, failed };
}

module.exports = {
  scanNetdiskResiduals,
  deleteNetdiskItems,
  isSafeNetdiskPath,
};
