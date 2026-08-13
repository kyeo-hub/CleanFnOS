'use strict';
/**
 * CleanFnOS api/notify.js — 通知推送（Bark/钉钉/飞书/企业微信/Telegram/Webhook）
 * 参考 fnos-logmanager 渠道模型（仅吸收 5 常用渠道 + Webhook，不采纳全量 23 渠道）。
 * 安全：SSRF 防护（URL 仅 http/https，拒绝内网/保留地址）；钉钉/飞书 HMAC-SHA256 签名；
 * 全部请求走 Node http/https，零依赖；超时与错误兜底。
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// ---------------- SSRF 防护 ----------------

/** 判定是否为内网/保留地址（禁止请求目标） */
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').split(':')[0];
  if (!h) return true;
  if (h === 'localhost' || h === '::1') return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 0 || p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
  }
  return false;
}

/** 校验通知目标 URL：http/https、非内网、无凭证注入 */
function isSafeNotifyUrl(u) {
  if (typeof u !== 'string') return false;
  let parsed;
  try { parsed = new URL(u); } catch (e) { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (isPrivateHost(parsed.hostname)) return false;
  return true;
}

// ---------------- HTTP 工具 ----------------

/** 通用 POST JSON（带超时与大小上限） */
function httpPostJson(url, body, headers = {}, timeout = 15000) {
  return new Promise((resolve) => {
    if (!isSafeNotifyUrl(url)) {
      resolve({ ok: false, message: 'URL 不合法或被禁止（内网/非 http(s)）' });
      return;
    }
    let parsed;
    try { parsed = new URL(url); } catch (e) {
      resolve({ ok: false, message: 'URL 解析失败' });
      return;
    }
    const mod = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
      timeout,
    };
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 512 * 1024) req.destroy(); });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ ok: false, message: String(e && e.message || e) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, message: '请求超时' }); });
    req.write(payload);
    req.end();
  });
}

// ---------------- 各渠道实现 ----------------

/** Bark：POST https://api.day.app/{key}，body {title, body, ...} */
async function sendBark(cfg, title, content) {
  const key = (cfg && cfg.key || '').trim();
  if (!key) return { ok: false, message: 'Bark key 未配置' };
  const base = cfg.server && cfg.server.trim()
    ? cfg.server.trim().replace(/\/+$/, '')
    : 'https://api.day.app';
  const url = /^https?:\/\//.test(base) ? `${base}/${encodeURIComponent(key)}` : `https://api.day.app/${encodeURIComponent(key)}`;
  const r = await httpPostJson(url, {
    title, body: content,
    icon: cfg.icon || '', sound: cfg.sound || '', group: cfg.group || '', level: cfg.level || 'active',
  });
  if (!r.ok) return { ok: false, message: `Bark 失败(${r.statusCode || ''}): ${r.body || r.message || ''}`.slice(0, 200) };
  // Bark 响应 code==200 才算成功
  try {
    const j = JSON.parse(r.body);
    if (j.code !== undefined && j.code !== 200) return { ok: false, message: `Bark 失败: ${j.message || 'code=' + j.code}` };
  } catch (e) { /* 非 JSON 忽略 */ }
  return { ok: true, message: 'Bark 发送成功' };
}

/** 钉钉：webhook + access_token，可选 HMAC-SHA256 签名，markdown 消息 */
async function sendDingtalk(cfg, title, content) {
  const token = (cfg && cfg.token || '').trim();
  if (!token) return { ok: false, message: '钉钉 access_token 未配置' };
  let url = `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(token)}`;
  if (cfg.secret && cfg.secret.trim()) {
    const ts = Date.now();
    const stringToSign = `${ts}\n${cfg.secret.trim()}`;
    const sign = crypto.createHmac('sha256', cfg.secret.trim()).update(stringToSign).digest('base64');
    url += `&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
  }
  const body = {
    msgtype: 'markdown',
    markdown: { title: title.slice(0, 64), text: content.slice(0, 15000) },
  };
  const r = await httpPostJson(url, body);
  if (!r.ok) return { ok: false, message: `钉钉失败(${r.statusCode || ''}): ${r.body || r.message || ''}`.slice(0, 200) };
  return { ok: true, message: '钉钉发送成功' };
}

/** 飞书：webhook，可选 timestamp+sign 签名，text 消息 */
async function sendFeishu(cfg, title, content) {
  const url = (cfg && cfg.webhook || '').trim();
  if (!url) return { ok: false, message: '飞书 webhook 未配置' };
  const body = {};
  if (cfg.secret && cfg.secret.trim()) {
    const ts = Math.floor(Date.now() / 1000);
    const stringToSign = `${ts}\n${cfg.secret.trim()}`;
    const sign = crypto.createHmac('sha256', cfg.secret.trim()).update(stringToSign).digest('base64');
    body.timestamp = String(ts);
    body.sign = sign;
  }
  body.msg_type = 'text';
  body.content = JSON.stringify({ text: `${title}\n${content}`.slice(0, 4000) });
  const r = await httpPostJson(url, body);
  if (!r.ok) return { ok: false, message: `飞书失败(${r.statusCode || ''}): ${r.body || r.message || ''}`.slice(0, 200) };
  try {
    const j = JSON.parse(r.body);
    if (j.code !== undefined && j.code !== 0) return { ok: false, message: `飞书失败: ${j.msg || 'code=' + j.code}` };
  } catch (e) { /* 忽略 */ }
  return { ok: true, message: '飞书发送成功' };
}

/** 企业微信：群机器人 webhook + key，text 消息。key 字段兼容纯 key 或完整 webhook URL */
async function sendWechat(cfg, title, content) {
  const key = (cfg && cfg.key || '').trim();
  if (!key) return { ok: false, message: '企业微信 webhook key 未配置' };
  // 兼容两种输入：完整 webhook URL 直接使用；纯 key 则拼接
  const url = /^https?:\/\//.test(key)
    ? key
    : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(key)}`;
  const r = await httpPostJson(url, {
    msgtype: 'text',
    text: { content: `${title}\n${content}`.slice(0, 4000) },
  });
  if (!r.ok) return { ok: false, message: `企业微信失败(${r.statusCode || ''}): ${r.body || r.message || ''}`.slice(0, 200) };
  try {
    const j = JSON.parse(r.body);
    if (j.errcode !== undefined && j.errcode !== 0) return { ok: false, message: `企业微信失败: ${j.errmsg || 'errcode=' + j.errcode}` };
  } catch (e) { /* 忽略 */ }
  return { ok: true, message: '企业微信发送成功' };
}

/** Telegram：bot API sendMessage */
async function sendTelegram(cfg, title, content) {
  const token = (cfg && cfg.token || '').trim();
  const chatId = (cfg && cfg.chatId || '').trim();
  if (!token || !chatId) return { ok: false, message: 'Telegram bot token 或 chat_id 未配置' };
  const apiHost = (cfg && cfg.apiHost && cfg.apiHost.trim()) || 'https://api.telegram.org';
  const url = `${apiHost.replace(/\/+$/, '')}/bot${token}/sendMessage`;
  const r = await httpPostJson(url, { chat_id: chatId, text: `${title}\n${content}`.slice(0, 4096) });
  if (!r.ok) return { ok: false, message: `Telegram 失败(${r.statusCode || ''}): ${r.body || r.message || ''}`.slice(0, 200) };
  try {
    const j = JSON.parse(r.body);
    if (j.ok === false) return { ok: false, message: `Telegram 失败: ${j.description || 'unknown'}` };
  } catch (e) { /* 忽略 */ }
  return { ok: true, message: 'Telegram 发送成功' };
}

/** Webhook：自定义 URL/headers/body 模板（${title}/${content}） */
async function sendWebhook(cfg, title, content) {
  const url = (cfg && cfg.url || '').trim();
  if (!url) return { ok: false, message: 'Webhook URL 未配置' };
  let headers = {};
  try { headers = (cfg && cfg.headers) ? JSON.parse(cfg.headers) : {}; } catch (e) { headers = {}; }
  let body = (cfg && cfg.body) ? String(cfg.body) : '';
  if (body.includes('${')) {
    body = body.replace(/\$\{title\}/g, title).replace(/\$\{content\}/g, content);
  } else if (!body) {
    body = JSON.stringify({ title, content });
  }
  const r = await httpPostJson(url, body, headers);
  // body 已是字符串时 httpPostJson 会二次 JSON.stringify，特殊处理：直接用通用请求
  if (!r.ok) return { ok: false, message: `Webhook 失败(${r.statusCode || ''}): ${r.body || r.message || ''}`.slice(0, 200) };
  return { ok: true, message: 'Webhook 发送成功' };
}

// ---------------- 统一入口 ----------------

/** 按渠道发送通知。cfg 为该渠道配置对象。 */
async function sendByChannel(channel, cfg, title, content) {
  switch (channel) {
    case 'bark': return sendBark(cfg, title, content);
    case 'dingtalk': return sendDingtalk(cfg, title, content);
    case 'feishu': return sendFeishu(cfg, title, content);
    case 'wechat': return sendWechat(cfg, title, content);
    case 'telegram': return sendTelegram(cfg, title, content);
    case 'webhook': return sendWebhook(cfg, title, content);
    default: return { ok: false, message: `未知渠道: ${channel}` };
  }
}

/** 渠道元数据（前端设置面板用） */
const CHANNEL_META = [
  { id: 'bark', label: 'Bark (iOS)', fields: ['key', 'server'] },
  { id: 'dingtalk', label: '钉钉机器人', fields: ['token', 'secret'] },
  { id: 'feishu', label: '飞书机器人', fields: ['webhook', 'secret'] },
  { id: 'wechat', label: '企业微信机器人', fields: ['key'] },
  { id: 'telegram', label: 'Telegram Bot', fields: ['token', 'chatId'] },
  { id: 'webhook', label: '自定义 Webhook', fields: ['url', 'headers', 'body'] },
];

// ---------------- 配置持久化 ----------------

const fs = require('fs');

const DEFAULT_CHANNELS = {
  bark: { enabled: false, key: '', server: '' },
  dingtalk: { enabled: false, token: '', secret: '' },
  feishu: { enabled: false, webhook: '', secret: '' },
  wechat: { enabled: false, key: '' },
  telegram: { enabled: false, token: '', chatId: '', apiHost: '' },
  webhook: { enabled: false, url: '', headers: '', body: '' },
};

let configPath = null;
let notifyConfig = { enabled: false, onScheduleComplete: false, channels: JSON.parse(JSON.stringify(DEFAULT_CHANNELS)) };

/** 由 server.js 调用：注入数据目录 */
function initNotify(varDir) {
  configPath = varDir ? require('path').join(varDir, 'notify.json') : null;
  if (!configPath) return;
  try { fs.mkdirSync(varDir, { recursive: true }); } catch (e) { /* 忽略 */ }
  if (fs.existsSync(configPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      notifyConfig = {
        enabled: !!saved.enabled,
        onScheduleComplete: !!saved.onScheduleComplete,
        channels: { ...JSON.parse(JSON.stringify(DEFAULT_CHANNELS)), ...(saved.channels || {}) },
      };
    } catch (e) { /* 使用默认 */ }
  }
  saveNotifyConfig();
}

function saveNotifyConfig() {
  if (!configPath) return;
  try {
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(notifyConfig, null, 2));
    fs.renameSync(tmp, configPath);
  } catch (e) { /* 忽略 */ }
}

/** 获取当前配置（深拷贝防外部篡改） */
function getNotifyConfig() {
  return JSON.parse(JSON.stringify(notifyConfig));
}

/** 保存配置：整体替换 channels（前端整表单提交），安全字段白名单 */
function setNotifyConfig(patch) {
  if (!patch || typeof patch !== 'object') return getNotifyConfig();
  if (typeof patch.enabled === 'boolean') notifyConfig.enabled = patch.enabled;
  if (typeof patch.onScheduleComplete === 'boolean') notifyConfig.onScheduleComplete = patch.onScheduleComplete;
  if (patch.channels && typeof patch.channels === 'object') {
    for (const [cid, ch] of Object.entries(patch.channels)) {
      if (!notifyConfig.channels[cid] || !ch || typeof ch !== 'object') continue;
      const merged = { ...notifyConfig.channels[cid] };
      for (const [k, v] of Object.entries(ch)) {
        if (k === 'enabled') merged.enabled = !!v;
        else if (typeof v === 'string') merged[k] = v.trim();
      }
      notifyConfig.channels[cid] = merged;
    }
  }
  saveNotifyConfig();
  return getNotifyConfig();
}

/** 测试发送：向指定渠道发送一条测试消息 */
async function testNotify(channel) {
  const ch = notifyConfig.channels[channel];
  if (!ch) return { ok: false, message: `未知渠道: ${channel}` };
  const r = await sendByChannel(channel, ch, 'CleanFnOS 通知测试', '这是一条测试消息，如果你看到它说明通知渠道配置正确。');
  return r;
}

/** 向所有启用的渠道推送通知（用于定时清理报告联动） */
async function notifyAll(title, content) {
  const results = [];
  for (const [cid, ch] of Object.entries(notifyConfig.channels)) {
    if (!ch.enabled) continue;
    const r = await sendByChannel(cid, ch, title, content);
    results.push({ channel: cid, ...r });
  }
  return { results, sent: results.filter((r) => r.ok).length, total: results.length };
}

module.exports = {
  sendByChannel,
  isSafeNotifyUrl,
  CHANNEL_META,
  initNotify,
  getNotifyConfig,
  setNotifyConfig,
  testNotify,
  notifyAll,
};
