import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { bus } from '../core/events';
import { logger } from '../core/logger';
import { pathSizeBytes } from '../core/disk';
import { tasksRepo } from '../core/db';
import type { Task } from '../types';

/**
 * BT 任务目录清理（出清 / 手动取消 / 发布完成后 共用）
 *  - 我们自己的任务下载目录：DOWNLOAD_ROOT/transmission/downloads/<种子名>
 *  - transmission 的 incomplete 目录：默认 /var/lib/transmission/incomplete/<种子名>
 *
 * ⚠️ 两个必须守住的底线（都是真机上踩出来的）：
 *
 * 1) **不能整目录 rm -rf**。多个种子（文件名不同、但种子内部名/落盘目录相同）可能共用
 *    同一个目录；直接递归删会把别的任务还在用（甚至还没归档）的文件一起删掉。
 *    所以：先看有没有别的"非终态任务"也在用这个目录 —— 有就整块跳过；
 *    没有的话也只删**本任务自己的那些文件**，最后把空目录收掉。
 *
 * 2) **时机**。以前是在 transmission 报"下载完成"后 `setTimeout(5000)` 就删下载目录，
 *    而归档流水线此时可能还在 zip 大文件（多文件要压缩，可能好几分钟）→ 把源文件删了。
 *    现在统一由流水线在**发布完成之后**触发（payload.pendingDirCleanup）。
 */

export function allowedDeleteRoots(): string[] {
  return [
    path.resolve(config.dirs.btDownload),
    path.resolve(config.transmissionIncompleteDir),
    path.resolve(config.dirs.btPending),
  ];
}

export function isSafeToDelete(target: string): { ok: boolean; reason?: string } {
  const resolved = path.resolve(target);
  if (!resolved || resolved === path.sep) return { ok: false, reason: '路径为空或根目录' };
  const base = path.basename(resolved);
  if (!base || base === '.' || base === '..' || base.startsWith('.')) return { ok: false, reason: '非法目录名' };
  const roots = allowedDeleteRoots();
  if (!roots.some((r) => resolved.startsWith(r + path.sep))) {
    return { ok: false, reason: `不在允许删除的目录内（${roots.join(' / ')}）` };
  }
  try {
    const st = fs.lstatSync(resolved);
    if (st.isSymbolicLink()) return { ok: false, reason: '符号链接拒绝删除' };
    if (!st.isDirectory() && !st.isFile()) return { ok: false, reason: '非普通文件/目录' };
  } catch {
    return { ok: false, reason: '不存在' };
  }
  return { ok: true };
}

/** 一个 BT 任务可能散落的所有目录 */
export function candidateDirs(task: Task, torrentName: string): string[] {
  const payload = (task as Task & { payload?: Record<string, unknown> }).payload ?? {};
  const out = new Set<string>();
  if (payload.downloadDir) out.add(path.resolve(String(payload.downloadDir)));
  const safeName = String(torrentName || '').replace(/[/\\]/g, '_').trim();
  if (safeName) {
    out.add(path.resolve(path.join(config.dirs.btDownload, safeName)));
    out.add(path.resolve(path.join(config.transmissionIncompleteDir, safeName)));
    out.add(path.resolve(path.join(config.transmissionIncompleteDir, `${safeName}.parts`)));
  }
  return [...out];
}

/** 还在用磁盘/还没走完流水线的状态：这些任务占着的目录不能删 */
const ACTIVE_STATUSES = ['waiting', 'parsing', 'downloading', 'paused', 'archiving', 'encrypting'];

/**
 * 找出"别的任务也在用这些目录"的情况。
 * 判据：其它非终态任务的 downloadDir / 候选目录 与本次要删的目录有重叠（互为前缀）。
 */
export function findSharedDirs(task: Task, dirs: string[]): Map<string, number[]> {
  const mine = Number(task.id);
  const others = tasksRepo.byStatus(ACTIVE_STATUSES as never).filter((t) => Number(t.id) !== mine);
  const shared = new Map<string, number[]>();
  if (!others.length) return shared;
  const otherDirs = new Map<number, string[]>();
  for (const o of others) {
    const payload = (o as Task & { payload?: Record<string, unknown> }).payload ?? {};
    const list = new Set<string>();
    if (payload.downloadDir) list.add(path.resolve(String(payload.downloadDir)));
    const name = String((o as Task & { payload?: Record<string, unknown> }).title ?? '');
    if (name) list.add(path.resolve(path.join(config.dirs.btDownload, name.replace(/[/\\]/g, '_'))));
    otherDirs.set(Number(o.id), [...list]);
  }
  for (const dir of dirs) {
    const hit: number[] = [];
    for (const [id, list] of otherDirs) {
      if (list.some((d) => d === dir || d.startsWith(dir + path.sep) || dir.startsWith(d + path.sep))) hit.push(id);
    }
    if (hit.length) shared.set(dir, hit);
  }
  return shared;
}

export interface RemoveDirsResult {
  freedBytes: number;
  removed: string[];
  skipped: string[];
  /** 因为别的任务也在用而整块跳过的目录 */
  sharedSkipped: string[];
}

/** 本任务自己的文件绝对路径（用于"只删自己的"） */
function ownFilePaths(task: Task, dirs: string[]): string[] {
  const payload = (task as Task & { payload?: Record<string, unknown> }).payload ?? {};
  const out = new Set<string>();
  const downloaded = Array.isArray(payload.downloadedPaths) ? (payload.downloadedPaths as string[]) : [];
  for (const p of downloaded) if (p) out.add(path.resolve(String(p)));
  const meta = (task as Task & { meta?: { files?: string[] } }).meta;
  const rel = Array.isArray(meta?.files) ? meta?.files ?? [] : [];
  for (const dir of dirs) {
    for (const name of rel) {
      if (!name) continue;
      out.add(path.resolve(path.join(dir, String(name))));
    }
  }
  return [...out];
}

/** 自底向上收掉空目录（只收白名单根目录之内的） */
function pruneEmptyDirs(dirs: string[]): string[] {
  const removed: string[] = [];
  const roots = allowedDeleteRoots();
  const sorted = [...dirs].sort((a, b) => b.length - a.length);
  for (const dir of sorted) {
    const resolved = path.resolve(dir);
    if (!roots.some((r) => resolved.startsWith(r + path.sep))) continue;
    try {
      const st = fs.lstatSync(resolved);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (fs.readdirSync(resolved).length === 0) {
        fs.rmdirSync(resolved);
        removed.push(resolved);
        logger.child('bt-cleanup').mark('BT_CLEANUP', `空目录已回收: ${resolved}`);
      } else {
        const left = fs.readdirSync(resolved).length;
        logger.child('bt-cleanup').mark('BT_CLEANUP', `目录非空，保留（可能是别的任务的资源）: ${resolved}`, { leftEntries: left });
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}

/**
 * 清理一个 BT 任务占用的空间：
 *   ① 别的非终态任务也在用同一个目录 → 整块跳过（宁可不释放也不误删）
 *   ② 只删本任务自己的文件（payload.downloadedPaths + meta.files）
 *   ③ 收掉变空的目录；非空的保留并记日志
 */
export function cleanupBtTaskDirs(task: Task, torrentName: string, reason: string): number {
  const t = tasksRepo.get(Number(task.id)) ?? task;
  const dirs = candidateDirs(t, torrentName);
  const shared = findSharedDirs(t, dirs);
  const sharedSkipped = [...shared.keys()];

  if (sharedSkipped.length) {
    for (const [dir, ids] of shared) {
      logger.child('bt-cleanup').mark('BT_CLEANUP_SHARED', `目录被其它任务共用，本次不删: ${dir}`, {
        reason,
        taskId: t.id,
        sharedWith: ids,
      });
    }
  }

  const exclusive = dirs.filter((d) => !shared.has(d));
  const sharedDirs = dirs.filter((d) => shared.has(d));
  let freedBytes = 0;
  const removed: string[] = [];
  const skipped: string[] = [];

  // ① 独占的目录：整目录删掉（这样 .part / 未选中的残留文件也能一起清掉，空间才真的回来）
  const exclusiveResult = removeDirs(exclusive);
  freedBytes += exclusiveResult.freedBytes;
  removed.push(...exclusiveResult.removed);
  skipped.push(...exclusiveResult.skipped);

  // ② 被共用的目录：绝不整目录删，只删本任务自己的那些文件，再收掉空目录
  if (sharedDirs.length) {
    for (const file of ownFilePaths(t, sharedDirs)) {
      const safety = isSafeToDelete(file);
      if (!safety.ok) {
        if (safety.reason !== '不存在') skipped.push(file);
        continue;
      }
      try {
        const size = pathSizeBytes(file);
        fs.rmSync(file, { recursive: true, force: true });
        freedBytes += size;
        removed.push(file);
      } catch (e) {
        logger.child('bt-cleanup').error(`[MARK:BT_CLEANUP] 删除失败 ${file}: ${(e as Error).message}`);
        skipped.push(file);
      }
    }
    pruneEmptyDirs(sharedDirs);
  }

  if (removed.length) {
    logger.child('bt-cleanup').mark('BT_CLEANUP',
      `已清理 ${removed.length} 项，释放 ${(freedBytes / 1024 / 1024).toFixed(1)}MB`, { reason, taskId: t.id, removed: removed.slice(0, 20) });
  }
  if (freedBytes > 0) {
    bus.emitSpaceFreed({
      bytes: freedBytes,
      reason,
      detail: { taskId: t.id, title: torrentName, removedFiles: removed.length, sharedSkipped },
    });
  }
  return freedBytes;
}

/** 底层：按目录整块删除（仅用于确定独占的目录；会做安全检查） */
export function removeDirs(dirs: string[]): RemoveDirsResult {
  let freedBytes = 0;
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const dir of dirs) {
    const safety = isSafeToDelete(dir);
    if (!safety.ok) {
      if (safety.reason !== '不存在') logger.warn(`目录清理跳过 ${dir}: ${safety.reason}`);
      skipped.push(dir);
      continue;
    }
    const size = pathSizeBytes(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      freedBytes += size;
      removed.push(dir);
      logger.child('bt-cleanup').mark('BT_CLEANUP', `目录清理已删除: ${dir}`, { freedBytes: size });
    } catch (e) {
      logger.child('bt-cleanup').error(`[MARK:BT_CLEANUP] 目录清理删除失败 ${dir}: ${(e as Error).message}`);
      skipped.push(dir);
    }
  }
  return { freedBytes, removed, skipped, sharedSkipped: [] };
}
