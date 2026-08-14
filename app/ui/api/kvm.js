'use strict';
/**
 * CleanFnOS api/kvm.js — KVM 鬼影快照检测 + VM 管理
 * 参考 fnos-app-cleaner：virsh snapshot-list 可见快照 vs qemu-img snapshot -l 实际快照对比，
 * 找出"隐身的"鬼影快照（virsh 删了但 qcow2 里还占空间），一键删除（自动关停 VM 删完恢复）。
 * 另提供 VM 启停管理（start/shutdown/destroy）。
 * 安全：VM/快照名与磁盘路径均做白名单校验；只操作 virsh/qemu-img 命令，参数数组化防注入。
 */
const { execFile } = require('child_process');

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/** VM 名白名单（virsh 域名规则：字母数字 _-） */
function isSafeVmName(n) {
  return typeof n === 'string' && /^[A-Za-z0-9_-]+$/.test(n) && n.length <= 64;
}

/** 快照名白名单 */
function isSafeSnapName(n) {
  return typeof n === 'string' && /^[A-Za-z0-9_.-]+$/.test(n) && n.length <= 128;
}

/** 磁盘路径白名单：仅 /volN 下或 /var/lib/libvirt/images 下的 .qcow2/.img */
function isSafeDiskPath(p) {
  if (typeof p !== 'string') return false;
  if (p.includes('..')) return false;
  return /^\/vol\d+\/.*\.(qcow2|qcow|img)$/.test(p) ||
    /^\/var\/lib\/libvirt\/images\/.*\.(qcow2|qcow|img)$/.test(p);
}

// ---------------- 扫描 ----------------

/** virsh list --all 解析：所有 VM（含关闭），返回 [{ name, state, id }] */
async function listVms() {
  const r = await run('virsh', ['list', '--all'], 20000);
  const vms = [];
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\s*(\d+|-)\s+(\S+)\s+(.+?)\s*$/);
    if (!m) continue;
    if (m[2] === 'Name') continue;
    vms.push({ id: m[1], name: m[2], state: m[3].trim() });
  }
  return vms;
}

/** virsh dumpxml 解析磁盘路径列表 */
async function getVmDisks(vm) {
  const r = await run('virsh', ['dumpxml', vm], 20000);
  const disks = [];
  const re = /<disk[^>]*type=['"](file|block)['"][^>]*>[\s\S]*?<source[^>]*?(?:file|dev)=['"]([^'"]+)['"][\s\S]*?<\/disk>/g;
  let m;
  while ((m = re.exec(r.stdout)) !== null) {
    if (isSafeDiskPath(m[2])) disks.push(m[2]);
  }
  // 兜底：直接匹配 <source file='...'/>
  if (!disks.length) {
    const re2 = /<source\s+file=['"]([^'"]+)['"]/g;
    while ((m = re2.exec(r.stdout)) !== null) {
      if (isSafeDiskPath(m[1]) && !disks.includes(m[1])) disks.push(m[1]);
    }
  }
  return disks;
}

/** virsh snapshot-list --name：可见快照名集合 */
async function listVirshSnapshots(vm) {
  const r = await run('virsh', ['snapshot-list', vm, '--name'], 20000);
  const names = new Set();
  for (const line of r.stdout.split('\n')) {
    const n = line.trim();
    if (n && !n.startsWith('---')) names.add(n);
  }
  return names;
}

/** qemu-img snapshot -l：磁盘实际快照 [{ id, tag, size, date }] */
async function listQemuSnapshots(disk) {
  const r = await run('qemu-img', ['snapshot', '-l', disk], 30000);
  const snaps = [];
  const re = /^\s*(\d+)\s+(\S+)\s+([\d.]+\s+\S+)\s+(.+?)\s+([\d:.]+)\s+(\d+)\s*$/;
  for (const line of r.stdout.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const sizeRaw = m[3].trim();
    let size = 0;
    const sz = parseFloat(sizeRaw);
    if (/G$/.test(sizeRaw)) size = sz * 1024 * 1024 * 1024;
    else if (/M$/.test(sizeRaw)) size = sz * 1024 * 1024;
    else if (/K$/.test(sizeRaw)) size = sz * 1024;
    else size = sz;
    snaps.push({ id: m[1], tag: m[2], size, sizeText: sizeRaw, date: m[4].trim() + ' ' + m[5].trim() });
  }
  return snaps;
}

/** 扫描所有 VM 的鬼影快照：qemu-img 实际存在但 virsh 不可见的快照 */
async function scanKvm() {
  const vms = await listVms();
  const ghostSnapshots = [];
  const vmDisks = [];

  for (const vm of vms) {
    const disks = await getVmDisks(vm.name);
    vmDisks.push({ name: vm.name, state: vm.state, disks });
    const virshSnaps = await listVirshSnapshots(vm.name);
    for (const disk of disks) {
      const qemuSnaps = await listQemuSnapshots(disk);
      for (const s of qemuSnaps) {
        if (virshSnaps.has(s.tag)) continue; // virsh 可见，非鬼影
        ghostSnapshots.push({
          vm: vm.name,
          vmState: vm.state,
          disk,
          id: s.id,
          tag: s.tag,
          size: s.size,
          sizeText: s.sizeText,
          date: s.date,
        });
      }
    }
  }

  return { vms: vmDisks, ghostSnapshots };
}

// ---------------- 快照删除 ----------------

/**
 * 删除鬼影快照：VM 运行中先关停，删除后恢复原状态。
 * snapshots: [{ vm, disk, tag }]
 */
async function deleteGhostSnapshots({ snapshots = [] }) {
  const failed = [];
  const removed = [];
  // 分组：同一 VM 只操作一次状态
  const byVm = new Map();
  for (const s of snapshots) {
    if (!isSafeVmName(s.vm) || !isSafeDiskPath(s.disk) || !isSafeSnapName(s.tag)) {
      failed.push(`${s.vm}@${s.tag} (参数不合法)`);
      continue;
    }
    if (!byVm.has(s.vm)) byVm.set(s.vm, []);
    byVm.get(s.vm).push(s);
  }

  for (const [vm, snaps] of byVm) {
    // 检查 VM 当前状态
    const lst = await run('virsh', ['domstate', vm], 15000);
    const running = /running/i.test(lst.stdout.trim());
    let wasRunning = running;
    if (running) {
      // 先关闭 VM
      const sh = await run('virsh', ['shutdown', vm], 30000);
      if (sh.code !== 0) {
        const ds = await run('virsh', ['destroy', vm], 15000); // 优雅失败则强制
        if (ds.code !== 0) {
          failed.push(`${vm} (无法关闭 VM: ${(ds.stderr || '').trim()})`);
          continue;
        }
      }
      // 等待关闭完成
      for (let i = 0; i < 30; i++) {
        const st = await run('virsh', ['domstate', vm], 10000);
        if (!/running/i.test(st.stdout.trim())) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    for (const s of snaps) {
      const r = await run('qemu-img', ['snapshot', '-d', s.tag, s.disk], 60000);
      if (r.code === 0) removed.push({ vm, disk: s.disk, tag: s.tag });
      else failed.push(`${vm}@${s.tag} (${(r.stderr || '').trim() || '删除失败'})`);
    }

    // 恢复 VM 状态
    if (wasRunning) {
      await run('virsh', ['start', vm], 30000);
    }
  }

  return { removed, failed };
}

// ---------------- VM 管理 ----------------

/** VM 操作：start / shutdown / destroy（强制关机） */
async function vmAction({ vm = '', action = 'start' }) {
  if (!isSafeVmName(vm)) return { success: false, error: 'VM 名不合法' };
  if (!['start', 'shutdown', 'destroy'].includes(action)) return { success: false, error: '不支持的操作' };
  const r = await run('virsh', [action, vm], 30000);
  if (r.code === 0) return { success: true, vm, action };
  return { success: false, vm, action, error: (r.stderr || '').trim() || '操作失败' };
}

module.exports = {
  scanKvm,
  deleteGhostSnapshots,
  vmAction,
  isSafeVmName,
  isSafeDiskPath,
};
