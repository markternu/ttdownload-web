import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { bus } from '../core/events';
import { filesRepo, tasksRepo } from '../core/db';
import { logger } from '../core/logger';
import { archiveTaskFiles, moveWithDedup } from './archive';
import { encryptFile, stripExtension } from './crypto';
import { encryptPassword, getSettings } from './settings';
import { cleanupBtTaskDirs } from './btCleanup';
import type { Task } from '../types';

/**
 * 归档 → 加密 → 发布 流水线（消费者目录）。
 * 由任务状态驱动（archiving / encrypting），保证服务重启后可继续。
 */

let timer: NodeJS.Timeout | null = null;
let running = false;

/** 归档：把模块下载好的文件移到 downd_ok_p2（打包/命名/V-L-T 标记） */
async function processArchiving(): Promise<void> {
  const list = tasksRepo.byStatus(['archiving']) as (Task & { payload?: Record<string, unknown> })[];
  for (const task of list) {
    const payload = task.payload ?? {};
    const files = Array.isArray(payload.downloadedPaths) ? (payload.downloadedPaths as string[]) : [];
    const originalName = String(payload.originalName ?? task.title ?? `task_${task.id}`);
    const res = await archiveTaskFiles(files, {
      originalName,
      title: task.title,
      multiFileHint: files.length > 1,
    });
    if (!res.ok) {
      tasksRepo.update(task.id, { status: 'failed', error: `归档失败: ${res.error}` });
      bus.emitTask(tasksRepo.get(task.id));
      continue;
    }
    tasksRepo.update(task.id, {
      status: 'encrypting',
      publishedName: res.publishedName,
      payload: { ...payload, archivePath: res.archivePath, originalName: res.originalName, archiveSize: res.sizeBytes },
    });
    bus.emitTask(tasksRepo.get(task.id));
  }
}

/** 加密：downd_ok_p2 -> 加密临时区 -> 去后缀 -> 消费者目录 */
async function processEncrypting(): Promise<void> {
  const list = tasksRepo.byStatus(['encrypting']) as (Task & { payload?: Record<string, unknown> })[];
  const settings = getSettings();
  const pwd = encryptPassword();
  for (const task of list) {
    const payload = task.payload ?? {};
    const archivePath = String(payload.archivePath ?? '');
    const originalName = String(payload.originalName ?? task.title ?? `task_${task.id}`);
    if (!archivePath || !fs.existsSync(archivePath)) {
      tasksRepo.update(task.id, { status: 'failed', error: '加密失败: 归档文件不存在' });
      bus.emitTask(tasksRepo.get(task.id));
      continue;
    }
    fs.mkdirSync(config.dirs.encryptTmp, { recursive: true });
    fs.mkdirSync(config.dirs.consumer, { recursive: true });

    const base = path.basename(archivePath);
    const inTmp = moveWithDedup(archivePath, config.dirs.encryptTmp, base);
    const encrypted = `${inTmp}.data`;
    const res = await encryptFile(inTmp, encrypted, pwd);
    if (!res.ok) {
      tasksRepo.update(task.id, { status: 'failed', error: `加密失败: ${res.error}` });
      bus.emitTask(tasksRepo.get(task.id));
      continue;
    }
    fs.rmSync(inTmp, { force: true });
    const stripped = stripExtension(encrypted);
    const finalPath = moveWithDedup(stripped, config.dirs.consumer, path.basename(stripped));
    const sizeBytes = fs.statSync(finalPath).size;
    const fileId = filesRepo.add({
      taskId: task.id,
      name: path.basename(finalPath),
      title: originalName,
      module: task.module,
      sizeBytes,
      path: finalPath,
    });
    tasksRepo.update(task.id, {
      status: 'completed',
      progress: 100,
      finishedAt: new Date().toISOString(),
      publishedName: path.basename(finalPath),
      payload: { ...payload, publishedPath: finalPath, fileId },
    });
    logger.info(`发布完成: ${originalName} -> ${finalPath} (${sizeBytes} 字节)`);

    // BT "按可播放处理"的任务：发布完成后清理下载目录 / transmission incomplete 目录（释放空间并广播）
    if (payload.pendingDirCleanup) {
      const torrentName = String(payload.pendingDirCleanupName ?? originalName);
      const freedBytes = cleanupBtTaskDirs(tasksRepo.get(task.id) as Task, torrentName, 'bt-salvage-cleanup');
      logger.info(`BT 出清[挽救] 清理任务目录完成，释放 ${(freedBytes / 1024 / 1024).toFixed(1)}MB`);
    }
    const updated = tasksRepo.get(task.id);
    bus.emitTask(updated);
    const file = filesRepo.get(fileId);
    bus.emitFile({
      action: 'published',
      file: file
        ? {
            id: file.id,
            name: file.name,
            title: file.title,
            module: file.module,
            sizeBytes: file.size_bytes,
            createdAt: file.created_at,
            downloadUrl: `/api/android/download/${file.id}`,
            downloaded: !!file.downloaded,
          }
        : null,
    });
  }
}

export async function pipelineTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await processArchiving();
    await processEncrypting();
  } catch (e) {
    logger.error(`流水线异常: ${(e as Error).message}`);
  } finally {
    running = false;
  }
}

export function startPipeline(): void {
  if (timer) return;
  timer = setInterval(() => {
    void pipelineTick();
  }, config.pipelineIntervalMs);
  logger.info(`归档/加密流水线已启动（每 ${Math.round(config.pipelineIntervalMs / 1000)} 秒一轮）`);
}

export function stopPipeline(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 手工把文件推入归档（模块完成时调用）：更新任务状态即可，流水线会自动接手 */
export function handoffToArchive(taskId: number, downloadedPaths: string[], originalName: string, sizeBytes: number): void {
  tasksRepo.update(taskId, {
    status: 'archiving',
    progress: 100,
    speedBps: 0,
    etaSec: 0,
    totalBytes: sizeBytes,
    downloadedBytes: sizeBytes,
    finishedAt: new Date().toISOString(),
    payload: { downloadedPaths, originalName },
  });
  const task = tasksRepo.get(taskId);
  bus.emitTask(task);
  logger.info(`任务 #${taskId} 下载完成，进入归档队列（${downloadedPaths.length} 个文件）`);
}
