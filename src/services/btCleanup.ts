import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { bus } from '../core/events';
import { logger } from '../core/logger';
import { pathSizeBytes } from '../core/disk';
import type { Task } from '../types';

/**
 * BT 任务目录清理（出清 / 手动取消 共用）
 *  - 我们自己的任务下载目录：DOWNLOAD_ROOT/transmission/downloads/<种子名>
 *  - transmission 的 incomplete 目录：默认 /var/lib/transmission/incomplete/<种子名>
 * 安全：只允许删除白名单根目录内的普通目录（拒绝根目录、符号链接、隐藏目录、路径穿越）
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
  if (payload.downloadDir) out.add(String(payload.downloadDir));
  const safeName = String(torrentName || '').replace(/[/\\]/g, '_').trim();
  if (safeName) {
    out.add(path.join(config.dirs.btDownload, safeName));
    out.add(path.join(config.transmissionIncompleteDir, safeName));
    out.add(path.join(config.transmissionIncompleteDir, `${safeName}.parts`));
  }
  return [...out];
}

export interface RemoveDirsResult {
  freedBytes: number;
  removed: string[];
  skipped: string[];
}

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
      logger.info(`目录清理已删除: ${dir}（释放 ${(size / 1024 / 1024).toFixed(1)}MB）`);
    } catch (e) {
      logger.error(`目录清理删除失败 ${dir}: ${(e as Error).message}`);
      skipped.push(dir);
    }
  }
  return { freedBytes, removed, skipped };
}

/**
 * 清理一个 BT 任务的所有相关目录；只要释放了空间就广播"空间已腾挪"
 * @returns 释放的字节数
 */
export function cleanupBtTaskDirs(task: Task, torrentName: string, reason: string): number {
  const result = removeDirs(candidateDirs(task, torrentName));
  if (result.freedBytes > 0) {
    bus.emitSpaceFreed({
      bytes: result.freedBytes,
      reason,
      detail: { taskId: task.id, title: torrentName, removedDirs: result.removed },
    });
  }
  return result.freedBytes;
}
