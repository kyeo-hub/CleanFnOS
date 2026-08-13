'use strict';
/**
 * CleanFnOS api/sysclean.js — 系统清理（17 项：包管理器缓存 / 系统日志 / 用户缓存 / 应用日志）
 * 参考 fnclearup：apt/npm/pip/uv/node-gyp/typescript/浏览器缓存、syslog/journal、应用日志(>50MB)。
 * 三档风险：low=可安全清理（自动重建）/ medium=需注意 / high=会丢登录态或需重下载，前端高亮。
 * 清理为永久删除（缓存/日志类无需回收站），清理前自动备份 manifest 到数据目录。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const TRASH_DIR = process.env.TRASH_DIR || (process.env.TRIM_PKGVAR || '/tmp') + '/trash';
const VAR_DIR = path.dirname(TRASH_DIR);

// ---------------- 用户 HOME 发现 ----------------

/** 收集所有可能用户 HOME：root + /volN/<UID> */
function getUserHomes() {
  const homes = [{ username: 'root', home: '/root', uid: 0 }];
  for (let v = 1; v <= 10; v++) {
    const base = `/vol${v}`;
    let st;
    try { st = fs.statSync(base); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    let names = [];
    try { names = fs.readdirSync(base); } catch (e) { continue; }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const home = path.join(base, name);
      let hs;
      try { hs = fs.lstatSync(home); } catch (e) { continue; }
      if (hs.isDirectory()) homes.push({ username: name, home, uid: parseInt(name, 10) });
    }
  }
  // 去重
  const seen = new Set();
  return homes.filter((h) => (seen.has(h.home) ? false : (seen.add(h.home), true)));
}

// ---------------- 扫描目标定义 ----------------

/** 低风险推荐集（清理后自动重建，无副作用） */
const RECOMMENDED_BASE = new Set([
  'apt-archives', 'apt-lists', 'syslog-gz', 'syslog-old', 'journal',
  'npm', 'pip', 'uv', 'node-gyp', 'typescript',
]);

/** 系统级目标（非按用户展开） */
const SYSTEM_TARGETS = [
  { id: 'apt-archives', label: 'APT 下载缓存 (deb)', path: '/var/cache/apt/archives', risk: 'low',
    filter: (n) => n.endsWith('.deb') },
  { id: 'apt-lists', label: 'APT 列表缓存', path: '/var/lib/apt/lists', risk: 'low',
    filter: (n) => !n.startsWith('partial') && !n.endsWith('.gpg') },
  { id: 'syslog-gz', label: '系统日志轮转 (.gz)', path: '/var/log', risk: 'low',
    filter: (n) => n.endsWith('.gz') },
  { id: 'syslog-old', label: '系统日志历史档 (.1)', path: '/var/log', risk: 'low',
    filter: (n) => /\.1$/.test(n) && /^(syslog|auth\.log|mail\.log|kern\.log|daemon\.log|user\.log|messages)/.test(n) },
  { id: 'journal', label: 'systemd journal 日志', path: '/var/log/journal', risk: 'low',
    filter: (n) => n.endsWith('.journal') },
  { id: 'app-logs', label: '应用日志 (>50MB)', path: '/vol*', risk: 'medium', dynamicChildren: true },
];

/** 按用户展开的缓存目标（每个用户 HOME 一份） */
const USER_CACHE_TEMPLATES = [
  { id: 'npm', label: 'NPM 缓存', subPath: '.npm', risk: 'low' },
  { id: 'pip', label: 'PIP 缓存', subPath: '.cache/pip', risk: 'low' },
  { id: 'uv', label: 'uv 缓存', subPath: '.cache/uv', risk: 'low' },
  { id: 'node-gyp', label: 'node-gyp 缓存', subPath: '.cache/node-gyp', risk: 'low' },
  { id: 'typescript', label: 'TypeScript 增量编译缓存', subPath: '.cache/typescript', risk: 'medium' },
  { id: 'playwright', label: 'Playwright 浏览器 (重下耗时)', subPath: '.cache/ms-playwright', risk: 'high' },
  { id: 'chrome-cache', label: 'Chrome 浏览器缓存 (会丢登录)', subPath: '.cache/google-chrome', risk: 'high' },
  { id: 'firefox-cache', label: 'Firefox 浏览器缓存', subPath: '.cache/mozilla', risk: 'high' },
  { id: 'brave-cache', label: 'Brave 浏览器缓存', subPath: '.cache/BraveSoftware', risk: 'high' },
  { id: 'cache-other', label: '其它 ~/.cache 子目录', subPath: '.cache', risk: 'low', dynamicChildren: true },
];

// ---------------- 工具 ----------------

function dirSize(p, filter) {
  let total = 0;
  try {
    const stack = [p];
    let guard = 0;
    while (stack.length && guard < 50000) {
      guard++;
      const cur = stack.pop();
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        total += st.size;
        for (const n of fs.readdirSync(cur)) stack.push(path.join(cur, n));
      } else if (!filter || filter(path.basename(cur), cur, st)) {
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

const RISK_LABEL = { low: '低', medium: '中', high: '高' };

/** 清理路径白名单：仅允许上述目标生成的路径（防任意路径删除） */
function isSafeCleanPath(p) {
  if (typeof p !== 'string') return false;
  if (p.includes('..')) return false;
  const sysPrefixes = [
    '/var/cache/apt/archives', '/var/lib/apt/lists', '/var/log/journal',
  ];
  if (sysPrefixes.some((pre) => p === pre || p.startsWith(pre + '/'))) return true;
  if (/^\/var\/log\/(syslog|auth\.log|mail\.log|kern\.log|daemon\.log|user\.log|messages)/.test(p)) return true;
  // 用户缓存：/volN/<UID>/.cache 或 /.npm 下
  if (/^\/vol\d+\/\d+\/(\.cache|\.npm)(\/|$)/.test(p)) return true;
  // 应用日志：/volN/@appcenter/<app>/logs 下
  if (/^\/vol\d+\/@appcenter\/[^/]+\/logs(\/|$)/.test(p)) return true;
  return false;
}

// ---------------- 扫描 ----------------

/** 扫描所有目标，返回 [{ id, label, path, size, sizeText, risk, riskLabel, recommended }] */
function scanSysClean() {
  const items = [];

  // 系统级
  for (const t of SYSTEM_TARGETS) {
    if (t.id === 'app-logs') {
      // 动态发现所有 vol 的 @appcenter/<app>/logs 且 >50MB
      for (let v = 1; v <= 10; v++) {
        const center = `/vol${v}/@appcenter`;
        let names = [];
        try { names = fs.readdirSync(center); } catch (e) { continue; }
        for (const app of names) {
          const logsDir = path.join(center, app, 'logs');
          let st;
          try { st = fs.statSync(logsDir); } catch (e) { continue; }
          if (!st.isDirectory()) continue;
          let total = 0;
          try {
            for (const f of fs.readdirSync(logsDir)) {
              try { total += fs.lstatSync(path.join(logsDir, f)).size; } catch (e) {}
            }
          } catch (e) {}
          if (total > 50 * 1024 * 1024) {
            items.push({
              id: `app-logs:${app}`, label: `应用日志 ${app} (>50MB)`, path: logsDir,
              size: total, sizeText: fmtSize(total), risk: t.risk, riskLabel: RISK_LABEL[t.risk],
              recommended: false,
            });
          }
        }
      }
      continue;
    }
    if (!fs.existsSync(t.path)) continue;
    const size = dirSize(t.path, t.filter);
    items.push({
      id: t.id, label: t.label, path: t.path,
      size, sizeText: fmtSize(size), risk: t.risk, riskLabel: RISK_LABEL[t.risk],
      recommended: RECOMMENDED_BASE.has(t.id),
    });
  }

  // 用户缓存（每用户展开）
  for (const u of getUserHomes()) {
    for (const t of USER_CACHE_TEMPLATES) {
      const base = path.join(u.home, t.subPath);
      if (!fs.existsSync(base)) continue;
      if (t.id === 'cache-other') {
        // 动态子目录：排除已被模板覆盖的单级子目录
        let subs = [];
        try { subs = fs.readdirSync(base); } catch (e) { continue; }
        const covered = new Set(['pip', 'uv', 'node-gyp', 'typescript', 'ms-playwright', 'google-chrome', 'mozilla', 'BraveSoftware']);
        for (const sub of subs) {
          if (covered.has(sub)) continue;
          const sp = path.join(base, sub);
          let st;
          try { st = fs.lstatSync(sp); } catch (e) { continue; }
          if (!st.isDirectory()) continue;
          const size = dirSize(sp);
          if (size === 0) continue;
          items.push({
            id: `cache-other:${u.username}:${sub}`, label: `其它 ~/.cache/${sub} (UID ${u.username})`, path: sp,
            size, sizeText: fmtSize(size), risk: 'low', riskLabel: '低', recommended: true,
          });
        }
        continue;
      }
      const size = dirSize(base);
      if (size === 0) continue;
      const display = u.username === 'root' ? 'root' : `UID ${u.username}`;
      items.push({
        id: `${t.id}:${u.username}`, label: `${t.label} (${display})`, path: base,
        size, sizeText: fmtSize(size), risk: t.risk, riskLabel: RISK_LABEL[t.risk],
        recommended: RECOMMENDED_BASE.has(t.id),
      });
    }
  }

  items.sort((a, b) => b.size - a.size);
  return items;
}

// ---------------- 清理 ----------------

/** 清理前备份操作清单到数据目录 manifests/ */
async function backupSysManifest(payload) {
  try {
    const dir = path.join(VAR_DIR, 'manifests');
    await fsp.mkdir(dir, { recursive: true });
    const name = `sysclean-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    await fsp.writeFile(path.join(dir, name), JSON.stringify({ time: new Date().toISOString(), ...payload }, null, 2));
    return name;
  } catch (e) { return null; }
}

/** 清空目录内容（保留目录本身），用于缓存/日志类目标 */
async function clearDirContents(p) {
  let names = [];
  try { names = await fsp.readdir(p); } catch (e) { return 0; }
  let removed = 0;
  for (const n of names) {
    const fp = path.join(p, n);
    let lst;
    try { lst = await fsp.lstat(fp); } catch (e) { continue; }
    try {
      if (lst.isSymbolicLink()) await fsp.unlink(fp);
      else await fsp.rm(fp, { recursive: true, force: true });
      removed++;
    } catch (e) { /* 单个失败继续 */ }
  }
  return removed;
}

/**
 * 清理选中的系统清理项。paths 为扫描时返回的 path，必须通过白名单。
 * 缓存/日志类永久删除（自动重建），删除前备份 manifest。
 */
async function sysCleanDelete({ paths = [] }) {
  const failed = [];
  const cleaned = [];
  let totalBytes = 0;

  // 计算大小用于备份
  const sizeOf = {};
  for (const p of paths) {
    if (isSafeCleanPath(p)) sizeOf[p] = dirSize(p);
  }
  await backupSysManifest({ mode: 'permanent', paths, sizes: sizeOf });

  for (const target of paths) {
    if (!isSafeCleanPath(target)) { failed.push(`${target} (路径不合法)`); continue; }
    let st;
    try { st = await fsp.lstat(target); } catch (e) { failed.push(`${target} (不存在)`); continue; }
    if (st.isSymbolicLink()) { failed.push(`${target} (符号链接，拒绝)`); continue; }
    try {
      const bytes = dirSize(target);
      // 日志类文件目标（/var/log 下的单个文件）直接删除；目录目标清空内容
      if (st.isFile()) {
        await fsp.unlink(target);
      } else {
        await clearDirContents(target);
      }
      cleaned.push({ path: target, bytes });
      totalBytes += bytes;
    } catch (e) {
      failed.push(`${target} (${e.message})`);
    }
  }

  return { cleaned, failed, totalBytes };
}

module.exports = {
  scanSysClean,
  sysCleanDelete,
  isSafeCleanPath,
};
