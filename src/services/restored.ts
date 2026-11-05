/**
 * 【还原文件目录】—— 播放器 和 「下载原始文件」 解密/解压出来的文件，**统一放这里**。
 *
 * 规则（用户指定）：
 *   · 每个文件从「还原成功」那一刻起，**单独**活 4 小时（不是滑动窗口，看下载/播放不续命）；
 *   · 用 `restored_files` 表登记（落库），进程重启后照样按到期时间清理；
 *   · 设置页顶部有「手动清理垃圾」→ 不管有没有到期，整个【还原文件目录】全部清空；
 *   · 另外还有 4 小时到期的后台巡检（每 5 分钟一趟）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { restoredRepo, type RestoredRow } from '../core/db';
import { logger } from '../core/logger';

const scoped = logger.child('restored');

/** 每个还原文件可活 4 小时（从还原成功那一刻算起） */
export const RESTORED_TTL_MS = 4 * 60 * 60_000;

/** 界面上显示的名字 */
export const RESTORED_DIR_LABEL = '还原文件目录';

/** 【还原文件目录】路径：state/restored */
export function restoredDir(): string {
  return path.join(config.dirs.state, 'restored');
}

export function ensureRestoredDir(): string {
  const dir = restoredDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** 递归算体积（文件或目录） */
export function sizeOfPath(p: string): number {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return 0;
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    let sum = 0;
    for (const name of fs.readdirSync(p)) sum += sizeOfPath(path.join(p, name));
    return sum;
  } catch {
    return 0;
  }
}

/**
 * 登记一个刚还原好的文件（或播放任务的临时目录）。
 * 目录也允许：播放器一个任务一个目录，到期整目录一起清。
 */
export function registerRestored(input: {
  path: string;
  kind: 'original' | 'player';
  sourceFileId?: number | null;
  sizeBytes?: number;
  readyAt?: number;
}): void {
  const readyAt = input.readyAt ?? Date.now();
  const sizeBytes = input.sizeBytes ?? sizeOfPath(input.path);
  restoredRepo.upsert({
    path: input.path,
    kind: input.kind,
    sourceFileId: input.sourceFileId ?? null,
    sizeBytes,
    readyAt,
    expiresAt: readyAt + RESTORED_TTL_MS,
  });
  scoped.mark('RESTORED_ADD', `还原文件登记：${path.basename(input.path)}（${input.kind}，${(sizeBytes / 1024 ** 2).toFixed(1)} MiB，4 小时后清理）`, {
    kind: input.kind,
    sizeBytes,
  });
}

/** 删掉一个还原文件/目录并注销登记（幂等） */
export function removeRestored(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    scoped.warn(`[MARK:RESTORED_CLEAN] 删除失败 ${p}：${(e as Error).message}`);
  }
  restoredRepo.remove(p);
}

/** 清理已到期的还原文件（每 5 分钟 / 开机各跑一次） */
export function sweepRestored(now = Date.now()): { removed: number; bytes: number } {
  let removed = 0;
  let bytes = 0;
  for (const row of restoredRepo.expired(now)) {
    bytes += row.size_bytes || sizeOfPath(row.path);
    removeRestored(row.path);
    removed += 1;
  }
  if (removed) {
    scoped.mark('RESTORED_CLEAN', `还原文件到期清理：删除 ${removed} 项，释放 ${(bytes / 1024 ** 2).toFixed(1)} MiB`, { removed, bytes });
  }
  return { removed, bytes };
}

/**
 * 一键清空【还原文件目录】：**不管有没有到期全部删干净**。
 * 同时清掉登记表里所有记录。
 */
export function cleanAllRestored(): { removed: number; bytes: number } {
  const dir = restoredDir();
  let removed = 0;
  let bytes = 0;
  try {
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        bytes += sizeOfPath(p);
        try {
          fs.rmSync(p, { recursive: true, force: true });
          removed += 1;
        } catch (e) {
          scoped.warn(`[MARK:RESTORED_CLEAN] 删除失败 ${p}：${(e as Error).message}`);
        }
      }
    }
  } catch (e) {
    scoped.warn(`[MARK:RESTORED_CLEAN] 读取目录失败：${(e as Error).message}`);
  }
  // 表里可能有路径已经不在目录里的记录 → 一并清掉
  const rows = restoredRepo.list();
  for (const r of rows) bytes += r.size_bytes || 0;
  restoredRepo.clear();
  if (removed || rows.length) {
    scoped.mark('RESTORED_CLEAN', `一键清空【还原文件目录】：删除 ${removed} 项，释放 ${(bytes / 1024 ** 2).toFixed(1)} MiB`, { removed, bytes });
  }
  return { removed, bytes };
}

/** 列出当前登记的还原文件（诊断/展示用） */
export function listRestored(): RestoredRow[] {
  return restoredRepo.list();
}

/** 开机：先按 4 小时规则清掉已到期的（没到期的保留） */
export function sweepRestoredOnBoot(): { removed: number; bytes: number } {
  return sweepRestored();
}

let timer: NodeJS.Timeout | null = null;
const SWEEP_INTERVAL_MS = 5 * 60_000;

export function startRestoredWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      sweepRestored();
    } catch (e) {
      scoped.error(`[MARK:ERROR] 还原文件巡检异常：${(e as Error).message}`);
    }
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  scoped.mark('BOOT', `【还原文件目录】已就绪：${restoredDir()}（每个文件还原后活 ${RESTORED_TTL_MS / 3600e3} 小时）`);
}

export function stopRestoredWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
