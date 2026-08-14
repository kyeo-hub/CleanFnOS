'use strict';
/**
 * CleanFnOS api/dup.js — 文件去重 / 音乐去重
 * 参考 fnclearup：先按文件大小分组，仅对 ≥2 个同大小的文件做 SHA-256 流式哈希，
 * 再按哈希分组识别重复；音乐模式按音频扩展名过滤 + 读取 ID3/FLAC 元数据展示。
 * 删除默认移入回收站（kind:'file' 目录化条目，恢复走 app.js trashRestore）。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const TRASH_DIR = process.env.TRASH_DIR || (process.env.TRIM_PKGVAR || '/tmp') + '/trash';
const MUSIC_EXTS = new Set(['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.wma', '.alac', '.ape', '.dsf']);
const MAX_FILES = 100000;      // 扫描文件数上限
const MAX_DEPTH = 12;          // 递归深度上限
const CONCURRENCY = 4;         // 哈希并发数
const ID3_READ_SIZE = 10240;   // ID3 头读取字节数

// ---------------- 工具 ----------------

/** 路径白名单：/volN 下的路径（不含 ..） */
function isSafeVolPath(p) {
  return typeof p === 'string' && /^\/vol\d+\//.test(p) && !p.includes('..');
}

function fmtSize(n) {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

/** 递归收集文件（带深度/数量上限，跳过符号链接） */
function walkFiles(root, exts, out, depth) {
  if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of entries) {
    if (out.length >= MAX_FILES) return;
    const p = path.join(root, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) walkFiles(p, exts, out, depth + 1);
    else if (ent.isFile()) {
      if (exts && !exts.has(path.extname(ent.name).toLowerCase())) continue;
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      out.push({ path: p, size: st.size, name: ent.name, ext: path.extname(ent.name).toLowerCase() });
    }
  }
}

/** SHA-256 流式哈希（自适应 chunk：>500MB 用 4MB，>100MB 用 1MB，否则 256KB） */
function hashFile(fp, size) {
  return new Promise((resolve) => {
    try {
      let chunkSize = 256 * 1024;
      if (size > 500 * 1024 * 1024) chunkSize = 4 * 1024 * 1024;
      else if (size > 100 * 1024 * 1024) chunkSize = 1 * 1024 * 1024;
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(fp, { highWaterMark: chunkSize });
      stream.on('data', (c) => hash.update(c));
      stream.on('error', (e) => resolve({ path: fp, error: e.message }));
      stream.on('end', () => resolve({ path: fp, hash: hash.digest('hex') }));
    } catch (e) {
      resolve({ path: fp, error: String(e && e.message || e) });
    }
  });
}

/** 简单并发池 */
async function poolMap(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------- 音频元数据 ----------------

/** 读取 MP3 ID3v2 标签（TIT2/TPE1/TALB） */
function readId3Tags(fp) {
  try {
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(ID3_READ_SIZE);
    const bytesRead = fs.readSync(fd, buf, 0, ID3_READ_SIZE, 0);
    fs.closeSync(fd);
    if (bytesRead < 10 || buf.slice(0, 3).toString() !== 'ID3') return null;
    const headerSize = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
    const end = Math.min(10 + headerSize, bytesRead);
    const tags = { title: '', artist: '', album: '' };
    let pos = 10;
    while (pos + 10 <= end) {
      const fid = buf.slice(pos, pos + 4).toString();
      const fsize = buf.readUInt32BE(pos + 4);
      if (fid === '\x00\x00\x00\x00' || fsize === 0) break;
      if (['TIT2', 'TPE1', 'TALB'].includes(fid) && pos + 10 + fsize <= end) {
        const val = buf.slice(pos + 11, pos + 10 + fsize).toString('utf-8').replace(/\x00/g, '').trim();
        if (fid === 'TIT2') tags.title = val;
        else if (fid === 'TPE1') tags.artist = val;
        else if (fid === 'TALB') tags.album = val;
      }
      pos += 10 + fsize;
    }
    return (tags.title || tags.artist || tags.album) ? tags : null;
  } catch (e) { return null; }
}

/** 读取 FLAC VORBIS_COMMENT 标签（TITLE/ARTIST/ALBUM） */
function readFlacTags(fp) {
  try {
    const fd = fs.openSync(fp, 'r');
    const head = Buffer.alloc(64);
    const n = fs.readSync(fd, head, 0, 64, 0);
    fs.closeSync(fd);
    if (n < 8 || head.slice(0, 4).toString() !== 'fLaC') return null;
    // 遍历 metadata block：1 字节头（bit7=last，低 7 位=type）+ 3 字节长度
    let off = 4;
    for (let i = 0; i < 16; i++) {
      if (off + 4 > n) return null;
      const blockType = head[off] & 0x7f;
      const blockLen = (head[off + 1] << 16) | (head[off + 2] << 8) | head[off + 3];
      off += 4;
      if (blockType === 4 && off + blockLen <= n) {
        // VORBIS_COMMENT: vendor_length(4) vendor comment_count(4) comments
        let p = off;
        const vendorLen = head.readUInt32LE(p); p += 4 + vendorLen;
        const count = head.readUInt32LE(p); p += 4;
        const tags = { title: '', artist: '', album: '' };
        for (let c = 0; c < Math.min(count, 64) && p + 4 <= n; c++) {
          const len = head.readUInt32LE(p); p += 4;
          if (p + len > n) break;
          const kv = head.slice(p, p + len).toString('utf-8');
          p += len;
          const eq = kv.indexOf('=');
          if (eq > 0) {
            const key = kv.slice(0, eq).toUpperCase();
            const val = kv.slice(eq + 1);
            if (key === 'TITLE') tags.title = val;
            else if (key === 'ARTIST') tags.artist = val;
            else if (key === 'ALBUM') tags.album = val;
          }
        }
        return (tags.title || tags.artist || tags.album) ? tags : null;
      }
      off += blockLen;
    }
    return null;
  } catch (e) { return null; }
}

// ---------------- 扫描 ----------------

/**
 * 扫描去重。type='files' 全部文件；type='music' 仅音频扩展名 + 读取元数据。
 * 返回 { groups, stats }：groups 按 hash 分组（≥2 为重复），stats 汇总。
 */
async function scanDup({ type = 'files', paths = [] }) {
  const exts = type === 'music' ? MUSIC_EXTS : null;
  const files = [];
  for (const p of paths) {
    if (!isSafeVolPath(p)) return { error: `路径越界：${p} 仅允许 /vol* 下的目录` };
    let st;
    try { st = fs.statSync(p); } catch (e) { return { error: `目录不存在: ${p}` }; }
    if (!st.isDirectory()) return { error: `不是目录: ${p}` };
    walkFiles(p, exts, files, 0);
  }
  if (!files.length) {
    return { groups: [], stats: { totalFiles: 0, duplicateGroups: 0, duplicateFiles: 0, wastedBytes: 0 } };
  }

  // 按大小分组：仅 ≥2 个同大小的文件才需要哈希
  const sizeMap = new Map();
  for (const f of files) {
    if (!sizeMap.has(f.size)) sizeMap.set(f.size, []);
    sizeMap.get(f.size).push(f);
  }
  const toHash = [];
  for (const group of sizeMap.values()) {
    if (group.length >= 2) toHash.push(...group);
  }
  const skippedCount = files.length - toHash.length;

  if (!toHash.length) {
    return { groups: [], stats: { totalFiles: files.length, duplicateGroups: 0, duplicateFiles: 0, wastedBytes: 0 }, skippedCount };
  }

  // 并发流式哈希
  const hashed = await poolMap(toHash, (f) => hashFile(f.path, f.size), CONCURRENCY);

  // 按 hash 分组（path->file 索引，避免 O(n²) 查找）
  const byPath = new Map(toHash.map((f) => [f.path, f]));
  const hashMap = new Map();
  for (const h of hashed) {
    if (!h || !h.hash) continue;
    if (!hashMap.has(h.hash)) hashMap.set(h.hash, []);
    const f = byPath.get(h.path);
    if (f) hashMap.get(h.hash).push(f);
  }

  const groups = [];
  let dupFiles = 0;
  let wastedBytes = 0;
  for (const [hash, list] of hashMap) {
    if (list.length < 2) continue;
    // 音乐模式补元数据
    if (type === 'music') {
      for (const f of list) {
        f.id3 = f.ext === '.flac' ? readFlacTags(f.path) : (f.ext === '.mp3' ? readId3Tags(f.path) : null);
      }
    }
    list.sort((a, b) => a.path.localeCompare(b.path));
    const wasted = list.slice(1).reduce((s, f) => s + f.size, 0);
    groups.push({
      hash,
      count: list.length,
      wasted,
      wastedText: fmtSize(wasted),
      files: list.map((f) => ({
        path: f.path,
        name: f.name,
        size: f.size,
        sizeText: fmtSize(f.size),
        ext: f.ext,
        id3: f.id3 || null,
      })),
    });
    dupFiles += list.length;
    wastedBytes += wasted;
  }
  groups.sort((a, b) => b.wasted - a.wasted);

  return {
    groups,
    stats: {
      totalFiles: files.length,
      duplicateGroups: groups.length,
      duplicateFiles: dupFiles,
      wastedBytes,
      wastedText: fmtSize(wastedBytes),
    },
    skippedCount,
  };
}

// ---------------- 删除 ----------------

/** 移入回收站（kind:'file' 目录化条目，元数据存同级 .meta.json，可恢复） */
async function moveToTrash(p, meta) {
  await fsp.mkdir(TRASH_DIR, { recursive: true });
  const base = path.basename(p);
  const name = `${Date.now()}-${base}`;
  const dest = path.join(TRASH_DIR, name);
  await fsp.mkdir(dest, { recursive: true });
  const target = path.join(dest, base);
  try {
    await fsp.rename(p, target);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(p, target);
    await fsp.unlink(p);
  }
  await fsp.writeFile(path.join(TRASH_DIR, name + '.meta.json'), JSON.stringify({ ...meta, original: p, kind: 'file' }, null, 2));
  return name;
}

/** 删除选中的重复文件（通常保留每组第一个，勾选其余） */
async function deleteDupFiles({ files = [], mode = 'trash' }) {
  const permanent = mode === 'permanent';
  const failed = [];
  const moved = [];
  for (const target of files) {
    if (!isSafeVolPath(target)) { failed.push(`${target} (路径不合法)`); continue; }
    let st;
    try { st = await fsp.lstat(target); } catch (e) { failed.push(`${target} (不存在)`); continue; }
    if (st.isSymbolicLink()) { failed.push(`${target} (符号链接，拒绝)`); continue; }
    if (!st.isFile()) { failed.push(`${target} (非普通文件，拒绝)`); continue; }
    try {
      if (permanent) {
        await fsp.unlink(target);
        moved.push({ path: target, action: 'permanent' });
      } else {
        const name = await moveToTrash(target, { app: '', type: 'dup', mode: 'trash' });
        moved.push({ path: target, trash: name, action: 'trash' });
      }
    } catch (e) {
      failed.push(`${target} (${e.message})`);
    }
  }
  return { moved, failed };
}

module.exports = {
  scanDup,
  deleteDupFiles,
  isSafeVolPath,
};
