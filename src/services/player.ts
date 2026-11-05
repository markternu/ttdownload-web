/**
 * 「播放器」后端：把**加密归档的成品**变成浏览器能直接 <video> 播放的 mp4。
 *
 * 流程（后台跑，前端轮询）：
 *   ① 解密（openssl -d，密码同加密时）
 *   ② 砍掉尾部 V-L-T 标记
 *   ③ 如果解出来是 **zip**（归档时多文件会打包，名字带 `_z`）→ 解压，
 *      收集**里面所有视频**当成播放列表（不是只挑一个！）
 *   ④ 每个视频单独准备：不是 mp4 + moov 在前的，用 ffmpeg 重封装成 mp4 + faststart
 *      （-c copy，不重新编码；moov 在前的 mp4 浏览器才能边下边播）
 *   ⑤ 每个视频提供支持 HTTP Range 的流，给 <video> 拖进度条
 *
 * 临时文件放在【还原文件目录】（state/restored），每个任务从还原成功起活 4 小时。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../core/config';
import { filesRepo } from '../core/db';
import { freeBytes } from '../core/disk';
import { logger } from '../core/logger';
import { deriveKeyIv, passwordOf, readVltOriginalName } from './crypto';
import { isMp4Faststart, isVideoExt, isZipFile, pickVideoFiles, remuxToMp4 } from './media';
import { RESTORED_TTL_MS, ensureRestoredDir, registerRestored, removeRestored, restoredDir } from './restored';
import { runCommand } from './archive';

const scoped = logger.child('player');

export type PlayJobState = 'decrypting' | 'extracting' | 'ready' | 'failed';
export type PlayItemState = 'pending' | 'remuxing' | 'ready' | 'failed';

/** 一个可播放的视频（zip 里可能有很多个） */
export interface PlayItem {
  index: number;
  /** 解压出来/解密出来的文件名（不是原始下载名） */
  name: string;
  sizeBytes: number;
  state: PlayItemState;
  /** 可播放的 mp4 路径（ready 之后才有；内部字段，不下发前端） */
  playPath: string | null;
  error: string | null;
  /** 源文件绝对路径（内部用，不下发） */
  srcPath: string;
}

export interface PlayJob {
  id: string;
  fileId: number;
  state: PlayJobState;
  progress: number;
  error: string | null;
  /** 播放列表（解密+解压完成后才有） */
  items: PlayItem[];
  /** 所有视频总大小 */
  sizeBytes: number;
  createdAt: number;
  /** 还原成功（播放列表就绪）的时刻；4 小时从这里开始算 */
  readyAt: number | null;
  touchedAt: number;
  /** 临时目录（整个目录在清理时删掉） */
  workDir: string;
}

const jobs = new Map<string, PlayJob>();

/** 播放器的临时目录也放【还原文件目录】下面（与「下载原始文件」共用） */
export function playTempDir(): string {
  return restoredDir();
}

function ensurePlayTempDir(): string {
  return ensureRestoredDir();
}

export function getPlayJob(id: string): PlayJob | undefined {
  return jobs.get(id);
}

export function getPlayItem(jobId: string, index: number): PlayItem | undefined {
  return jobs.get(jobId)?.items.find((it) => it.index === index);
}

function publicItem(it: PlayItem): Record<string, unknown> {
  return {
    index: it.index,
    name: it.name,
    sizeBytes: it.sizeBytes,
    state: it.state,
    ready: it.state === 'ready',
    error: it.error,
  };
}

/** 对外（API）用的字段，别把内部路径全暴露出去 */
export function publicPlayJob(j: PlayJob): Record<string, unknown> {
  return {
    id: j.id,
    fileId: j.fileId,
    state: j.state,
    progress: j.progress,
    error: j.error,
    items: j.items.map(publicItem),
    playable: j.state === 'ready' && j.items.length > 0,
    sizeBytes: j.sizeBytes,
    createdAt: j.createdAt,
  };
}

function dropJob(id: string, reason: string): void {
  const j = jobs.get(id);
  if (!j) return;
  jobs.delete(id);
  removeRestored(j.workDir);
  scoped.mark('PLAY', `播放任务清理 #${j.fileId}：${reason}`);
}

/** 清理单个任务（前端关播放器时调用） */
export function cancelPlayJob(id: string): boolean {
  if (!jobs.has(id)) return false;
  dropJob(id, '取消');
  return true;
}

/**
 * 开始准备一个可播放文件。同一个文件已经有 ready 的任务就复用，避免重复解密。
 */
export function preparePlayable(fileId: number): { ok: true; job: PlayJob } | { ok: false; error: string; code: string } {
  const row = filesRepo.get(fileId);
  if (!row) return { ok: false, error: '文件记录不存在', code: 'FILE_NOT_FOUND' };
  if (!fs.existsSync(row.path)) return { ok: false, error: '磁盘上的加密文件已不存在（可能已被安卓端取走）', code: 'FILE_MISSING' };

  for (const j of jobs.values()) {
    if (j.fileId === fileId && j.state !== 'failed') return { ok: true, job: j };
  }

  const size = fs.statSync(row.path).size;
  // 解密要写一份，解压/重封装可能再写一份 → 预留 2 倍 + 余量
  const free = freeBytes(config.dirs.state);
  const need = size * 2 + 64 * 1024 * 1024;
  if (free < need) {
    return {
      ok: false,
      error: `磁盘空间不足：播放准备需要约 ${(need / 1024 ** 3).toFixed(2)} GiB，当前可用 ${(free / 1024 ** 3).toFixed(2)} GiB`,
      code: 'NO_SPACE',
    };
  }

  const id = crypto.randomBytes(10).toString('hex');
  const workDir = fs.mkdtempSync(path.join(ensurePlayTempDir(), `play_${fileId}_`));
  const job: PlayJob = {
    id,
    fileId,
    state: 'decrypting',
    progress: 0,
    error: null,
    items: [],
    sizeBytes: 0,
    createdAt: Date.now(),
    readyAt: null,
    touchedAt: Date.now(),
    workDir,
  };
  jobs.set(id, job);
  scoped.mark('PLAY', `开始准备播放 #${fileId}（${row.name}，${(size / 1024 ** 2).toFixed(1)} MiB）`);
  void runPrepare(job).catch((e) => {
    job.state = 'failed';
    job.error = `准备失败：${(e as Error).message}`;
    scoped.error(`[MARK:PLAY] 准备播放失败 #${fileId}：${job.error}`);
  });
  return { ok: true, job };
}

/** openssl 解密到指定路径 */
function decryptTo(src: string, out: string): Promise<{ ok: boolean; error?: string }> {
  const pwd = passwordOf();
  const { key, iv } = deriveKeyIv(pwd);
  return new Promise((resolve) => {
    const child = spawn(config.bins.openssl, ['enc', '-d', '-aes-256-cbc', '-K', key, '-iv', iv, '-in', src, '-out', out], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (e) => resolve({ ok: false, error: `openssl 启动失败：${e.message}` }));
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) resolve({ ok: true });
      else resolve({ ok: false, error: `解密失败（退出码 ${code}）：${stderr.trim().slice(-200)}` });
    });
  });
}

async function runPrepare(job: PlayJob): Promise<void> {
  const row = filesRepo.get(job.fileId);
  if (!row) throw new Error('文件记录已不存在');

  // ① 解密
  job.state = 'decrypting';
  job.progress = 10;
  const decPath = path.join(job.workDir, 'decrypted.bin');
  const dec = await decryptTo(row.path, decPath);
  if (!dec.ok) {
    job.state = 'failed';
    job.error = dec.error ?? '解密失败';
    return;
  }
  job.progress = 40;

  // ② 砍掉 V-L-T 标记
  const name = readVltOriginalName(decPath);
  if (!name) {
    job.state = 'failed';
    job.error = '解密结果里没有 FKY996 标记（文件可能不是本工具加密的，或密码不对）';
    return;
  }
  const nameLen = Buffer.byteLength(name, 'utf8');
  const contentLen = fs.statSync(decPath).size - 104 - nameLen;
  if (contentLen <= 0) {
    job.state = 'failed';
    job.error = '解密结果长度异常，文件可能已损坏';
    return;
  }
  fs.truncateSync(decPath, contentLen);

  // ③ zip → 解压 → 收集**所有**视频（播放列表）
  job.state = 'extracting';
  job.progress = 50;
  let videos: string[];
  if (isZipFile(decPath)) {
    const unzDir = path.join(job.workDir, 'unzipped');
    fs.mkdirSync(unzDir, { recursive: true });
    const r = await runCommand(config.bins.unzip, ['-o', '-q', decPath, '-d', unzDir], undefined, {
      label: '解压归档里的 zip',
      hideArgs: true,
      hideOutput: true,
    });
    videos = pickVideoFiles(unzDir);
    if (!videos.length) {
      job.state = 'failed';
      job.error = r.code === 0 ? 'zip 里没有找到视频文件' : `解压失败（unzip 退出码 ${r.code}）：${r.stderr.trim().slice(-200)}`;
      return;
    }
    try {
      fs.rmSync(decPath, { force: true });
    } catch {
      /* ignore */
    }
  } else if (!isVideoExt(name)) {
    // ⚠️ 用原始文件名判断：解密出来的临时文件固定叫 decrypted.bin
    job.state = 'failed';
    job.error = `解密出来的不是视频文件（原始名：${name}），既不是 zip 也不是常见视频格式`;
    return;
  } else {
    videos = [decPath];
  }
  job.progress = 70;

  // ④ 组装播放列表：已经是 mp4+faststart 的直接就绪，其余的等用户选中时再重封装
  job.items = videos.map((p, i) => {
    const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
    const fast = isMp4Faststart(p);
    return {
      index: i,
      name: path.basename(p),
      sizeBytes: size,
      state: fast ? 'ready' : 'pending',
      playPath: fast ? p : null,
      error: null,
      srcPath: p,
    } as PlayItem;
  });
  job.sizeBytes = job.items.reduce((n, it) => n + it.sizeBytes, 0);
  job.progress = 100;
  job.state = 'ready';
  job.readyAt = Date.now();
  job.touchedAt = job.readyAt;
  registerRestored({ path: job.workDir, kind: 'player', sourceFileId: job.fileId, sizeBytes: job.sizeBytes, readyAt: job.readyAt });
  scoped.mark('PLAY', `播放列表已就绪 #${job.fileId}：${job.items.length} 个视频（${(job.sizeBytes / 1024 ** 2).toFixed(1)} MiB）`);
}

/**
 * 准备播放列表里的第 index 个视频（不是 mp4+faststart 的会启动 ffmpeg 重封装）。
 * 幂等：已就绪/正在转的直接返回当前状态。
 */
export function preparePlayItem(jobId: string, index: number): PlayItem | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  const item = job.items.find((it) => it.index === index);
  if (!item) return null;
  job.touchedAt = Date.now();
  if (item.state === 'pending') {
    item.state = 'remuxing';
    const out = path.join(job.workDir, `play_${item.index}.mp4`);
    void (async () => {
      const r = await remuxToMp4(item.srcPath, out);
      if (r.ok) {
        item.playPath = out;
        item.state = 'ready';
        scoped.mark('PLAY', `第 ${item.index + 1} 个视频已转好（${path.basename(item.srcPath)}）`);
      } else {
        item.state = 'failed';
        item.error = r.error ?? '重封装失败（服务器可能缺少 ffmpeg）';
        scoped.warn(`[MARK:PLAY] 第 ${item.index + 1} 个视频重封装失败：${item.error}`);
      }
      job.touchedAt = Date.now();
    })();
  }
  return item;
}

/* ------------------------------------------------------------------ */
/*  后台清理                                                            */
/* ------------------------------------------------------------------ */

/** 每个播放任务还原出来的文件可活 4 小时（从还原成功那一刻起） */
export const PLAY_JOB_TTL_MS = RESTORED_TTL_MS;

export function sweepPlayJobs(now = Date.now()): number {
  let removed = 0;
  for (const [id, j] of [...jobs]) {
    const born = j.readyAt ?? j.createdAt;
    if (now - born > PLAY_JOB_TTL_MS) {
      dropJob(id, '超时清理');
      removed += 1;
    }
  }
  return removed;
}

let timer: NodeJS.Timeout | null = null;

export function startPlayWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      sweepPlayJobs();
    } catch (e) {
      scoped.error(`[MARK:PLAY] 清理播放任务异常：${(e as Error).message}`);
    }
  }, 5 * 60_000);
  timer.unref?.();
}

export function stopPlayWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
