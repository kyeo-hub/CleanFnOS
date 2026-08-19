'use strict';
/**
 * CleanFnOS api/docker.js — Docker 资源扫描与清理（容器/卷/网络/镜像/BuildCache）
 * 参考 fnclearup Docker 管理：扫描在用/未用，一键批量删除；已停止容器清理；Build Cache 清理。
 * 安全原则：只删「已停止容器 / 未用卷 / 未用自定义网络 / dangling 镜像 / BuildCache」，
 * 系统网络（bridge/host/none）永远跳过；Docker 资源无回收站概念，删除为永久操作，前端需二次确认。
 */
const { execFile } = require('child_process');

const SYSTEM_NETWORKS = new Set(['bridge', 'host', 'none']);

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// ---------------- 扫描 ----------------

/** 容器：全部列出（含已停止），标注运行状态 */
async function scanContainers() {
  const r = await run('docker', ['ps', '-a', '--no-trunc', '--format', '{{.ID}}|{{.Names}}|{{.State}}|{{.Image}}']);
  const containers = [];
  for (const line of r.stdout.split('\n')) {
    const parts = line.split('|');
    if (parts.length < 4 || !parts[0] || !parts[1]) continue;
    const [id, name, state, image] = parts;
    containers.push({ id, name, state, image, running: state === 'running' });
  }
  containers.sort((a, b) => (a.running === b.running ? 0 : a.running ? -1 : 1));
  return containers;
}

/** 卷：dangling=true = 未被任何容器引用的卷（未用） */
async function scanVolumes() {
  const r = await run('docker', ['volume', 'ls', '-f', 'dangling=true', '--format', '{{.Name}}']);
  const volumes = [];
  for (const name of r.stdout.split('\n')) {
    if (!name.trim()) continue;
    volumes.push({ name, inUse: false });
  }
  return volumes;
}

/** 网络：全部列出，标注系统网络 / 是否在用 */
async function networkInUse(name) {
  const r = await run('docker', ['network', 'inspect', '--format', '{{len .Containers}}', name], 15000);
  return parseInt(r.stdout.trim(), 10) > 0;
}

async function scanNetworks() {
  const r = await run('docker', ['network', 'ls', '--format', '{{.ID}}|{{.Name}}|{{.Driver}}']);
  const networks = [];
  const pending = [];
  for (const line of r.stdout.split('\n')) {
    const parts = line.split('|');
    if (parts.length < 3 || !parts[0] || !parts[1]) continue;
    const [id, name, driver] = parts;
    const system = SYSTEM_NETWORKS.has(name);
    // 非系统网络并行 inspect 是否在用（避免串行逐个等待造成长耗时）
    if (system) networks.push({ id, name, driver, system, inUse: false });
    else pending.push({ id, name, driver, system: false });
  }
  if (pending.length) {
    const inUseFlags = await Promise.all(pending.map((n) => networkInUse(n.name)));
    pending.forEach((n, i) => { n.inUse = inUseFlags[i]; networks.push(n); });
  }
  return networks;
}

/** 镜像：标注 dangling（Tag 为 <none> 即悬空镜像，Repository 可能有名） */
async function scanImages() {
  const r = await run('docker', ['images', '--no-trunc', '--format', '{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Size}}']);
  const images = [];
  for (const line of r.stdout.split('\n')) {
    const parts = line.split('|');
    if (parts.length < 4 || !parts[0]) continue;
    const [id, repo, tag, size] = parts;
    const dangling = tag === '<none>';
    images.push({ id, tag: repo === '<none>' ? '<none>:<none>' : `${repo}:${tag}`, size, dangling });
  }
  return images;
}

/** Build Cache 统计（docker system df 的 Build Cache 行） */
async function scanBuildCache() {
  const r = await run('docker', ['system', 'df', '--format', '{{.Type}}|{{.TotalCount}}|{{.Size}}']);
  let count = 0;
  let size = '0 B';
  for (const line of r.stdout.split('\n')) {
    const parts = line.split('|');
    if (parts.length >= 3 && parts[0] === 'Build Cache') {
      count = parseInt(parts[1] || '0', 10);
      size = parts[2] || '0 B';
    }
  }
  return { count, size };
}

async function scanDocker() {
  const [containers, volumes, networks, images, buildCache] = await Promise.all([
    scanContainers(), scanVolumes(), scanNetworks(), scanImages(), scanBuildCache(),
  ]);
  return { containers, volumes, networks, images, buildCache };
}

// ---------------- 删除 ----------------

/**
 * 批量删除 Docker 资源。
 * containers: 已停止容器名；volumes: 未用卷名；networks: 未用自定义网络名；
 * images: dangling 镜像 ID；buildCache: 是否清理 Build Cache。
 * 均为永久删除（Docker 无回收站），返回 { moved, failed }。
 */
async function deleteDocker({ containers = [], volumes = [], networks = [], images = [], buildCache = false }) {
  const failed = [];
  const moved = [];

  for (const name of containers) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) { failed.push(`容器 ${name} (名称不合法)`); continue; }
    const r = await run('docker', ['rm', name], 30000);
    if (r.code === 0) moved.push({ type: 'container', name });
    else failed.push(`容器 ${name} (${(r.stderr || '').trim() || '删除失败'})`);
  }

  for (const name of volumes) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) { failed.push(`卷 ${name} (名称不合法)`); continue; }
    const r = await run('docker', ['volume', 'rm', name], 30000);
    if (r.code === 0) moved.push({ type: 'volume', name });
    else failed.push(`卷 ${name} (${(r.stderr || '').trim() || '删除失败'})`);
  }

  for (const name of networks) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) { failed.push(`网络 ${name} (名称不合法)`); continue; }
    if (SYSTEM_NETWORKS.has(name)) { failed.push(`网络 ${name} (系统网络，拒绝删除)`); continue; }
    const r = await run('docker', ['network', 'rm', name], 30000);
    if (r.code === 0) moved.push({ type: 'network', name });
    else failed.push(`网络 ${name} (${(r.stderr || '').trim() || '删除失败'})`);
  }

  for (const id of images) {
    // 校验：接受 docker images --no-trunc 输出的 "sha256:64位hex" 或裸 64 位 hex
    if (typeof id !== 'string' || !/^sha256:[A-Fa-f0-9]{64}$/.test(id) && !/^[A-Fa-f0-9]{64}$/.test(id)) { failed.push(`镜像 ${id} (ID 不合法)`); continue; }
    // docker rmi 接受带/不带 sha256: 前缀；统一去掉前缀传裸 ID
    const shortId = id.replace(/^sha256:/, '');
    const r = await run('docker', ['rmi', shortId], 60000);
    if (r.code === 0) moved.push({ type: 'image', id: shortId });
    else failed.push(`镜像 ${id} (${(r.stderr || '').trim() || '删除失败'})`);
  }

  if (buildCache) {
    const r = await run('docker', ['builder', 'prune', '-af'], 120000);
    if (r.code === 0) moved.push({ type: 'buildcache', note: 'cleaned' });
    else failed.push(`Build Cache (${(r.stderr || '').trim() || '清理失败'})`);
  }

  return { moved, failed };
}

module.exports = {
  scanDocker,
  deleteDocker,
};
