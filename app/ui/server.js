#!/usr/bin/env node
/**
 * CleanFnOS - fnOS 应用残留清理工具 后端服务（零依赖 Node.js）
 * 路由层：统一鉴权 + 静态文件 + API 路由，扫描/清理/回收站逻辑在 api/ 模块。
 * API:
 *  POST /api/scan              -> { apps, orphans, groups, links, users }
 *  POST /api/delete            -> { paths:[], links:[], users:[], mode:'trash'|'permanent' }
 *  GET  /api/trash             -> 回收站列表
 *  POST /api/trash/restore     -> { names:[] }
 *  POST /api/trash/empty       -> {}
 *  GET  /api/version
 *  GET  /*                     静态文件（ui/ 目录）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '47939', 10);
const VERSION = '1.6.5';

// 数据目录（cmd/main 注入 TRIM_PKGVAR；未注入时退化到本地 var）
const VAR_DIR = process.env.TRIM_PKGVAR || path.join(__dirname, '..', '..', 'var');
process.env.TRASH_DIR = path.join(VAR_DIR, 'trash');

const appApi = require('./api/app.js');
const netdiskApi = require('./api/netdisk.js');
const dockerApi = require('./api/docker.js');
const tmpApi = require('./api/tmp.js');
const trashApi = require('./api/trash.js');
const emptyApi = require('./api/empty.js');
const dupApi = require('./api/dup.js');
const bigfilesApi = require('./api/bigfiles.js');
const syscleanApi = require('./api/sysclean.js');
const scheduleApi = require('./api/schedule.js');
const kvmApi = require('./api/kvm.js');
const notifyApi = require('./api/notify.js');

// ---------------- token 鉴权 ----------------
const CONFIG_FILE = process.env.TRIM_PKGETC ? path.join(process.env.TRIM_PKGETC, 'config.conf') : null;
let AUTH_TOKEN = '';

function loadAuthToken() {
  if (!CONFIG_FILE) return;
  try {
    const conf = fs.readFileSync(CONFIG_FILE, 'utf8');
    const m = conf.match(/^auth_token\s*=\s*(\S+)/m);
    if (m && m[1]) AUTH_TOKEN = m[1].trim();
  } catch (e) {}
  if (!AUTH_TOKEN) {
    AUTH_TOKEN = crypto.randomBytes(16).toString('hex');
    try { fs.appendFileSync(CONFIG_FILE, `\nauth_token=${AUTH_TOKEN}\n`); } catch (e) {}
  }
}
loadAuthToken();

// 统一网关（fnOS 1.2.0401+）：GATEWAY_SOCKET 注入 unix socket 路径，GATEWAY_PREFIX 为 /app/cleanfnos
const GATEWAY_SOCKET = process.env.GATEWAY_SOCKET || '';
const GATEWAY_PREFIX = process.env.GATEWAY_PREFIX || '';

function checkAuth(req) {
  // 统一网关模式：请求经 fnOS 网关代理（unix socket）转发，网关注入 X-Trim-Userid 登录态。
  // unix socket 仅本机进程可达（nginx 网关注入），故来自 socket 的 X-Trim-Userid 可信；
  // 无论来源如何，token（X-Auth-Token）始终作为兜底鉴权。
  if (req.fromGatewaySocket && req.headers['x-trim-userid']) {
    return true;
  }
  const isLoopback = (() => {
    const addr = req.socket && req.socket.remoteAddress;
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  })();
  if (isLoopback && req.headers['x-trim-userid']) {
    return true;
  }
  if (!AUTH_TOKEN) return true;
  const h = req.headers['x-auth-token'];
  if (!h) return false;
  try {
    const a = Buffer.from(h.trim());
    const b = Buffer.from(AUTH_TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

/** 恒时比较两个 token 是否相等 */
function tokenEquals(a, b) {
  try {
    const ba = Buffer.from(String(a || ''));
    const bb = Buffer.from(String(b || ''));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch (e) { return false; }
}

/** 修改访问密码：校验旧密码，更新 config.conf 的 auth_token 行，同步内存 */
function changeAuthToken(oldToken, newToken) {
  if (typeof newToken !== 'string' || newToken.length < 4 || newToken.length > 64) {
    return { ok: false, message: '新密码长度须为 4-64 个字符' };
  }
  if (!tokenEquals(oldToken, AUTH_TOKEN)) {
    return { ok: false, message: '当前密码不正确' };
  }
  if (CONFIG_FILE) {
    try {
      let conf = fs.readFileSync(CONFIG_FILE, 'utf8');
      if (/^auth_token\s*=/m.test(conf)) {
        conf = conf.replace(/^auth_token\s*=.*$/m, `auth_token=${newToken}`);
      } else {
        conf += `\nauth_token=${newToken}\n`;
      }
      fs.writeFileSync(CONFIG_FILE, conf);
    } catch (e) {
      return { ok: false, message: '写入配置文件失败: ' + String(e && e.message || e) };
    }
  }
  AUTH_TOKEN = newToken;
  return { ok: true, message: '密码已修改' };
}

// ---------------- 工具函数 ----------------

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // 同源应用（桌面 iframe 由飞牛代理），不开放跨域
    'Access-Control-Allow-Origin': 'null',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5 * 1024 * 1024) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/** 操作审计：追加写入数据目录 operation.log（JSON 行，含时间/类型/结果） */
function auditLog(type, detail) {
  try {
    const line = JSON.stringify({ time: new Date().toISOString(), type, ...detail }) + '\n';
    fs.appendFileSync(path.join(VAR_DIR, 'operation.log'), line);
  } catch (e) { /* 审计失败不阻断操作 */ }
}

// ---------------- HTTP 路由 ----------------

/** 统一请求处理器：网关模式先剥离 /app/cleanfnos 前缀，再按路径路由 */
async function handleRequest(req, res) {
  // 统一网关：nginx 把 /app/cleanfnos/xxx 原样转发到 unix socket，需剥离前缀
  if (GATEWAY_PREFIX && req.url && req.url.startsWith(GATEWAY_PREFIX)) {
    req.url = req.url.slice(GATEWAY_PREFIX.length) || '/';
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const method = req.method;

  try {
    // API 请求统一鉴权（静态文件与 /api/version 除外）
    if (p.startsWith('/api/') && p !== '/api/version') {
      if (!checkAuth(req)) {
        sendJSON(res, 401, { success: false, error: 'unauthorized', code: 401 });
        return;
      }
    }

    // 静态文件
    if (method === 'GET' && !p.startsWith('/api/')) {
      const uiDir = __dirname;
      let rel = p === '/' ? 'index.html' : p.slice(1);
      const fp = path.normalize(path.join(uiDir, rel));
      // 严格路径校验：必须位于 uiDir 内（防前缀穿越，如 /ui_evil）
      if (fp !== uiDir && !fp.startsWith(uiDir + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
      let data;
      try { data = await fsp.readFile(fp); } catch (e) { res.writeHead(404); res.end('Not Found'); return; }
      const ext = path.extname(fp).toLowerCase();
      const mime = {
        '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
      }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
      res.end(data);
      return;
    }

    // /api/version
    if (method === 'GET' && p === '/api/version') {
      sendJSON(res, 200, { version: VERSION, success: true });
      return;
    }

    // POST /api/scan
    if (method === 'POST' && p === '/api/scan') {
      const data = await appApi.scanAll();
      sendJSON(res, 200, { success: true, ...data });
      return;
    }

    // POST /api/delete
    if (method === 'POST' && p === '/api/delete') {
      const body = await readBody(req);
      const mode = body.mode === 'permanent' ? 'permanent' : 'trash';
      const r = await appApi.deleteItems({
        paths: Array.isArray(body.paths) ? body.paths : [],
        links: Array.isArray(body.links) ? body.links : [],
        users: Array.isArray(body.users) ? body.users : [],
        mode,
      });
      auditLog('app-delete', { mode, paths: (body.paths || []).length, links: (body.links || []).length, users: (body.users || []).length, moved: r.moved.length, failed: r.failed.length });
      sendJSON(res, 200, { success: r.failed.length === 0, moved: r.moved, failed: r.failed });
      return;
    }

    // GET /api/trash
    if (method === 'GET' && p === '/api/trash') {
      const items = await appApi.trashList();
      const fmt = (n) => {
        if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
        if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
        if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
        return n + ' B';
      };
      sendJSON(res, 200, { success: true, items: items.map((i) => ({ ...i, sizeText: fmt(i.size) })) });
      return;
    }

    // POST /api/trash/restore
    if (method === 'POST' && p === '/api/trash/restore') {
      const body = await readBody(req);
      const r = await appApi.trashRestore(Array.isArray(body.names) ? body.names : []);
      sendJSON(res, 200, { success: r.failed.length === 0, restored: r.restored, failed: r.failed });
      return;
    }

    // POST /api/trash/empty
    if (method === 'POST' && p === '/api/trash/empty') {
      const r = await appApi.trashEmpty();
      auditLog('trash-empty', { removed: r.removed, failed: r.failed.length });
      sendJSON(res, 200, { success: r.failed.length === 0, removed: r.removed, failed: r.failed });
      return;
    }

    // ---- M2 模块路由 ----

    // POST /api/netdisk/scan
    if (method === 'POST' && p === '/api/netdisk/scan') {
      const items = netdiskApi.scanNetdiskResiduals();
      sendJSON(res, 200, { success: true, items });
      return;
    }

    // POST /api/netdisk/delete
    if (method === 'POST' && p === '/api/netdisk/delete') {
      const body = await readBody(req);
      const mode = body.mode === 'permanent' ? 'permanent' : 'trash';
      const r = await netdiskApi.deleteNetdiskItems({
        paths: Array.isArray(body.paths) ? body.paths : [],
        mode,
      });
      auditLog('netdisk-delete', { mode, paths: (body.paths || []).length, moved: r.moved.length, failed: r.failed.length });
      sendJSON(res, 200, { success: r.failed.length === 0, moved: r.moved, failed: r.failed });
      return;
    }

    // POST /api/docker/scan
    if (method === 'POST' && p === '/api/docker/scan') {
      const r = await dockerApi.scanDocker();
      sendJSON(res, 200, { success: true, ...r });
      return;
    }

    // POST /api/docker/delete
    if (method === 'POST' && p === '/api/docker/delete') {
      const body = await readBody(req);
      const r = await dockerApi.deleteDocker({
        containers: Array.isArray(body.containers) ? body.containers : [],
        volumes: Array.isArray(body.volumes) ? body.volumes : [],
        networks: Array.isArray(body.networks) ? body.networks : [],
        images: Array.isArray(body.images) ? body.images : [],
        buildCache: !!body.buildCache,
      });
      auditLog('docker-delete', { containers: (body.containers || []).length, volumes: (body.volumes || []).length, networks: (body.networks || []).length, images: (body.images || []).length, buildCache: !!body.buildCache, moved: r.moved.length, failed: r.failed.length });
      sendJSON(res, 200, { success: r.failed.length === 0, moved: r.moved, failed: r.failed });
      return;
    }

    // POST /api/tmp/scan
    if (method === 'POST' && p === '/api/tmp/scan') {
      const items = tmpApi.scanTmp();
      sendJSON(res, 200, { success: true, items });
      return;
    }

    // POST /api/tmp/delete
    if (method === 'POST' && p === '/api/tmp/delete') {
      const body = await readBody(req);
      const mode = body.mode === 'permanent' ? 'permanent' : 'trash';
      const r = await tmpApi.deleteTmpFiles({
        paths: Array.isArray(body.paths) ? body.paths : [],
        mode,
      });
      auditLog('tmp-delete', { mode, paths: (body.paths || []).length, moved: r.moved.length, failed: r.failed.length });
      sendJSON(res, 200, { success: r.failed.length === 0, moved: r.moved, failed: r.failed });
      return;
    }

    // POST /api/trash/system（扫描系统回收站 .@#local/trash）
    if (method === 'POST' && p === '/api/trash/system') {
      const items = trashApi.scanSystemTrash();
      const summary = trashApi.summarizeTrash(items);
      sendJSON(res, 200, { success: true, items, summary });
      return;
    }

    // POST /api/trash/system/delete
    if (method === 'POST' && p === '/api/trash/system/delete') {
      const body = await readBody(req);
      const r = await trashApi.deleteTrashItems({ paths: Array.isArray(body.paths) ? body.paths : [] });
      auditLog('sys-trash-delete', { paths: (body.paths || []).length, removed: r.removed.length, failed: r.failed.length });
      sendJSON(res, 200, { success: r.failed.length === 0, removed: r.removed, failed: r.failed });
      return;
    }

    // POST /api/empty/scan
    if (method === 'POST' && p === '/api/empty/scan') {
      const body = await readBody(req);
      const r = emptyApi.scanEmpty({ root: body.root || '/vol1' });
      if (r.error) { sendJSON(res, 400, { success: false, error: r.error }); return; }
      sendJSON(res, 200, { success: true, root: r.root, dirs: r.dirs });
      return;
    }

    // POST /api/empty/delete
    if (method === 'POST' && p === '/api/empty/delete') {
      const body = await readBody(req);
      const mode = body.mode === 'permanent' ? 'permanent' : 'trash';
      const r = await emptyApi.deleteEmptyDirs({
        paths: Array.isArray(body.paths) ? body.paths : [],
        mode,
      });
      auditLog('empty-delete', { mode, paths: (body.paths || []).length, moved: r.moved.length, failed: r.failed.length });
      sendJSON(res, 200, { success: r.failed.length === 0, moved: r.moved, failed: r.failed });
      return;
    }

    // ---- M3 模块路由 ----

    // POST /api/dup/scan
    if (method === 'POST' && p === '/api/dup/scan') {
      const body = await readBody(req);
      const type = body.type === 'music' ? 'music' : 'files';
      const r = await dupApi.scanDup({
        type,
        paths: Array.isArray(body.paths) ? body.paths : [],
      });
      if (r.error) { sendJSON(res, 400, { success: false, error: r.error }); return; }
      sendJSON(res, 200, { success: true, ...r });
      return;
    }

    // POST /api/dup/fingerprint —— 音乐指纹去重（Chromaprint fpcalc）
    if (method === 'POST' && p === '/api/dup/fingerprint') {
      const body = await readBody(req);
      const r = await dupApi.scanMusicFingerprint({
        paths: Array.isArray(body.paths) ? body.paths : [],
      });
      if (r.error) { sendJSON(res, 400, { success: false, error: r.error }); return; }
      sendJSON(res, 200, { success: true, ...r });
      return;
    }

    // POST /api/dup/delete
    if (method === 'POST' && p === '/api/dup/delete') {
      const body = await readBody(req);
      const mode = body.mode === 'permanent' ? 'permanent' : 'trash';
      const r = await dupApi.deleteDupFiles({
        files: Array.isArray(body.files) ? body.files : [],
        mode,
      });
      auditLog('dup-delete', { mode, files: (body.files || []).length, moved: r.moved.length, failed: r.failed.length });
      sendJSON(res, 200, { success: r.failed.length === 0, moved: r.moved, failed: r.failed });
      return;
    }

    // POST /api/bigfiles/scan
    if (method === 'POST' && p === '/api/bigfiles/scan') {
      const body = await readBody(req);
      const r = bigfilesApi.scanBigFiles({
        rootPath: body.rootPath || '/vol*',
        minSize: body.minSize,
        topN: body.topN,
        depth: body.depth,
      });
      if (r.error) { sendJSON(res, 400, { success: false, error: r.error }); return; }
      sendJSON(res, 200, { success: true, ...r });
      return;
    }

    // POST /api/sysclean/scan
    if (method === 'POST' && p === '/api/sysclean/scan') {
      const items = syscleanApi.scanSysClean();
      sendJSON(res, 200, { success: true, items });
      return;
    }

    // POST /api/sysclean/delete
    if (method === 'POST' && p === '/api/sysclean/delete') {
      const body = await readBody(req);
      const r = await syscleanApi.sysCleanDelete({ paths: Array.isArray(body.paths) ? body.paths : [] });
      auditLog('sysclean-delete', { paths: (body.paths || []).length, cleaned: r.cleaned.length, failed: r.failed.length, totalBytes: r.totalBytes });
      // 部分清理项失败时返回真实原因，避免前端只看到 HTTP 200
      const failedMsg = r.failed.length ? '部分清理项失败：' + r.failed.slice(0, 5).join('；') : undefined;
      sendJSON(res, 200, { success: r.failed.length === 0, error: failedMsg, cleaned: r.cleaned, failed: r.failed, totalBytes: r.totalBytes });
      return;
    }

    // GET /api/schedule（配置）
    if (method === 'GET' && p === '/api/schedule') {
      sendJSON(res, 200, { success: true, config: scheduleApi.getConfig() });
      return;
    }

    // POST /api/schedule（保存配置）
    if (method === 'POST' && p === '/api/schedule') {
      const body = await readBody(req);
      const cfg = await scheduleApi.setConfig(body);
      sendJSON(res, 200, { success: true, config: cfg });
      return;
    }

    // POST /api/schedule/run（立即执行）
    if (method === 'POST' && p === '/api/schedule/run') {
      const r = await scheduleApi.runNow();
      sendJSON(res, 200, { success: true, report: r });
      return;
    }

    // GET /api/schedule/reports（报告列表）
    if (method === 'GET' && p === '/api/schedule/reports') {
      sendJSON(res, 200, { success: true, reports: scheduleApi.listReports() });
      return;
    }

    // GET /api/schedule/report?name=xxx（单份报告）
    if (method === 'GET' && p === '/api/schedule/report') {
      const name = url.searchParams.get('name') || '';
      const r = scheduleApi.getReport(name);
      if (!r) { sendJSON(res, 404, { success: false, error: 'report not found' }); return; }
      sendJSON(res, 200, { success: true, report: r });
      return;
    }

    // ---- M4 模块路由 ----

    // POST /api/kvm/scan
    if (method === 'POST' && p === '/api/kvm/scan') {
      const r = await kvmApi.scanKvm();
      sendJSON(res, 200, { success: true, ...r });
      return;
    }

    // POST /api/kvm/delete（删除鬼影快照）
    if (method === 'POST' && p === '/api/kvm/delete') {
      const body = await readBody(req);
      const r = await kvmApi.deleteGhostSnapshots({
        snapshots: Array.isArray(body.snapshots) ? body.snapshots : [],
      });
      auditLog('kvm-delete', { snapshots: (body.snapshots || []).length, removed: r.removed.length, failed: r.failed.length });
      sendJSON(res, 200, { success: r.failed.length === 0, removed: r.removed, failed: r.failed });
      return;
    }

    // POST /api/kvm/vm（VM 启停管理）
    if (method === 'POST' && p === '/api/kvm/vm') {
      const body = await readBody(req);
      const r = await kvmApi.vmAction({ vm: body.vm, action: body.action });
      sendJSON(res, 200, r);
      return;
    }

    // ---- M5 模块路由 ----

    // POST /api/password（修改访问密码，需校验旧密码）
    if (method === 'POST' && p === '/api/password') {
      const body = await readBody(req);
      const r = changeAuthToken(body.oldPassword || '', body.newPassword || '');
      sendJSON(res, r.ok ? 200 : 400, { success: r.ok, message: r.message });
      return;
    }

    // GET /api/notify（通知配置 + 渠道元数据）
    if (method === 'GET' && p === '/api/notify') {
      sendJSON(res, 200, { success: true, config: notifyApi.getNotifyConfig(), channels: notifyApi.CHANNEL_META });
      return;
    }

    // POST /api/notify（保存通知配置）
    if (method === 'POST' && p === '/api/notify') {
      const body = await readBody(req);
      const cfg = notifyApi.setNotifyConfig(body);
      sendJSON(res, 200, { success: true, config: cfg });
      return;
    }

    // POST /api/notify/test（测试发送）
    if (method === 'POST' && p === '/api/notify/test') {
      const body = await readBody(req);
      const r = await notifyApi.testNotify(body.channel || '');
      sendJSON(res, 200, { success: r.ok, ...r });
      return;
    }

    sendJSON(res, 404, { success: false, error: 'not found' });
  } catch (e) {
    // 500 错误不暴露内部细节（防路径/堆栈泄露），详情写入服务端日志
    try { fs.appendFileSync(path.join(VAR_DIR, 'info.log'), `${new Date().toISOString()} [server-error] ${String(e && e.stack || e)}\n`); } catch (e2) { /* 忽略 */ }
    sendJSON(res, 500, { success: false, error: 'internal error' });
  }
}

// 初始化定时清理（注入数据目录与 api 模块引用）
scheduleApi.initSchedule(VAR_DIR, {
  app: appApi,
  netdisk: netdiskApi,
  docker: dockerApi,
  tmp: tmpApi,
  trash: trashApi,
  notify: notifyApi,
});

// 初始化通知配置（注入数据目录）
notifyApi.initNotify(VAR_DIR);

// ---- 双监听：TCP 端口（保留 token 兜底）+ 统一网关 unix socket（登录免密） ----

// TCP 服务（直连端口场景，仍需 token 鉴权）
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    try { sendJSON(res, 500, { success: false, error: 'internal error' }); } catch (e2) { /* 忽略 */ }
  });
});
// 指纹去重/系统清理等操作可能耗时数分钟，禁用 Node 18+ 默认 300s 请求超时（否则大曲库扫描被强关）
server.requestTimeout = 0;
server.headersTimeout = 0;

// 统一网关服务（fnOS 1.2.0401+）：监听 unix socket，网关注入 X-Trim-Userid 后免密
if (GATEWAY_SOCKET) {
  try {
    if (fs.existsSync(GATEWAY_SOCKET)) fs.unlinkSync(GATEWAY_SOCKET);
    const gwServer = http.createServer((req, res) => {
      req.fromGatewaySocket = true; // 标记来源：unix socket 仅本机网关注入，信任 X-Trim-Userid
      handleRequest(req, res).catch((e) => {
        try { sendJSON(res, 500, { success: false, error: 'internal error' }); } catch (e2) { /* 忽略 */ }
      });
    });
    gwServer.requestTimeout = 0;
    gwServer.headersTimeout = 0;
    gwServer.listen(GATEWAY_SOCKET, () => {
      try { fs.chmodSync(GATEWAY_SOCKET, 0o660); } catch (e) { /* 权限设置失败忽略 */ }
      console.log(`CleanFnOS gateway socket listening on ${GATEWAY_SOCKET}`);
    });
  } catch (e) {
    console.error('CleanFnOS gateway socket failed: ' + String(e && e.message || e));
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CleanFnOS server listening on http://0.0.0.0:${PORT} (v${VERSION})`);
});
