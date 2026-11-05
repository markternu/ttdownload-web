/**
 * 「播放器」后端：把**加密归档的成品**变成浏览器能直接 <video> 播放的 mp4。
 *
 * 流程（全部在后台跑，前端轮询进度）：
 *   ① 解密（openssl -d，密码同加密时）
 *   ② 砍掉尾部 V-L-T 标记
 *   ③ 如果解出来是 **zip**（归档时多文件会打包）→ 解压，挑最大的视频文件
 *   ④ 如果不是 **mp4 + moov 在前**（faststart）→ ffmpeg 重封装成 mp4 + faststart
 *      （-c copy，不重新编码；moov 在前的 mp4 浏览器才能边下边播）
 *   ⑤ 提供支持 HTTP Range 的流，给 <video> 拖进度条
 *
 * 临时文件放在 state/play-tmp，后台定时清理；失败不会动原始加密文件（只读）。
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
import { isMp4Faststart, isVideoExt, isZipFile, pickVideoFile, remuxToMp4 } from './media';
import { runCommand } from './archive';

const scoped = logger.child('player');

export type PlayState = 'decrypting' | 'extracting' | 'remuxing' | 'ready' | 'failed';

export interface PlayJob {
  id: string;
  fileId: number;
  state: PlayState;
  progress: number;
  error: string | null;
  /** 可播放的 mp4 路径（ready 之后才有） */
  playPath: string | null;
  contentType: string;
  sizeBytes: number;
  createdAt: number;
  touchedAt: number;
  /** 临时目录（整个目录在清理时删掉） */
  workDir: string;
}

const jobs = new Map<string, PlayJob>();

/** 临时目录：state/play-tmp */
export function playTempDir(): string {
  return path.join(config.dirs.state, 'play-tmp');
}

function ensurePlayTempDir(): string {
  fs.mkdirSync(playTempDir(), { recursive: true });
  return playTempDir();
}

export function getPlayJob(id: string): PlayJob | undefined {
  return jobs.get(id);
}

/** 对外（API）用的字段，别把内部路径全暴露出去 */
export function publicPlayJob(j: PlayJob): Record<string, unknown> {
  return {
    id: j.id,
    fileId: j.fileId,
    state: j.state,
    progress: j.progress,
    error: j.error,
    playable: j.state === 'ready' && !!j.playPath,
    sizeBytes: j.sizeBytes,
    createdAt: j.createdAt,
  };
}

function dropJob(id: string, reason: string): void {
  const j = jobs.get(id);
  if (!j) return;
  jobs.delete(id);
  try {
    fs.rmSync(j.workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
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
    playPath: null,
    contentType: 'video/mp4',
    sizeBytes: 0,
    createdAt: Date.now(),
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

  // ③ zip → 解压 → 挑最大的视频
  job.state = 'extracting';
  job.progress = 50;
  let source = decPath;
  if (isZipFile(decPath)) {
    const unzDir = path.join(job.workDir, 'unzipped');
    fs.mkdirSync(unzDir, { recursive: true });
    const r = await runCommand(config.bins.unzip, ['-o', '-q', decPath, '-d', unzDir], undefined, {
      label: '解压归档里的 zip',
      hideArgs: true,
      hideOutput: true,
    });
    const picked = pickVideoFile(unzDir);
    if (!picked) {
      job.state = 'failed';
      job.error = r.code === 0 ? 'zip 里没有找到视频文件' : `解压失败（unzip 退出码 ${r.code}）：${r.stderr.trim().slice(-200)}`;
      return;
    }
    source = picked;
    try {
      fs.rmSync(decPath, { force: true });
    } catch {
      /* ignore */
    }
  } else if (!isVideoExt(name)) {
    // ⚠️ 用原始文件名判断：解密出来的临时文件固定叫 decrypted.bin，按它的扩展名判断会全失败
    job.state = 'failed';
    job.error = `解密出来的不是视频文件（原始名：${name}），既不是 zip 也不是常见视频格式`;
    return;
  }
  job.progress = 70;

  // ④ 不是 mp4 + faststart → 重封装
  const playPath = path.join(job.workDir, 'play.mp4');
  if (isMp4Faststart(source)) {
    // 已经是 moov 在前的 mp4，直接用
    job.playPath = source;
  } else {
    job.state = 'remuxing';
    job.progress = 75;
    const remux = await remuxToMp4(source, playPath);
    if (!remux.ok) {
      job.state = 'failed';
      job.error = remux.error ?? '重封装失败（服务器可能缺少 ffmpeg）';
      return;
    }
    job.playPath = playPath;
  }

  job.sizeBytes = fs.statSync(job.playPath).size;
  job.progress = 100;
  job.state = 'ready';
  job.touchedAt = Date.now();
  scoped.mark('PLAY', `播放已就绪 #${job.fileId} → ${path.basename(job.playPath)}（${(job.sizeBytes / 1024 ** 2).toFixed(1)} MiB）`);
}

/* ------------------------------------------------------------------ */
/*  后台清理                                                            */
/* ------------------------------------------------------------------ */

/** 任务超过这个时间没人看就清掉（避免长期占磁盘） */
export const PLAY_JOB_TTL_MS = 2 * 60 * 60_000;

export function sweepPlayJobs(now = Date.now()): number {
  let removed = 0;
  for (const [id, j] of [...jobs]) {
    if (now - j.touchedAt > PLAY_JOB_TTL_MS) {
      dropJob(id, '超时清理');
      removed += 1;
    }
  }
  return removed;
}

/** 开机清空残留的播放临时目录（上次没清干净的） */
export function purgePlayTempOnBoot(): { removed: number } {
  let removed = 0;
  try {
    if (!fs.existsSync(playTempDir())) return { removed: 0 };
    for (const name of fs.readdirSync(playTempDir())) {
      try {
        fs.rmSync(path.join(playTempDir(), name), { recursive: true, force: true });
        removed += 1;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  if (removed) scoped.mark('PLAY', `开机清理播放临时文件 ${removed} 个`);
  return { removed };
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
