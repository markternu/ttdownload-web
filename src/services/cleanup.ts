import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { bus } from '../core/events';
import { filesRepo } from '../core/db';
import { logger } from '../core/logger';
import { getSettings } from './settings';

export interface CleanupResult {
  deleted: number;
  freedBytes: number;
  skipped: number;
  errors: { id: number; message: string }[];
}

/** 判断路径是否安全地位于消费者目录内的普通文件 */
function safeConsumerPath(p: string): boolean {
  try {
    const resolved = path.resolve(p);
    const root = path.resolve(config.dirs.consumer) + path.sep;
    if (!resolved.startsWith(root)) return false;
    const lst = fs.lstatSync(resolved);
    if (lst.isSymbolicLink() || !lst.isFile()) return false;
    const rel = path.relative(config.dirs.consumer, resolved);
    if (rel.startsWith('..') || rel.includes('/../')) return false;
    if (path.basename(resolved).startsWith('.')) return false;
    return true;
  } catch {
    return false;
  }
}

/** 安卓上报下载完成 -> 删除对应的已发布文件（腾出空间给后续任务） */
export function cleanupPublished(ids: number[]): CleanupResult {
  const settings = getSettings();
  const result: CleanupResult = { deleted: 0, freedBytes: 0, skipped: 0, errors: [] };
  for (const id of ids) {
    const file = filesRepo.get(id);
    if (!file) {
      result.skipped += 1;
      continue;
    }
    if (!fs.existsSync(file.path)) {
      filesRepo.markDownloaded(id);
      result.skipped += 1;
      continue;
    }
    if (!settings.autoDeleteAfterReport) {
      filesRepo.markDownloaded(id);
      result.skipped += 1;
      continue;
    }
    if (!safeConsumerPath(file.path)) {
      result.errors.push({ id, message: '路径不在消费者目录内，已拒绝删除' });
      continue;
    }
    try {
      const size = fs.statSync(file.path).size;
      fs.rmSync(file.path, { force: true });
      filesRepo.markDownloaded(id);
      result.deleted += 1;
      result.freedBytes += size;
      logger.info(`消费者已下载完成，删除服务器文件: ${file.path}（释放 ${size} 字节）`);
      bus.emitFile({ action: 'deleted', id, path: file.path, freedBytes: size });
    } catch (e) {
      result.errors.push({ id, message: (e as Error).message });
    }
  }
  if (result.freedBytes > 0) {
    // 安卓上报删除后：广播"空间已腾挪"，等待队列立即重新评估
    bus.emitSpaceFreed({
      bytes: result.freedBytes,
      reason: 'android-reported-done',
      detail: { ids, deleted: result.deleted },
    });
  }
  return result;
}

/** 手动删除已发布文件（管理端："删除记录" vs "删除文件" 明确区分） */
export function deletePublished(id: number, withFile: boolean): { ok: boolean; deletedFile: boolean; error?: string } {
  const file = filesRepo.get(id);
  if (!file) return { ok: false, deletedFile: false, error: '文件记录不存在' };
  let deletedFile = false;
  if (withFile) {
    if (!safeConsumerPath(file.path)) {
      return { ok: false, deletedFile: false, error: '路径不在消费者目录内，已拒绝删除' };
    }
    try {
      fs.rmSync(file.path, { force: true });
      deletedFile = true;
    } catch (e) {
      return { ok: false, deletedFile: false, error: (e as Error).message };
    }
  }
  filesRepo.remove(id);
  bus.emitFile({ action: 'removed', id, withFile });
  return { ok: true, deletedFile };
}
