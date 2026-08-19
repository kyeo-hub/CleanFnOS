'use strict';
/**
 * CleanFnOS api/app.js — 应用残留 / 链接残留 / 系统用户 扫描与清理
 * 从 server.js 迁入的扫描与清理逻辑，另新增 /usr/local 链接残留扫描（参考 fnos-app-cleaner）。
 * 依赖注入：TRASH_DIR（回收站目录）。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const TRASH_DIR = process.env.TRASH_DIR || (process.env.TRIM_PKGVAR || '/tmp') + '/trash';

// ---------------- 基础 ----------------

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/** 安全路径校验：只允许 /volN/@appxxx/<name> 形式 */
function isSafeAppPath(p) {
  const m = p.match(/^\/vol\d+\/(@app[A-Za-z0-9_-]+)\/[^/]+$/);
  if (!m) return false;
  const allow = ['@appdata', '@appconf', '@apphome', '@apptemp', '@appmeta', '@appshare', '@appcenter'];
  return allow.includes(m[1]);
}

/** 安全链接路径校验：/usr/local 等系统目录下的符号链接 */
function isSafeLinkPath(p) {
  return /^\/usr\/local\/(?:bin|lib|libexec|sbin|share|include)\/[^/]+$/.test(p) ||
    /^\/usr\/local\/[^/]+\/[^/]+$/.test(p) ||
    /^\/opt\/[^/]+$/.test(p) ||        // /opt 下的一级链接（扫描 roots 含 /opt）
    /^\/opt\/[^/]+\/[^/]+$/.test(p);
}

/** 校验回收站项名称（防路径穿越） */
function isSafeTrashName(n) {
  return typeof n === 'string' && n.length > 0 && n.length < 200 && !n.includes('/') && !n.includes('..');
}

/** 恢复目标路径白名单：@app 残留路径（原有）、/tmp、/var/tmp 下的一级路径（tmp 清理条目）、
 *  或 /volN 下非系统保留目录的普通路径（empty 空目录条目）。 */
function isSafeRestorePath(p) {
  if (typeof p !== 'string') return false;
  if (isSafeAppPath(p)) return true;
  if (/^\/tmp\/[^/]+$/.test(p) || /^\/var\/tmp\/[^/]+$/.test(p)) return true;
  // empty 空目录：/volN/<name>/... 且不含 @app* / .@# / docker / lost+found 系统段
  if (/^\/vol\d+\//.test(p) && !p.includes('..')) {
    const segs = p.split('/').filter(Boolean);
    if (segs.length < 2) return false;
    if (segs[0].startsWith('@app') || segs[0].startsWith('.@#')) return false;
    for (let i = 1; i < segs.length; i++) {
      if (segs[i].startsWith('.@#') || segs[i] === '@appshare' ||
          segs[i] === 'docker' || segs[i] === 'lost+found') return false;
    }
    return true;
  }
  return false;
}

// ---------------- 已安装应用列表 ----------------

/** 解析 appcenter-cli list 的表格输出，返回 appname 数组 */
async function getInstalledApps() {
  const { stdout } = await run('appcenter-cli', ['list'], 30000);
  const apps = [];
  for (const line of stdout.split('\n')) {
    const cells = line.split('│').map((s) => s.trim());
    if (cells.length >= 5 && cells[1] && !/APP NAME/i.test(cells[1]) && !/^[─┐┌└┘┤├┬┴]+$/.test(cells[1])) {
      apps.push(cells[1]);
    }
  }
  return apps;
}

// ---------------- 扫描 ----------------

/** 收集已安装应用声明的共享目录（/var/apps/{app}/shares 符号链接 realpath 集合） */
function collectUsedShares() {
  const used = new Set();
  const appsRoot = '/var/apps';
  let entries = [];
  try { entries = fs.readdirSync(appsRoot); } catch (e) { return used; }
  for (const app of entries) {
    const sharesDir = path.join(appsRoot, app, 'shares');
    let links = [];
    try { links = fs.readdirSync(sharesDir); } catch (e) { continue; }
    for (const link of links) {
      const lp = path.join(sharesDir, link);
      let st;
      try { st = fs.lstatSync(lp); } catch (e) { continue; }
      if (!st.isSymbolicLink()) continue;
      try { used.add(fs.realpathSync(lp)); } catch (e) { /* 悬空链接忽略 */ }
    }
  }
  return used;
}

/** uid -> 用户名（缓存） */
const _uidCache = new Map();
function uidToName(uid) {
  if (_uidCache.has(uid)) return _uidCache.get(uid);
  let name = null;
  try {
    const pw = fs.readFileSync('/etc/passwd', 'utf8');
    for (const line of pw.split('\n')) {
      const m = line.match(/^([^\s:]+):[^:]*:(\d+):/);
      if (m && m[2] === String(uid)) { name = m[1]; break; }
    }
  } catch (e) {}
  _uidCache.set(uid, name);
  return name;
}

/** 收集已安装应用可能使用的系统用户名（appname + docker-<appname> + privilege.username） */
function collectInstalledUsers(apps) {
  const users = new Set();
  for (const app of apps) {
    users.add(app.toLowerCase());
    users.add('docker-' + app.toLowerCase());
    try {
      const priv = JSON.parse(fs.readFileSync(`/var/apps/${app}/config/privilege`, 'utf8'));
      if (priv && priv.username) users.add(String(priv.username).toLowerCase());
    } catch (e) {}
  }
  return users;
}

/** 扫描所有 vol 下的 @app* 目录，识别孤儿目录（@appshare 按符号链接归属 + 属主用户判定） */
function scanOrphanDirs(installedSet, usedShares, installedUsers) {
  const orphans = [];
  for (let i = 1; i <= 10; i++) {
    const vol = `/vol${i}`;
    let types = [];
    try { types = fs.readdirSync(vol); } catch (e) { continue; }
    for (const t of types) {
      if (!t.startsWith('@app')) continue;
      const typeDir = path.join(vol, t);
      let st;
      try { st = fs.statSync(typeDir); } catch (e) { continue; }
      if (!st.isDirectory()) continue;
      let names = [];
      try { names = fs.readdirSync(typeDir); } catch (e) { continue; }
      for (const name of names) {
        const p = path.join(typeDir, name);
        let lst;
        try { lst = fs.lstatSync(p); } catch (e) { continue; }
        if (lst.isSymbolicLink()) continue;
        if (!lst.isDirectory()) continue;

        if (t === '@appshare') {
          let rp;
          try { rp = fs.realpathSync(p); } catch (e) { rp = p; }
          let referenced = false;
          for (const u of usedShares) {
            if (u === rp || u.startsWith(rp + '/') || rp.startsWith(u + '/')) { referenced = true; break; }
          }
          if (referenced) continue;
          const owner = uidToName(lst.uid);
          if (owner && installedUsers.has(owner)) continue;
          orphans.push({ type: 'share', app: name, path: p, vol, size: dirSize(p) });
        } else {
          const key = name.toLowerCase();
          if (installedSet.has(key)) continue;
          orphans.push({ type: t.slice(4), app: name, path: p, vol, size: dirSize(p) });
        }
      }
    }
  }
  return orphans;
}

/**
 * 扫描 /usr/local 等目录下指向已卸载应用的符号链接（参考 fnos-app-cleaner 链接残留）。
 * 规则：符号链接 target 包含 /var/apps/{app}/ 或 /volN/@appxxx/{app}/，且 app 未安装 → 残留链接。
 */
function scanLinkResiduals(installedSet) {
  const roots = ['/usr/local/bin', '/usr/local/lib', '/usr/local/sbin', '/usr/local/share', '/opt'];
  const links = [];
  const seen = new Set();
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch (e) { continue; }
    for (const name of names) {
      const lp = path.join(root, name);
      if (seen.has(lp)) continue;
      seen.add(lp);
      let st;
      try { st = fs.lstatSync(lp); } catch (e) { continue; }
      if (!st.isSymbolicLink()) continue;
      let target;
      try { target = fs.readlinkSync(lp); } catch (e) { continue; }
      const m = target.match(/\/(var\/apps|vol\d+\/@app[A-Za-z0-9_-]+)\/([^/]+)/);
      if (!m) continue;
      const app = m[2];
      if (installedSet.has(app.toLowerCase())) continue;
      // 校验 target 确实指向残留目录（防误删）
      const abs = target.startsWith('/') ? target : path.join(path.dirname(lp), target);
      if (!fs.existsSync(abs)) continue;
      links.push({ path: lp, target, app });
    }
  }
  return links;
}

/** 扫描 docker- 前缀残留用户（全名/去前缀双匹配） */
function scanOrphanUsers(installedSet) {
  const users = [];
  let passwd = '';
  try { passwd = fs.readFileSync('/etc/passwd', 'utf8'); } catch (e) { return users; }
  for (const line of passwd.split('\n')) {
    const m = line.match(/^(docker-[^\s:]+):/);
    if (!m) continue;
    const full = m[1];
    const app = full.slice('docker-'.length);
    if (installedSet.has(full.toLowerCase())) continue;
    if (installedSet.has(app.toLowerCase())) continue;
    users.push({ user: full, app });
  }
  return users;
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

// ---------------- 风险分级 ----------------

/** 残留目录风险分级：temp/链接=低，conf/meta=中，data/home/share/center=高 */
function riskOfType(type) {
  if (type === 'temp' || type === 'link') return 'low';
  if (type === 'conf' || type === 'meta') return 'medium';
  return 'high';
}

const RISK_LABEL = { low: '低', medium: '中', high: '高' };

/** 给孤儿目录补 risk 字段 */
function withRisk(orphans) {
  return orphans.map((o) => ({ ...o, risk: riskOfType(o.type), riskLabel: RISK_LABEL[riskOfType(o.type)] }));
}

// ---------------- 聚合（应用残留按应用聚合） ----------------

/** 把孤儿目录按应用聚合成卡片数据（fnos-app-cleaner 聚合展示思路） */
function aggregateOrphans(orphans) {
  const map = new Map();
  for (const o of orphans) {
    if (!map.has(o.app)) map.set(o.app, []);
    map.get(o.app).push(o);
  }
  const groups = [];
  for (const [app, items] of map) {
    const size = items.reduce((s, i) => s + (i.size || 0), 0);
    const risks = new Set(items.map((i) => i.risk));
    const groupRisk = risks.has('high') ? 'high' : (risks.has('medium') ? 'medium' : 'low');
    groups.push({
      app,
      count: items.length,
      size,
      sizeText: fmtSize(size),
      risk: groupRisk,
      riskLabel: RISK_LABEL[groupRisk],
      items: items.map((i) => ({ type: i.type, path: i.path, size: i.size, sizeText: fmtSize(i.size), risk: i.risk, riskLabel: i.riskLabel })),
    });
  }
  groups.sort((a, b) => b.size - a.size);
  return groups;
}

// ---------------- 扫描入口 ----------------

async function scanAll() {
  const apps = await getInstalledApps();
  const installedSet = new Set(apps.map((a) => a.toLowerCase()));
  const usedShares = collectUsedShares();
  const installedUsers = collectInstalledUsers(apps);
  const orphans = withRisk(scanOrphanDirs(installedSet, usedShares, installedUsers));
  const links = scanLinkResiduals(installedSet);
  const users = scanOrphanUsers(installedSet);
  const groups = aggregateOrphans(orphans);
  return {
    apps,
    orphans: orphans.map((o) => ({ ...o, sizeText: fmtSize(o.size) })),
    groups,
    links,
    users,
  };
}

// ---------------- manifest 备份 ----------------

/** 清理前把操作清单备份到数据目录 manifests/（fnclearup 优点：可回看） */
async function backupManifest(payload) {
  try {
    const dir = path.join(path.dirname(TRASH_DIR), 'manifests');
    await fsp.mkdir(dir, { recursive: true });
    const name = `clean-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const doc = {
      time: new Date().toISOString(),
      mode: payload.mode || 'trash',
      paths: payload.paths || [],
      links: payload.links || [],
      users: payload.users || [],
    };
    await fsp.writeFile(path.join(dir, name), JSON.stringify(doc, null, 2));
    return name;
  } catch (e) {
    return null; // 备份失败不阻断清理
  }
}

// ---------------- 删除 ----------------

async function deleteItems({ paths = [], links = [], users = [], mode = 'trash' }) {
  const permanent = mode === 'permanent';
  const failed = [];
  const moved = [];

  await backupManifest({ mode, paths, links, users });

  // 删除残留系统用户
  if (users.length) {
    const apps = await getInstalledApps();
    const installedSet = new Set(apps.map((a) => a.toLowerCase()));
    for (const u of users) {
      if (typeof u !== 'string' || !/^docker-[A-Za-z0-9_.-]+$/.test(u)) { failed.push(`${u} (用户名不合法)`); continue; }
      const app = u.slice('docker-'.length);
      if (installedSet.has(u.toLowerCase()) || installedSet.has(app.toLowerCase())) { failed.push(`${u} (应用已安装，拒绝删除)`); continue; }
      let exists = false;
      try {
        const pw = fs.readFileSync('/etc/passwd', 'utf8');
        exists = pw.split('\n').some((l) => l.startsWith(u + ':'));
      } catch (e) {}
      if (!exists) { failed.push(`${u} (用户不存在)`); continue; }
      const r = await run('userdel', [u], 15000);
      if (r.code === 0) moved.push({ user: u, action: 'userdel' });
      else failed.push(`${u} (${r.stderr.trim() || 'userdel 失败'})`);
    }
  }

  // 删除残留目录
  for (const target of paths) {
    if (!isSafeAppPath(target)) { failed.push(`${target} (路径不合法)`); continue; }
    let st;
    try { st = await fsp.lstat(target); } catch (e) { failed.push(`${target} (不存在)`); continue; }
    if (st.isSymbolicLink()) { failed.push(`${target} (符号链接，拒绝)`); continue; }
    const app = path.basename(target);
    const type = path.basename(path.dirname(target)).slice(4);
    try {
      if (permanent) {
        await fsp.rm(target, { recursive: true, force: true });
        moved.push({ path: target, action: 'permanent' });
      } else {
        const name = await moveToTrash(target, { app, type, mode: 'trash' });
        moved.push({ path: target, trash: name, action: 'trash' });
      }
    } catch (e) {
      failed.push(`${target} (${e.message})`);
    }
  }

  // 删除残留符号链接（链接无数据，直接删除即可，不占空间）
  for (const lp of links) {
    if (!isSafeLinkPath(lp)) { failed.push(`${lp} (路径不合法)`); continue; }
    let st;
    try { st = await fsp.lstat(lp); } catch (e) { failed.push(`${lp} (不存在)`); continue; }
    if (!st.isSymbolicLink()) { failed.push(`${lp} (非符号链接，拒绝)`); continue; }
    try {
      await fsp.unlink(lp);
      moved.push({ path: lp, action: 'link' });
    } catch (e) {
      failed.push(`${lp} (${e.message})`);
    }
  }

  return { moved, failed };
}

// ---------------- 回收站 ----------------

async function trashList() {
  const items = [];
  let names = [];
  try { names = await fsp.readdir(TRASH_DIR); } catch (e) { return items; }
  for (const name of names) {
    const dir = path.join(TRASH_DIR, name);
    let st;
    try { st = await fsp.stat(dir); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    // 元数据：同级 <name>.meta.json（新格式）；兼容旧版目录内 manifest.json
    let meta = null;
    try { meta = JSON.parse(await fsp.readFile(path.join(TRASH_DIR, name + '.meta.json'), 'utf8')); } catch (e) {
      try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')); } catch (e2) { meta = {}; }
    }
    items.push({
      name,
      original: meta.original || '',
      app: meta.app || '',
      type: meta.type || '',
      atime: st.mtimeMs,
      size: dirSize(dir),
    });
  }
  items.sort((a, b) => b.atime - a.atime);
  return items;
}

/** 移入回收站：目录移入 TRASH_DIR/<name>，元数据存同级 <name>.meta.json（不污染原目录内容） */
async function moveToTrash(p, meta) {
  await fsp.mkdir(TRASH_DIR, { recursive: true });
  const base = path.basename(p);
  const name = `${Date.now()}-${base}`;
  const dest = path.join(TRASH_DIR, name);
  await fsp.rename(p, dest);
  await fsp.writeFile(path.join(TRASH_DIR, name + '.meta.json'), JSON.stringify({ ...meta, original: p }, null, 2));
  return name;
}

async function trashRestore(names) {
  const failed = [];
  const restored = [];
  for (const name of names) {
    if (!isSafeTrashName(name)) { failed.push(`${name} (名称不合法)`); continue; }
    const dir = path.join(TRASH_DIR, name);
    let meta = {};
    try { meta = JSON.parse(await fsp.readFile(path.join(TRASH_DIR, name + '.meta.json'), 'utf8')); } catch (e) {
      try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')); } catch (e2) {}
    }
    if (!meta.original || !isSafeRestorePath(meta.original)) { failed.push(`${name} (无原始路径记录)`); continue; }
    try {
      await fsp.mkdir(path.dirname(meta.original), { recursive: true });
      if (meta.kind === 'file') {
        // tmp 单文件条目：目录内含原名文件，恢复文件后删除空目录（跨文件系统 EXDEV 复制+删除）
        const base = path.basename(meta.original);
        const src = path.join(dir, base);
        try {
          await fsp.rename(src, meta.original);
        } catch (e) {
          if (e.code !== 'EXDEV') throw e;
          await fsp.copyFile(src, meta.original);
          await fsp.unlink(src);
        }
        await fsp.rmdir(dir).catch(() => {});
      } else {
        await fsp.rename(dir, meta.original);
      }
      // 恢复成功：删除元数据文件
      await fsp.unlink(path.join(TRASH_DIR, name + '.meta.json')).catch(() => {});
      restored.push({ name, original: meta.original });
    } catch (e) {
      failed.push(`${name} (${e.message})`);
    }
  }
  return { restored, failed };
}

async function trashEmpty() {
  const items = await trashList();
  const failed = [];
  let removed = 0;
  for (const it of items) {
    try { await fsp.rm(path.join(TRASH_DIR, it.name), { recursive: true, force: true }); removed++; }
    catch (e) { failed.push(`${it.name} (${e.message})`); }
  }
  return { removed, failed };
}

module.exports = {
  scanAll,
  deleteItems,
  trashList,
  trashRestore,
  trashEmpty,
  isSafeAppPath,
  isSafeLinkPath,
};
