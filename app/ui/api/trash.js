'use strict';
/**
 * CleanFnOS api/trash.js — 系统回收站批量清理（.@#local/trash 按 mtime 分级）
 * 参考 fnclearup：扫描所有 vol（/vol1~vol10）× 所有 UID 目录下嵌套的 .@#local/trash/，
 * 按 mtime 30/90/365 天分级展示与清理。
 * 注意：.@#local/trash 可能位于 UID 目录的任意子目录层级（如 /vol1/1000/Photos/.@#local/trash），
 * 扫描时递归查找（限深 6）。
 * 安全：只在扫描收集到的 trash 根目录内操作，不跟随符号链接；
 * 清理即永久删除（回收站里的内容无需再进回收站），前端需二次确认。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MAX_VOL = 10;
const MAX_DEPTH = 6; // UID 目录下递归查找 .@#local 的最大深度
const LEVELS = [
  { key: 'lt30', label: '30 天内', max: 30 },
  { key: '30to90', label: '30~90 天', min: 30, max: 90 },
  { key: '90to365', label: '90~365 天', min: 90, max: 365 },
  { key: 'gt365', label: '365 天以上', min: 365 },
];

// ---------------- 工具 ----------------

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

function fmtTime(ms) {
  try {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch (e) { return ''; }
}

/** 按 mtime 距今天数分档 */
function levelOf(ageDays) {
  for (const lv of LEVELS) {
    if ((lv.min === undefined || ageDays >= lv.min) && (lv.max === undefined || ageDays < lv.max)) return lv.key;
  }
  return 'lt30';
}

// ---------------- 扫描 ----------------

/** 递归查找 dir 下的 .@#local/trash 根目录（限深，跳过符号链接与隐藏目录） */
function collectTrashRoots() {
  const roots = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (outGuard(roots, seen)) return;
      if (ent.isSymbolicLink()) continue;          // 不跟随符号链接
      if (!ent.isDirectory()) continue;
      if (ent.name === '.@#local') {
        const trash = path.join(dir, ent.name, 'trash');
        let st;
        try { st = fs.statSync(trash); } catch (e) { continue; }
        if (st.isDirectory()) roots.push(trash);
        continue; // 不深入 .@#local 内部
      }
      if (ent.name.startsWith('.')) continue;      // 跳过其他隐藏目录
      if (ent.name === '@appstore' || ent.name === '@appdata') continue; // 应用目录不递归
      walk(path.join(dir, ent.name), depth + 1);
    }
  };
  for (let i = 1; i <= MAX_VOL; i++) {
    const vol = `/vol${i}`;
    let uids = [];
    try { uids = fs.readdirSync(vol); } catch (e) { continue; }
    for (const uid of uids) {
      const uidDir = path.join(vol, uid);
      let st;
      try { st = fs.statSync(uidDir); } catch (e) { continue; }
      if (!st.isDirectory()) continue;
      walk(uidDir, 0);
    }
  }
  return roots;
}

function outGuard(roots, seen) {
  return roots.length > 5000;
}

/** 校验路径是否位于某个 trash 根下的一级子项 */
function isSafeTrashItemPath(p, roots) {
  if (typeof p !== 'string') return false;
  for (const root of roots) {
    const prefix = root + '/';
    if (p.startsWith(prefix)) {
      const rest = p.slice(prefix.length);
      // 必须是一级子项（不含 /），且无路径穿越
      if (rest && !rest.includes('/') && !rest.includes('..')) return true;
    }
  }
  return false;
}

/** 扫描所有 trash 根下的条目，按分级返回 */
function scanSystemTrash() {
  const roots = collectTrashRoots();
  const items = [];
  const now = Date.now();
  for (const trashDir of roots) {
    let names = [];
    try { names = fs.readdirSync(trashDir); } catch (e) { continue; }
    for (const name of names) {
      const p = path.join(trashDir, name);
      let lst;
      try { lst = fs.lstatSync(p); } catch (e) { continue; }
      const ageDays = (now - lst.mtimeMs) / 86400000;
      items.push({
        path: p,
        name,
        vol: '/' + path.relative('/', trashDir).split('/')[0].replace(/^\/?/, '') || '',
        trashRoot: trashDir,
        level: levelOf(ageDays),
        size: dirSize(p),
        sizeText: fmtSize(dirSize(p)),
        mtime: lst.mtimeMs,
        mtimeText: fmtTime(lst.mtimeMs),
      });
    }
  }
  items.sort((a, b) => a.mtime - b.mtime);
  return items;
}

/** 分级汇总：{ level: { count, size, sizeText } } */
function summarizeTrash(items) {
  const map = {};
  for (const lv of LEVELS) map[lv.key] = { key: lv.key, label: lv.label, count: 0, size: 0, sizeText: '' };
  for (const it of items) {
    map[it.level].count++;
    map[it.level].size += it.size;
  }
  for (const k of Object.keys(map)) map[k].sizeText = fmtSize(map[k].size);
  return Object.values(map);
}

// ---------------- 清理 ----------------

/** 批量永久清理选中的回收站条目（回收站内容不再进回收站） */
async function deleteTrashItems({ paths = [] }) {
  const roots = collectTrashRoots();
  const failed = [];
  const removed = [];
  for (const target of paths) {
    if (!isSafeTrashItemPath(target, roots)) { failed.push(`${target} (路径不合法)`); continue; }
    let lst;
    try { lst = await fsp.lstat(target); } catch (e) { failed.push(`${target} (不存在)`); continue; }
    if (lst.isSymbolicLink()) { failed.push(`${target} (符号链接，拒绝)`); continue; }
    try {
      await fsp.rm(target, { recursive: true, force: true });
      removed.push({ path: target });
    } catch (e) {
      failed.push(`${target} (${e.message})`);
    }
  }
  return { removed, failed };
}

module.exports = {
  scanSystemTrash,
  summarizeTrash,
  deleteTrashItems,
};
