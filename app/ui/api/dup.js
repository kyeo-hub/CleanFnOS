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
const { execFile } = require('child_process');

const TRASH_DIR = process.env.TRASH_DIR || (process.env.TRIM_PKGVAR || '/tmp') + '/trash';
const MUSIC_EXTS = new Set(['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.wma', '.alac', '.ape', '.dsf']);
const MAX_FILES = 100000;      // 扫描文件数上限
const MAX_DEPTH = 12;          // 递归深度上限
const CONCURRENCY = 4;         // 哈希并发数
const ID3_READ_SIZE = 10240;   // ID3 头读取字节数

// fpcalc（Chromaprint 指纹工具）路径：优先 TRIM_APPDEST/bin/fpcalc，回退源码目录 ../bin/fpcalc
const FPCALC = process.env.FPCALC ||
  (process.env.TRIM_APPDEST ? path.join(process.env.TRIM_APPDEST, 'bin', 'fpcalc') : path.join(__dirname, '..', '..', 'bin', 'fpcalc'));
// 指纹计算 CPU 密集：并发取 CPU 核数 -2（保底 2，上限 6），大曲库显著提速
const CPU_COUNT = (() => { try { return require('os').cpus().length; } catch (e) { return 4; } })();
const FPCALC_CONCURRENCY = Math.max(2, Math.min(6, CPU_COUNT - 2));
const FP_SIM_THRESHOLD = 0.85; // 指纹相似度阈值（同一首歌不同码率指纹高度一致，实测≈1.0）
const FP_MAX_DURATION_DIFF = 3; // 判定同曲的时长容差（秒）
const FP_PRE_SAMPLE = 64;       // 相似度快速粗筛窗口（前 N 单元），粗筛不过直接判不同曲

// 波形级疑似同曲（不同混音/母带）识别：
// Chromaprint 指纹对"不同混音/母带的同曲"过度敏感（匹配率仅 0.001~0.006），
// 但解码波形滑动相关在实测中判别力极强：同曲不同混音 0.21~0.99，完全不同歌曲 <0.06。
const WAVE_SIM_THRESHOLD = 0.2; // 波形相关 ≥ 此值 + 时长差 ≤ 容差 → 疑似同曲不同混音
const WAVE_SR = 8000;           // 波形比较采样率（Hz），解码时统一降采样
const WAVE_WIN_SEC = 15;        // 每个采样窗口时长（秒）
const WAVE_OFFSETS = [0.05, 0.5, 0.9]; // 相对歌曲时长的采样点（避开开头静音/结尾淡出）
const WAVE_MAX_SHIFT = 1000;    // 滑窗最大偏移（样本数，@8kHz ≈ 125ms）
const WAVE_STRIDE = 4;          // 滑窗步进（样本数），加速

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

// ---------------- 音频指纹（Chromaprint） ----------------

/** 调用 fpcalc 生成音频指纹（-json 输出 { duration, fingerprint }） */
function runFpcalc(fp) {
  return new Promise((resolve) => {
    execFile(FPCALC, ['-json', fp], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err || !stdout) return resolve(null);
      try {
        const j = JSON.parse(stdout);
        if (!j.fingerprint) return resolve(null);
        resolve({ duration: Math.round(j.duration || 0), fingerprint: j.fingerprint });
      } catch (e) { resolve(null); }
    });
  });
}

/**
 * 解码 base64 指纹为 32 位整数数组（Chromaprint 每个指纹单元 4 字节大端）。
 * 指纹过短（<10 单元）视为无意义，返回 null。
 */
function decodeFingerprint(b64) {
  try {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 40) return null; // <10 单元
    const arr = new Int32Array(buf.length / 4);
    for (let i = 0; i < arr.length; i++) {
      arr[i] = buf.readInt32BE(i * 4);
    }
    return arr;
  } catch (e) { return null; }
}

/**
 * 指纹相似度：快速粗筛（前 64 单元匹配率 <50% 直接判不同）+ 滑动窗口最佳匹配率（0~1）。
 * 同曲不同码率：指纹几乎一致（实测 1.0）；不同曲：低。容忍首尾偏移。
 */
function fingerprintSimilarity(a, b) {
  if (!a || !b || a.length < 10 || b.length < 10) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // 快速粗筛：仅比较前 FP_PRE_SAMPLE 单元（start=0 对齐），匹配率过低直接判不同曲
  const pre = Math.min(FP_PRE_SAMPLE, short.length);
  let preMatch = 0;
  for (let i = 0; i < pre; i++) if (short[i] === long[i]) preMatch++;
  if (preMatch / pre < 0.5) return 0;

  const win = short.length;
  let best = 0;
  // 只在长指纹的前 20% 窗口内滑动，避免 O(n²)（同曲时长接近，偏移很小）
  const maxStart = Math.min(long.length - win, Math.max(1, Math.floor(long.length * 0.2)));
  for (let start = 0; start <= maxStart; start++) {
    let match = 0;
    for (let i = 0; i < win; i++) {
      if (short[i] === long[start + i]) match++;
    }
    const ratio = match / win;
    if (ratio > best) best = ratio;
    if (best >= FP_SIM_THRESHOLD) break; // 已达标提前退出
  }
  return best;
}

/**
 * 指纹聚类：按时长排序 + 双指针滑动窗口（时长差 > 容差即提前终止）+ 相似度精判。
 * 相比全量 O(n²)，大曲库（数百首）下比较次数大幅下降。
 */
function clusterFingerprints(items) {
  const sorted = [...items].sort((a, b) => (a.duration || 0) - (b.duration || 0));
  const used = new Array(sorted.length).fill(false);
  const groups = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used[i]) continue;
    const cluster = [sorted[i]];
    used[i] = true;
    const baseDur = sorted[i].duration || 0;
    for (let j = i + 1; j < sorted.length; j++) {
      if (used[j]) continue;
      const diff = (sorted[j].duration || 0) - baseDur;
      if (diff > FP_MAX_DURATION_DIFF) break; // 已排序，后续时长更大，直接终止
      if (fingerprintSimilarity(sorted[i].fpArr, sorted[j].fpArr) >= FP_SIM_THRESHOLD) {
        cluster.push(sorted[j]);
        used[j] = true;
      }
    }
    if (cluster.length >= 2) groups.push(cluster);
  }
  return groups;
}

/** 执行外部命令并返回 stdout（失败返回空串） */
function runCmd(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

// ---------------- 波形级疑似同曲（不同混音/母带） ----------------

/** 用 ffmpeg 提取文件某时间点的一段 15s 8kHz 单声道 f32le 波形（失败返回 null） */
function extractWaveWindow(fp, offsetSec) {
  return new Promise((resolve) => {
    execFile('ffmpeg',
      ['-v', 'error', '-ss', String(offsetSec), '-t', String(WAVE_WIN_SEC), '-i', fp,
       '-ac', '1', '-ar', String(WAVE_SR), '-f', 'f32le', 'pipe:1'],
      { timeout: 60000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout) => {
        if (err || !stdout || stdout.length < 128) return resolve(null);
        resolve(new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4)));
      });
  });
}

/** 提取歌曲 3 个采样窗口波形（开头/中部/后段），任一失败返回 null */
async function extractWaveWindows(fp, durationSec) {
  if (!durationSec || durationSec <= 0) return null;
  const out = [];
  for (const r of WAVE_OFFSETS) {
    const off = Math.max(0, Math.min(durationSec - WAVE_WIN_SEC, durationSec * r));
    const w = await extractWaveWindow(fp, off);
    if (!w) return null;
    out.push(w);
  }
  return out;
}

/** 两段 8kHz 波形的滑窗皮尔逊相关（容忍 ≤125ms 时间偏移），返回最佳相关 */
function waveCorr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 1000) return 0;
  let ma = 0, mb = 0, cnt = 0;
  for (let i = 0; i < n; i += WAVE_STRIDE) { ma += a[i]; mb += b[i]; cnt++; }
  ma /= cnt; mb /= cnt;
  let best = -1;
  for (let shift = 0; shift <= WAVE_MAX_SHIFT; shift += WAVE_STRIDE) {
    let num = 0, da = 0, db = 0, c = 0;
    for (let i = 0; i + shift < n; i += WAVE_STRIDE) {
      const x = a[i] - ma, y = b[i + shift] - mb;
      num += x * y; da += x * x; db += y * y; c++;
    }
    if (da > 0 && db > 0) {
      const r = num / Math.sqrt(da * db);
      if (r > best) best = r;
    }
  }
  return best < -1 ? -1 : best;
}

/** 波形相似度：3 个窗口各自滑窗相关，取均值（不同混音同曲 ≈0.2~0.99，不同歌 <0.06） */
function waveSimilarity(wa, wb) {
  if (!wa || !wb || wa.length !== wb.length) return 0;
  let sum = 0, ok = 0;
  for (let i = 0; i < wa.length; i++) {
    const r = waveCorr(wa[i], wb[i]);
    sum += r; ok++;
  }
  return ok ? sum / ok : 0;
}

/** 波形级聚类：仅对指纹未成组的文件，按时长滑窗 + 波形相关精判 */
async function clusterWaveSimilar(files) {
  if (files.length < 2) return [];
  // 并发预提取全部波形缓存（每文件 3 窗口 × 15s ≈ 1.4MB），避免比较时串行等待 ffmpeg
  const waveCache = new Map();
  await poolMap(files, async (f) => {
    waveCache.set(f.path, await extractWaveWindows(f.path, f.duration));
  }, Math.max(2, Math.min(4, CPU_COUNT - 2)));

  const sorted = [...files].sort((a, b) => (a.duration || 0) - (b.duration || 0));
  const used = new Array(sorted.length).fill(false);
  const groups = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used[i]) continue;
    const cluster = [sorted[i]];
    used[i] = true;
    const baseDur = sorted[i].duration || 0;
    for (let j = i + 1; j < sorted.length; j++) {
      if (used[j]) continue;
      const diff = (sorted[j].duration || 0) - baseDur;
      if (diff > FP_MAX_DURATION_DIFF) break;
      const wa = waveCache.get(sorted[i].path);
      const wb = waveCache.get(sorted[j].path);
      if (wa && wb && waveSimilarity(wa, wb) >= WAVE_SIM_THRESHOLD) {
        cluster.push(sorted[j]);
        used[j] = true;
      }
    }
    if (cluster.length >= 2) groups.push(cluster);
  }
  return groups;
}

const FMT_WEIGHT = { '.flac': 100, '.wav': 100, '.ape': 95, '.dsf': 95, '.alac': 90, '.m4a': 72, '.aac': 66, '.ogg': 66, '.mp3': 60, '.wma': 54 };
const LOSSLESS_EXTS = new Set(['.flac', '.wav', '.ape', '.dsf', '.alac']);

/**
 * 音质评分（0~100）：格式权重 + 码率 + 采样率/位深 + 假无损识别。
 * - 无损格式：基础 88，采样率 ≥96k/48k 加分，位深 ≥24bit 加分；
 *   平均码率 <500kbps 判「疑似假无损」（低码率有损转码压缩率极高），大幅降分。
 * - 有损格式：按码率分级（320k≈86 / 256k≈80 / 192k≈72 / 160k≈66 / 128k≈58），AAC/OGG 同码率加分。
 * - 码率来源：优先 ffprobe 真实 bit_rate，回退 文件大小×8/时长 平均码率。
 */
async function qualityScore(file, durationSec) {
  const ext = file.ext || path.extname(file.path).toLowerCase();
  const sizeBits = (file.size || 0) * 8;
  const avgKbps = durationSec > 0 ? Math.round(sizeBits / durationSec / 1000) : 0;
  let probe = { codec: '', bitrate: null, sampleRate: 0, bitDepth: 0 };
  try {
    const out = await runCmd('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_name,bit_rate,sample_rate,bits_per_sample',
      '-of', 'default=noprint_wrappers=1', file.path,
    ], 15000);
    for (const line of out.split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.slice(0, eq), v = line.slice(eq + 1);
      if (k === 'codec_name') probe.codec = v;
      if (k === 'bit_rate' && v && v !== 'N/A') probe.bitrate = parseInt(v, 10);
      if (k === 'sample_rate' && v) probe.sampleRate = parseInt(v, 10);
      if (k === 'bits_per_sample' && v) probe.bitDepth = parseInt(v, 10);
    }
  } catch (e) { /* ffprobe 缺失时用文件大小估算 */ }
  const bitrateKbps = probe.bitrate ? Math.round(probe.bitrate / 1000) : avgKbps;

  let score = 0;
  const notes = [];
  if (LOSSLESS_EXTS.has(ext)) {
    score = 88;
    if (probe.sampleRate >= 96000) { score += 6; notes.push('96kHz'); }
    else if (probe.sampleRate >= 48000) { score += 3; notes.push('48kHz'); }
    if (probe.bitDepth >= 24) { score += 4; notes.push('24bit'); }
    if (avgKbps > 0 && avgKbps < 500) { score -= 25; notes.push('⚠疑似假无损'); }
    else if (avgKbps > 0 && avgKbps < 700) { score -= 8; notes.push('码率偏低'); }
    notes.push(`≈${avgKbps || '?'}kbps`);
  } else {
    const bps = bitrateKbps;
    if (bps >= 320) score = 86;
    else if (bps >= 256) score = 80;
    else if (bps >= 192) score = 72;
    else if (bps >= 160) score = 66;
    else if (bps >= 128) score = 58;
    else score = 40;
    if (ext === '.aac' || ext === '.ogg') score += 3; // 同码率下编码效率更高
    if (probe.sampleRate >= 48000) score += 2;
    notes.push(`${bitrateKbps || '?'}kbps`);
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    format: (probe.codec || ext.slice(1)).toUpperCase(),
    bitrateKbps,
    sampleRate: probe.sampleRate,
    bitDepth: probe.bitDepth,
    avgKbps,
    fakeLossless: notes.includes('⚠疑似假无损'),
    note: notes.join(' '),
  };
}

/**
 * 指纹扫描入口（type='music-fp'）：
 * 扫描音频文件 → 逐个 fpcalc 指纹 → 时长+相似度聚类 → 返回重复组。
 * 组内文件附 fingerprint（base64）供前端展示；删除复用 deleteDupFiles。
 */
async function scanMusicFingerprint({ paths = [] }) {
  if (!fs.existsSync(FPCALC)) {
    return { error: `fpcalc 不存在: ${FPCALC}，请检查应用安装完整性` };
  }
  const files = [];
  for (const p of paths) {
    if (!isSafeVolPath(p)) return { error: `路径越界：${p} 仅允许 /vol* 下的目录` };
    let st;
    try { st = fs.statSync(p); } catch (e) { return { error: `目录不存在: ${p}` }; }
    if (!st.isDirectory()) return { error: `不是目录: ${p}` };
    walkFiles(p, MUSIC_EXTS, files, 0);
  }
  if (!files.length) {
    return { groups: [], stats: { totalFiles: 0, duplicateGroups: 0, duplicateFiles: 0, wastedBytes: 0 } };
  }

  // 并发计算指纹
  const fingerprinted = await poolMap(files, async (f) => {
    const fp = await runFpcalc(f.path);
    if (!fp) return null;
    const fpArr = decodeFingerprint(fp.fingerprint);
    if (!fpArr) return null;
    return { ...f, duration: fp.duration, fingerprint: fp.fingerprint, fpArr };
  }, FPCALC_CONCURRENCY);

  const ok = fingerprinted.filter(Boolean);
  const failedCount = fingerprinted.length - ok.length;

  // 多级识别：指纹级（同曲同编码，Chromaprint）+ 波形级（同曲不同混音/母带——指纹过度敏感漏检的）
  const fpClusters = clusterFingerprints(ok);
  const inFp = new Set();
  for (const c of fpClusters) for (const f of c) inFp.add(f.path);
  const rest = ok.filter((f) => !inFp.has(f.path));
  const waveClusters = await clusterWaveSimilar(rest);
  const clusters = [
    ...fpClusters.map((c) => ({ kind: 'fp', files: c })),
    ...waveClusters.map((c) => ({ kind: 'wave', files: c })),
  ];

  const groups = [];
  let dupFiles = 0;
  let wastedBytes = 0;
  for (const { kind, files: cluster } of clusters) {
    // 音质评分：组内保留最佳（默认第一项，避免误删）
    const scored = [];
    for (const f of cluster) {
      const q = await qualityScore(f, f.duration);
      scored.push({ ...f, quality: q });
    }
    scored.sort((a, b) => b.quality.score - a.quality.score || a.path.localeCompare(b.path));
    const best = scored[0];
    scored.forEach((f) => { f.isBest = f === best; });
    scored.sort((a, b) => a.path.localeCompare(b.path)); // 展示仍按路径排序，best 单独标记

    const wasted = scored.slice(1).reduce((s, f) => s + f.size, 0);
    groups.push({
      kind,
      fingerprint: scored[0].fingerprint,
      count: scored.length,
      wasted,
      wastedText: fmtSize(wasted),
      bestPath: best.path,
      files: scored.map((f) => ({
        path: f.path,
        name: f.name,
        size: f.size,
        sizeText: fmtSize(f.size),
        ext: f.ext,
        duration: f.duration,
        isBest: f.isBest,
        quality: f.quality,
        id3: f.ext === '.flac' ? readFlacTags(f.path) : (f.ext === '.mp3' ? readId3Tags(f.path) : null),
      })),
    });
    dupFiles += scored.length;
    wastedBytes += wasted;
  }
  groups.sort((a, b) => b.wasted - a.wasted);

  return {
    groups,
    stats: {
      totalFiles: files.length,
      fingerprintOk: ok.length,
      fingerprintFailed: failedCount,
      duplicateGroups: groups.length,
      waveGroups: waveClusters.length,
      duplicateFiles: dupFiles,
      wastedBytes,
      wastedText: fmtSize(wastedBytes),
    },
    skippedCount: files.length - fingerprinted.length,
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
  scanMusicFingerprint,
  deleteDupFiles,
  isSafeVolPath,
};
