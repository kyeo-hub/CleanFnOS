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
const VERSION = '1.2.0';

// 数据目录（cmd/main 注入 TRIM_PKGVAR；未注入时退化到本地 var）
const VAR_DIR = process.env.TRIM_PKGVAR || path.join(__dirname, '..', '..', 'var');
process.env.TRASH_DIR = path.join(VAR_DIR, 'trash');

const appApi = require('./api/app.js');
const netdiskApi = require('./api/netdisk.js');
const dockerApi = require('./api/docker.js');
const tmpApi = require('./api/tmp.js');
const trashApi = require('./api/trash.js');
const emptyApi = require('./api/empty.js');

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

function checkAuth(req) {
  // 统一网关模式：fnOS 网关以 loopback 代理注入 X-Trim-Userid，仅在来源为本机时信任
  // （参考 fnos-logmanager：远端客户端可伪造该头，非 loopback 一律忽略）
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

// ---------------- 工具函数 ----------------

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
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

// ---------------- HTTP 路由 ----------------

const server = http.createServer(async (req, res) => {
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
      if (!fp.startsWith(uiDir)) { res.writeHead(403); res.end('Forbidden'); return; }
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
      sendJSON(res, 200, { success: r.failed.length === 0, moved: r.moved, failed: r.failed });
      return;
    }

    sendJSON(res, 404, { success: false, error: 'not found' });
  } catch (e) {
    sendJSON(res, 500, { success: false, error: String(e && e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CleanFnOS server listening on http://0.0.0.0:${PORT} (v${VERSION})`);
});
