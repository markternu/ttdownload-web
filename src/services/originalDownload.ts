import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../core/config';
import { filesRepo } from '../core/db';
import { freeBytes } from '../core/disk';
import { logger } from '../core/logger';
import { deriveKeyIv, hasVltMarker, passwordOf, readVltOriginalName } from './crypto';
import { CODE_WINDOW_MS, originalDownloadEnabled, pruneUnlockState } from './originalCode';

/**
 * 「下载原始文件」：把加密归档的成品**临时**解密还原，供用户下载，然后立刻删掉临时文件。
 *
 * 为什么需要它：消费者目录里的成品是加密归档（AES-256-CBC + 尾部 FKY996 标记），
 * 用户有时想直接拿走**原始视频**（不经过手机端的解密 App），就需要服务端先解密一次。
 *
 * 三条硬性约束（用户明确要求）：
 *   ① 临时文件**不能长期留存**：下载一结束就删；无法确认是否下完的，**最多留 1 小时**；
 *      断电/重启后开机**全盘扫一遍清干净**（重启时内存里的任务全没了，只能靠清目录）。
 *   ② 解密可能几 GB、要几十秒到几分钟 → 必须给前端**进度**，而且**不能挡住用户去看别的页面**。
 *   ③ 要一个**每 15 分钟变一次的 6 位数字**当下载密码（实现见 services/originalCode.ts）。
 */

const scoped = logger.child('original');

/* ------------------------------------------------------------------ */
/*  临时目录与清理                                                       */
/* ------------------------------------------------------------------ */

/** 临时解密文件放这里（每次开机先把整个目录清空） */
export function tempDir(): string {
  return path.join(config.dirs.state, 'original-tmp');
}

/** 没下完/没确认下完的临时文件最多留多久 */
export const TEMP_MAX_AGE_MS = 60 * 60_000;

export function ensureTempDir(): string {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * 开机清空临时目录。
 * 断电/重启后内存里的任务全丢了，"谁还在下"无从得知 —— 按用户要求一律清干净。
 */
export function purgeTempOnBoot(): { removed: number; bytes: number } {
  const dir = tempDir();
  let removed = 0;
  let bytes = 0;
  try {
    if (!fs.existsSync(dir)) return { removed: 0, bytes: 0 };
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        bytes += st.isFile() ? st.size : 0;
        fs.rmSync(p, { recursive: true, force: true });
        removed += 1;
      } catch (e) {
        scoped.warn(`[MARK:ORIGINAL_DL] 开机清理失败 ${p}：${(e as Error).message}`);
      }
    }
  } catch (e) {
    scoped.warn(`[MARK:ORIGINAL_DL] 开机清理目录异常：${(e as Error).message}`);
  }
  ensureTempDir();
  return { removed, bytes };
}

/* ------------------------------------------------------------------ */
/*  解密任务                                                            */
/* ------------------------------------------------------------------ */

export type JobState = 'decrypting' | 'ready' | 'failed' | 'cancelled';

export interface OriginalJob {
  id: string;
  fileId: number;
  /** 加密归档文件（源） */
  srcPath: string;
  /** 解密出来的原始文件名（从 FKY996 标记里读出来的） */
  originalName: string;
  /** 临时文件路径 */
  tempPath: string;
  /** 原始内容大小（解密完成后才知道准确值） */
  contentBytes: number;
  /** 预期大小（≈ 密文大小，用来算进度） */
  expectedBytes: number;
  state: JobState;
  progress: number;
  error: string | null;
  createdAt: number;
  readyAt: number | null;
  /** 正在被 HTTP 下载（期间绝不许清理线程删文件） */
  streaming: number;
  /** 已经下完并清理掉的标记 */
  finished: boolean;
  child?: ChildProcess;
  startedBy: string;
}

const jobs = new Map<string, OriginalJob>();

export function getJob(id: string): OriginalJob | undefined {
  return jobs.get(id);
}

export function listJobs(sessionKey?: string): OriginalJob[] {
  const all = [...jobs.values()].filter((j) => !j.finished);
  return (sessionKey ? all.filter((j) => j.startedBy === sessionKey) : all).sort((a, b) => b.createdAt - a.createdAt);
}

export function publicJob(j: OriginalJob): Record<string, unknown> {
  return {
    id: j.id,
    fileId: j.fileId,
    originalName: j.originalName,
    contentBytes: j.contentBytes,
    expectedBytes: j.expectedBytes,
    state: j.state,
    progress: j.progress,
    error: j.error,
    createdAt: new Date(j.createdAt).toISOString(),
    readyAt: j.readyAt ? new Date(j.readyAt).toISOString() : null,
  };
}

/** 删掉临时文件并把任务从内存里摘掉 */
export function dropJob(id: string, reason: string): void {
  const j = jobs.get(id);
  if (!j) return;
  try {
    if (j.tempPath && fs.existsSync(j.tempPath)) fs.rmSync(j.tempPath, { force: true });
  } catch (e) {
    scoped.warn(`[MARK:ORIGINAL_DL] 删除临时文件失败 ${j.tempPath}：${(e as Error).message}`);
  }
  j.finished = true;
  jobs.delete(id);
  scoped.mark('ORIGINAL_DL', `已清理临时文件（${reason}）：#${j.fileId} ${j.originalName}`);
}

export function cancelJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j) return false;
  try {
    j.child?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  j.state = 'cancelled';
  dropJob(id, '用户取消');
  return true;
}

/** 从加密归档里解出原始文件名（需要先解密，标记在密文内部） */
function readOriginalNameFromPlain(plainFile: string): string | null {
  if (!hasVltMarker(plainFile)) return null;
  const name = readVltOriginalName(plainFile);
  if (!name) return null;
  // 去掉路径分隔，防目录穿越；截断到安全长度
  return name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 180) || null;
}

/**
 * 开始一个解密任务（立即返回，后台跑）。
 * 失败原因会写进 job.error，前端轮询时能看到。
 */
export function startOriginalJob(fileId: number, sessionKey: string): { ok: true; job: OriginalJob } | { ok: false; error: string; code: string } {
  if (!originalDownloadEnabled()) {
    return { ok: false, error: '服务端没有配置 ORIGINAL_DL_SECRET，该功能未启用', code: 'ORIGINAL_DL_DISABLED' };
  }
  const row = filesRepo.get(fileId);
  if (!row) return { ok: false, error: '文件记录不存在', code: 'FILE_NOT_FOUND' };
  if (!fs.existsSync(row.path)) return { ok: false, error: '磁盘上的加密文件已不存在', code: 'FILE_MISSING' };

  // 同一个文件已经在解密/已就绪 → 直接复用，别重复解
  const existing = [...jobs.values()].find((j) => j.fileId === fileId && !j.finished && j.state !== 'failed');
  if (existing) return { ok: true, job: existing };

  const size = fs.statSync(row.path).size;
  // 解密要在同分区再写一份，空间不够就别开始（这正是"预留周转空间"的用途）
  const free = freeBytes(config.dirs.state);
  const need = size + 64 * 1024 * 1024;   // 留 64MB 余量
  if (free < need) {
    return {
      ok: false,
      error: `磁盘空间不足：解密需要约 ${(size / 1024 ** 3).toFixed(2)} GiB，当前可用 ${(free / 1024 ** 3).toFixed(2)} GiB`,
      code: 'NO_SPACE',
    };
  }

  ensureTempDir();
  const id = crypto.randomBytes(12).toString('hex');
  const job: OriginalJob = {
    id,
    fileId,
    srcPath: row.path,
    originalName: `${row.name}.mp4`,       // 解密完会被真实名字覆盖
    tempPath: path.join(tempDir(), `${id}.part`),
    contentBytes: 0,
    expectedBytes: size,
    state: 'decrypting',
    progress: 0,
    error: null,
    createdAt: Date.now(),
    readyAt: null,
    streaming: 0,
    finished: false,
    startedBy: sessionKey,
  };
  jobs.set(id, job);
  scoped.mark('ORIGINAL_DL', `开始临时解密 #${fileId}（${row.name}，${(size / 1024 ** 2).toFixed(1)} MiB）→ ${path.basename(job.tempPath)}`);
  void runDecrypt(job);
  return { ok: true, job };
}

async function runDecrypt(job: OriginalJob): Promise<void> {
  const pwd = passwordOf();          // 与加密时同一个 ENCRYPT_PASSWORD
  const { key, iv } = deriveKeyIv(pwd);
  await new Promise<void>((resolve) => {
    const child = spawn(config.bins.openssl, ['enc', '-d', '-aes-256-cbc', '-K', key, '-iv', iv, '-in', job.srcPath, '-out', job.tempPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    job.child = child;
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      job.state = 'failed';
      job.error = `openssl 启动失败：${e.message}`;
      dropJob(job.id, '启动失败');
      resolve();
    });
    child.on('close', (code) => {
      job.child = undefined;
      if (job.state === 'cancelled') {
        resolve();
        return;
      }
      if (code !== 0) {
        job.state = 'failed';
        job.error = `解密失败（openssl 退出码 ${code}）：${stderr.trim().slice(-200) || '未知错误'}`;
        scoped.error(`[MARK:ORIGINAL_DL] 临时解密失败 #${job.fileId}：${job.error}`);
        dropJob(job.id, '解密失败');
        resolve();
        return;
      }
      try {
        const name = readOriginalNameFromPlain(job.tempPath);
        if (!name) {
          job.state = 'failed';
          job.error = '解密结果里没有 FKY996 标记（文件可能不是本工具加密的，或密码不对）';
          scoped.error(`[MARK:ORIGINAL_DL] ${job.error} #${job.fileId}`);
          dropJob(job.id, '标记校验失败');
          resolve();
          return;
        }
        // 砍掉尾部标记：内容长度 = 明文长度 − 104 − 文件名长度
        const plainSize = fs.statSync(job.tempPath).size;
        const nameLen = Buffer.byteLength(name, 'utf8');
        const contentLen = plainSize - 104 - nameLen;
        if (contentLen < 0) {
          job.state = 'failed';
          job.error = '解密结果长度异常，文件可能已损坏';
          dropJob(job.id, '长度异常');
          resolve();
          return;
        }
        fs.truncateSync(job.tempPath, contentLen);
        job.originalName = name;
        job.contentBytes = contentLen;
        job.progress = 100;
        job.state = 'ready';
        job.readyAt = Date.now();
        scoped.mark('ORIGINAL_DL', `临时解密完成 #${job.fileId} → ${name}（${(contentLen / 1024 ** 2).toFixed(1)} MiB，${Date.now() - job.createdAt}ms）`);
      } catch (e) {
        job.state = 'failed';
        job.error = `处理解密结果失败：${(e as Error).message}`;
        dropJob(job.id, '处理失败');
      }
      resolve();
    });
  });
}

/* ------------------------------------------------------------------ */
/*  后台：进度更新 + 超时清理 + 开机清理                                  */
/* ------------------------------------------------------------------ */

let timer: NodeJS.Timeout | null = null;
const SWEEP_INTERVAL_MS = 60_000;

/** 跑一轮清理/进度检查（导出是为了测试能确定性地触发，不用等 1 分钟） */
export function sweepOnce(): void {
  const now = Date.now();
  pruneUnlockState(now);
  for (const job of [...jobs.values()]) {
    // 进度：openssl 不报进度，看临时文件长到多大了（预期≈密文大小）
    if (job.state === 'decrypting' && job.expectedBytes > 0) {
      try {
        const sz = fs.statSync(job.tempPath).size;
        job.progress = Math.max(job.progress, Math.min(99, Math.floor((sz / job.expectedBytes) * 100)));
      } catch {
        /* 文件还没建出来 */
      }
    }
    // 超时清理：就绪后超过 1 小时还没被下走（或在下载但确认不了）→ 删
    if (job.state === 'ready' && job.readyAt && now - job.readyAt > TEMP_MAX_AGE_MS && job.streaming === 0) {
      dropJob(job.id, '超过 1 小时未下载完');
    }
    // 解密卡死保护：超过 1 小时还在解密 → 判失败（大文件也不该这么久）
    if (job.state === 'decrypting' && now - job.createdAt > TEMP_MAX_AGE_MS) {
      try {
        job.child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      job.state = 'failed';
      job.error = '解密超时（超过 1 小时），已中止';
      dropJob(job.id, '解密超时');
    }
  }
  // 目录里不该有任务认领的文件（比如上一轮进程被杀留下的）→ 兜底删掉
  try {
    const dir = tempDir();
    if (fs.existsSync(dir)) {
      const known = new Set([...jobs.values()].map((j) => path.basename(j.tempPath)));
      for (const name of fs.readdirSync(dir)) {
        if (known.has(name)) continue;
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (now - st.mtimeMs > TEMP_MAX_AGE_MS) {
          fs.rmSync(p, { force: true });
          scoped.mark('ORIGINAL_DL', `清理孤儿临时文件：${name}`);
        }
      }
    }
  } catch {
    /* ignore */
  }
}

export function startOriginalDownloadWorker(): void {
  if (timer) return;
  const boot = purgeTempOnBoot();
  scoped.mark('BOOT', `「下载原始文件」临时目录已清空（开机）：删除 ${boot.removed} 项、释放 ${(boot.bytes / 1024 ** 2).toFixed(1)} MiB`);
  if (!originalDownloadEnabled()) {
    scoped.mark('BOOT', '「下载原始文件」未启用（.env 里没有 ORIGINAL_DL_SECRET）');
    return;
  }
  timer = setInterval(sweepOnce, SWEEP_INTERVAL_MS);
  scoped.mark('BOOT', `「下载原始文件」已启用：密码每 ${CODE_WINDOW_MS / 60000} 分钟换一次，临时文件最多留 ${TEMP_MAX_AGE_MS / 60000} 分钟`);
}

export function stopOriginalDownloadWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
  for (const job of [...jobs.values()]) {
    try {
      job.child?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    dropJob(job.id, '服务退出');
  }
}
