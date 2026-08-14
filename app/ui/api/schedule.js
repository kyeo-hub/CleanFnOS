'use strict';
/**
 * CleanFnOS api/schedule.js — 定时清理计划（5 种类型 + 清理报告）
 * 参考 fnclearup：应用残余 / 网盘 / Docker / tmp / 回收站 五种类型，
 * 可配置间隔自动执行并生成清理报告。配置持久化到数据目录 schedule.json。
 * 实现：模块内直接调用各 api 模块（app/netdisk/docker/tmp/trash），
 * 无需自调 HTTP；由 cmd/main 在启动时调用 initSchedule() 激活定时器。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// ---------------- 默认配置 ----------------

const DEFAULT_CONFIG = {
  enabled: false,
  hour: 3,            // 每日首次执行小时
  minute: 0,
  intervalHours: 24,  // 执行间隔
  cleanupTypes: {
    app: { enabled: false },
    netdisk: { enabled: false },
    docker: { enabled: false },
    tmp: { enabled: false, olderThanHours: 24 },
    trash: { enabled: false, olderThanDays: 30 },
  },
  lastRun: null,
  nextRun: null,
  runCount: 0,
};

let configPath = null;
let reportsDir = null;
let config = { ...DEFAULT_CONFIG };
let timerHandle = null;
let isRunning = false;
let apiModules = null;
let notifyApi = null; // M5 通知模块引用（清理完成后推送报告）

// ---------------- 初始化 ----------------

/** 由 server.js 调用：注入数据目录与 api 模块引用（含 notify 模块用于清理报告推送） */
function initSchedule(varDir, mods) {
  configPath = path.join(varDir, 'schedule.json');
  reportsDir = path.join(varDir, 'schedule_reports');
  apiModules = mods;
  if (mods && mods.notify) notifyApi = mods.notify;
  try {
    fs.mkdirSync(varDir, { recursive: true });
    fs.mkdirSync(reportsDir, { recursive: true });
  } catch (e) { /* 忽略 */ }

  if (fs.existsSync(configPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (saved.cleanupTypes) {
        for (const [k, v] of Object.entries(saved.cleanupTypes)) {
          if (typeof v === 'boolean') saved.cleanupTypes[k] = { ...DEFAULT_CONFIG.cleanupTypes[k], enabled: v };
        }
      }
      config = { ...DEFAULT_CONFIG, ...saved, cleanupTypes: { ...DEFAULT_CONFIG.cleanupTypes, ...(saved.cleanupTypes || {}) } };
    } catch (e) {
      config = { ...DEFAULT_CONFIG };
    }
  }
  saveConfig();
  scheduleNext();
}

function saveConfig() {
  if (!configPath) return;
  try {
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, configPath);
  } catch (e) { /* 忽略 */ }
}

function calcNextRun() {
  const now = Date.now();
  const { hour, minute, intervalHours } = config;
  if (intervalHours >= 24) {
    // 每日固定时刻：今天该时刻已过则明天
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  return new Date(now + intervalHours * 3600000).toISOString();
}

function scheduleNext() {
  if (timerHandle) clearTimeout(timerHandle);
  timerHandle = null;
  if (!config.enabled) { config.nextRun = null; return; }
  const next = new Date(calcNextRun()).getTime();
  config.nextRun = new Date(next).toISOString();
  saveConfig();
  const delay = Math.max(60 * 1000, next - Date.now()); // 至少 1 分钟
  timerHandle = setTimeout(() => {
    executeCleanup().finally(() => scheduleNext());
  }, delay);
}

// ---------------- 执行清理 ----------------

async function executeCleanup() {
  if (isRunning) return { status: 'skipped', reason: 'already running' };
  isRunning = true;
  const startedAt = new Date().toISOString();
  const report = { startedAt, types: {}, errors: [], deleted: [], totalBytes: 0 };

  try {
    const t = config.cleanupTypes;

    // 1. 应用残余
    if (t.app && t.app.enabled && apiModules.app) {
      try {
        const scan = await apiModules.app.scanAll();
        const orphanPaths = (scan.orphans || []).map((o) => o.path);
        const r = orphanPaths.length ? await apiModules.app.deleteItems({ paths: orphanPaths, mode: 'trash' }) : { moved: [], failed: [] };
        report.deleted.push({ type: 'app', count: orphanPaths.length, detail: `${r.moved.length}/${orphanPaths.length} 应用残留已清理` });
        report.types.app = { status: 'done', found: orphanPaths.length, deleted: r.moved.length };
      } catch (e) {
        report.errors.push({ type: 'app', error: e.message });
        report.types.app = { status: 'error', error: e.message };
      }
    }

    // 2. 网盘残余
    if (t.netdisk && t.netdisk.enabled && apiModules.netdisk) {
      try {
        const items = apiModules.netdisk.scanNetdiskResiduals();
        const paths = items.map((i) => i.path);
        const r = paths.length ? await apiModules.netdisk.deleteNetdiskItems({ paths, mode: 'trash' }) : { moved: [], failed: [] };
        report.deleted.push({ type: 'netdisk', count: paths.length, detail: `${r.moved.length}/${paths.length} 网盘残余已清理` });
        report.types.netdisk = { status: 'done', found: paths.length, deleted: r.moved.length };
      } catch (e) {
        report.errors.push({ type: 'netdisk', error: e.message });
        report.types.netdisk = { status: 'error', error: e.message };
      }
    }

    // 3. Docker（未用卷/网络/dangling 镜像 + BuildCache）
    if (t.docker && t.docker.enabled && apiModules.docker) {
      try {
        const scan = await apiModules.docker.scanDocker();
        const volumes = (scan.volumes || []).map((v) => v.name);
        const networks = (scan.networks || []).filter((n) => !n.system && !n.inUse).map((n) => n.name);
        const images = (scan.images || []).filter((i) => i.dangling).map((i) => i.id);
        const r = await apiModules.docker.deleteDocker({ volumes, networks, images, buildCache: true });
        report.deleted.push({ type: 'docker', count: r.moved.length, detail: `${volumes.length} 卷 / ${networks.length} 网络 / ${images.length} 镜像 / BuildCache` });
        report.types.docker = { status: 'done', volumes: volumes.length, networks: networks.length, images: images.length, deleted: r.moved.length };
      } catch (e) {
        report.errors.push({ type: 'docker', error: e.message });
        report.types.docker = { status: 'error', error: e.message };
      }
    }

    // 4. tmp（N 小时+ 未访问）
    if (t.tmp && t.tmp.enabled && apiModules.tmp) {
      try {
        const items = apiModules.tmp.scanTmp();
        const paths = items.map((i) => i.path);
        const r = paths.length ? await apiModules.tmp.deleteTmpFiles({ paths, mode: 'trash' }) : { moved: [], failed: [] };
        const bytes = items.reduce((s, i) => s + (i.size || 0), 0);
        report.deleted.push({ type: 'tmp', count: r.moved.length, bytes, detail: `${r.moved.length} 个过期 tmp 文件` });
        report.totalBytes += bytes;
        report.types.tmp = { status: 'done', found: paths.length, deleted: r.moved.length };
      } catch (e) {
        report.errors.push({ type: 'tmp', error: e.message });
        report.types.tmp = { status: 'error', error: e.message };
      }
    }

    // 5. 系统回收站（N 天+）
    if (t.trash && t.trash.enabled && apiModules.trash) {
      try {
        const items = apiModules.trash.scanSystemTrash();
        const days = t.trash.olderThanDays || 30;
        const cutoff = Date.now() - days * 86400000;
        const old = items.filter((i) => i.mtime < cutoff);
        const r = old.length ? await apiModules.trash.deleteTrashItems({ paths: old.map((i) => i.path) }) : { removed: [], failed: [] };
        const bytes = old.reduce((s, i) => s + (i.size || 0), 0);
        report.deleted.push({ type: 'trash', count: r.removed.length, bytes, detail: `${r.removed.length} 个回收站文件 (${days}天+)` });
        report.totalBytes += bytes;
        report.types.trash = { status: 'done', found: items.length, cleaned: r.removed.length };
      } catch (e) {
        report.errors.push({ type: 'trash', error: e.message });
        report.types.trash = { status: 'error', error: e.message };
      }
    }
  } finally {
    // 落盘报告
    config.lastRun = startedAt;
    config.runCount = (config.runCount || 0) + 1;
    saveConfig();
    try {
      const name = `report-${startedAt.replace(/[:.]/g, '-')}.json`;
      report.finishedAt = new Date().toISOString();
      report.totalBytesText = report.totalBytes >= 1024 * 1024 * 1024
        ? (report.totalBytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
        : (report.totalBytes / 1024 / 1024).toFixed(2) + ' MB';
      await fsp.writeFile(path.join(reportsDir, name), JSON.stringify(report, null, 2));
    } catch (e) { /* 报告写入失败不阻断 */ }
    // 通知推送：清理完成后向启用渠道推送报告摘要（M5，配合 onScheduleComplete 配置）
    if (notifyApi) {
      try {
        const ncfg = notifyApi.getNotifyConfig();
        if (ncfg.enabled && ncfg.onScheduleComplete) {
          const done = Object.values(report.types || {}).filter((t) => t && t.status === 'done').length;
          const errCount = report.errors.length;
          const title = `CleanFnOS 定时清理完成（${done} 类成功${errCount ? `，${errCount} 错误` : ''}）`;
          const lines = report.deleted.map((d) => `- ${d.detail || d.type}`).join('\n');
          const content = `执行时间：${new Date(startedAt).toLocaleString('zh-CN')}\n释放空间：${report.totalBytesText || '0 B'}\n${lines || '（无清理项）'}`;
          notifyApi.notifyAll(title, content);
        }
      } catch (e) { /* 通知失败不阻断清理 */ }
    }
    isRunning = false;
  }
  return report;
}

// ---------------- API ----------------

/** 获取当前配置 */
function getConfig() {
  return JSON.parse(JSON.stringify(config));
}

/** 保存配置（合并后持久化并重新调度） */
async function setConfig(patch) {
  if (patch && typeof patch === 'object') {
    if (typeof patch.enabled === 'boolean') config.enabled = patch.enabled;
    if (typeof patch.hour === 'number' && patch.hour >= 0 && patch.hour <= 23) config.hour = Math.floor(patch.hour);
    if (typeof patch.minute === 'number' && patch.minute >= 0 && patch.minute <= 59) config.minute = Math.floor(patch.minute);
    if (typeof patch.intervalHours === 'number' && patch.intervalHours >= 1 && patch.intervalHours <= 168) config.intervalHours = patch.intervalHours;
    if (patch.cleanupTypes && typeof patch.cleanupTypes === 'object') {
      for (const [k, v] of Object.entries(patch.cleanupTypes)) {
        if (!config.cleanupTypes[k]) continue;
        if (typeof v === 'boolean') config.cleanupTypes[k].enabled = v;
        else if (v && typeof v === 'object') config.cleanupTypes[k] = { ...config.cleanupTypes[k], ...v };
      }
    }
  }
  saveConfig();
  scheduleNext();
  return getConfig();
}

/** 立即执行一次清理 */
async function runNow() {
  return executeCleanup();
}

/** 报告列表（按时间倒序） */
function listReports(limit = 20) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(reportsDir); } catch (e) { return out; }
  const files = names.filter((n) => n.startsWith('report-') && n.endsWith('.json')).sort().reverse().slice(0, limit);
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(reportsDir, f), 'utf8'));
      out.push({ name: f, startedAt: raw.startedAt, finishedAt: raw.finishedAt, types: raw.types, errors: raw.errors, totalBytesText: raw.totalBytesText });
    } catch (e) { /* 跳过坏报告 */ }
  }
  return out;
}

/** 读取单份报告全文 */
function getReport(name) {
  if (typeof name !== 'string' || !/^report-[\w-]+\.json$/.test(name)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(reportsDir, name), 'utf8'));
  } catch (e) { return null; }
}

module.exports = {
  initSchedule,
  getConfig,
  setConfig,
  runNow,
  listReports,
  getReport,
};
