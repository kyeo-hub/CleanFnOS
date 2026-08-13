'use strict';
/**
 * CleanFnOS api/bigfiles.js — 大文件查找器（跨 /vol* 卷 ≥100MB Top100）
 * 参考 fnclearup：BFS 队列扫描，带深度上限 / 文件数上限 / 扫描时间预算 / 目录兄弟项阈值，
 * 避免在超大目录（缩略图、torrent seed 等）上耗尽扫描预算。
 * 默认排除 /vol02（网盘 fuse 挂载，可能巨大且慢），可通过 path 参数指定。
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_MIN_SIZE = 100 * 1024 * 1024; // 100 MB
const DEFAULT_TOPN = 100;
const DEFAULT_DEPTH = 6;
const SCAN_BUDGET_MS = 5 * 60 * 1000; // 5 分钟硬超时
const SIBLING_THRESHOLD = 5000;        // 目录兄弟项超过此值则不下钻
const MAX_FILES = 5000;                // 候选文件收集上限

// ---------------- 工具 ----------------

/** 路径白名单：/volN（vol1~vol10），可带子路径；拒绝 vol02 之外的伪卷与路径穿越 */
function isSafeVolPath(p) {
  if (typeof p !== 'string') return false;
  const m = p.match(/^\/vol(\d+)(\/.*)?$/);
  if (!m) return false;
  const vol = parseInt(m[1], 10);
  if (vol < 1 || vol > 10) return false;
  if (p.includes('..')) return false;
  return true;
}

/** 解析根：/vol* 展开为 vol1~vol10（排除 /vol02 网盘 fuse）；具体路径校验后单根 */
function resolveRoots(input) {
  if (input === '/vol*' || input === '/vol*/') {
    const roots = [];
    for (let i = 1; i <= 10; i++) {
      const v = `/vol${i}`;
      if (i === 2) continue; // 排除 /vol02（网盘 fuse，慢且可能巨大）
      let st;
      try { st = fs.statSync(v); } catch (e) { continue; }
      if (st.isDirectory()) roots.push(v);
    }
    return roots;
  }
  if (!isSafeVolPath(input)) return null;
  let st;
  try { st = fs.statSync(input); } catch (e) { return []; }
  if (!st.isDirectory()) return null;
  return [input];
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

// ---------------- 扫描 ----------------

/**
 * 扫描大文件。
 * @param {string} rootPath  '/vol*' 或具体 /volN[/子路径]
 * @param {number} minSize  最小文件字节数（默认 100MB）
 * @param {number} topN     返回条数（默认 100，上限 500）
 * @param {number} depth    递归深度上限（默认 6，上限 12）
 * @returns {{files:Array, truncated:boolean, scannedDirs:number, elapsedMs:number, error?:string}}
 */
function scanBigFiles({ rootPath = '/vol*', minSize = DEFAULT_MIN_SIZE, topN = DEFAULT_TOPN, depth = DEFAULT_DEPTH }) {
  const roots = resolveRoots(rootPath);
  if (roots === null) return { error: `path 必须位于 /vol1~/vol10 下（可用 /vol*）` };
  if (roots.length === 0) return { files: [], truncated: false, scannedDirs: 0, elapsedMs: 0 };
  if (typeof minSize !== 'number' || minSize < 0) minSize = DEFAULT_MIN_SIZE;
  topN = Math.min(parseInt(topN, 10) || DEFAULT_TOPN, 500);
  depth = Math.min(parseInt(depth, 10) || DEFAULT_DEPTH, 12);

  const candidates = []; // { path, name, size, mtime, depth }
  let scannedDirs = 0;
  const t0 = Date.now();

  for (const root of roots) {
    if (Date.now() - t0 > SCAN_BUDGET_MS) break;
    // BFS 队列：[dirPath, level]
    const queue = [[root, 0]];
    while (queue.length) {
      if (Date.now() - t0 > SCAN_BUDGET_MS) break;
      if (candidates.length >= MAX_FILES) break;
      const [dir, level] = queue.shift();
      if (level > depth) continue;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
      scannedDirs++;
      // 兄弟项过多（缩略图/图标/seed 目录）：保留本级文件，不下钻
      const skipRecurse = entries.length > SIBLING_THRESHOLD;
      for (const ent of entries) {
        if (candidates.length >= MAX_FILES) break;
        const full = path.join(dir, ent.name);
        try {
          if (ent.isFile()) {
            const st = fs.statSync(full);
            if (st.size >= minSize) {
              candidates.push({ path: full, name: ent.name, size: st.size, mtime: st.mtimeMs });
            }
          } else if (ent.isDirectory() && !ent.isSymbolicLink() && !skipRecurse) {
            queue.push([full, level + 1]);
          }
        } catch (e) { /* 单个条目失败忽略 */ }
      }
    }
  }

  candidates.sort((a, b) => b.size - a.size);
  const truncated = candidates.length > topN;
  const top = candidates.slice(0, topN).map((f) => ({
    path: f.path,
    name: f.name,
    size: f.size,
    sizeText: fmtSize(f.size),
    mtime: f.mtime,
    mtimeText: fmtTime(f.mtime),
  }));

  return {
    files: top,
    truncated,
    totalCandidates: candidates.length,
    scannedDirs,
    elapsedMs: Date.now() - t0,
  };
}

module.exports = {
  scanBigFiles,
  isSafeVolPath,
};
