import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { bus } from '../core/events';
import { filesRepo, tasksRepo } from '../core/db';
import { logger, taskLog } from '../core/logger';
import { archiveTaskFiles, moveWithDedup } from './archive';
import { encryptFile, stripExtension } from './crypto';
import { encryptPassword, getSettings } from './settings';
import { cleanupBtTaskDirs } from './btCleanup';
import type { ModuleId, Task } from '../types';

/**
 * 归档 → 加密 → 发布 流水线（消费者目录）。
 * 由任务状态驱动（archiving / encrypting），保证服务重启后可继续。
 */

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * 发布单元：一个单元 = 一个成品（归档 → 加密 → 消费者目录 → 安卓取走）。
 * 一个 BT 任务可以拆成多个单元（大视频各自一个），也可以只有一个（小文件合成一个 zip）。
 */
interface PublishUnit {
  files: string[];
  /** 成品名（归档时的 originalName） */
  name: string;
  archivePath?: string;
  publishedName?: string;
  originalName?: string;
  archiveSize?: number;
  fileId?: number;
}

function payloadOf(task: Task & { payload?: Record<string, unknown> }): Record<string, unknown> {
  return task.payload ?? {};
}

/** 取出任务的发布单元；老任务（没有 publishUnits）按"全部文件一个单元"处理 */
function unitsOf(task: Task & { payload?: Record<string, unknown> }): PublishUnit[] {
  const payload = payloadOf(task);
  const arr = Array.isArray(payload.publishUnits) ? (payload.publishUnits as PublishUnit[]) : null;
  if (arr && arr.length) return arr.map((u) => ({ ...u, files: Array.isArray(u.files) ? u.files : [] }));
  const files = Array.isArray(payload.downloadedPaths) ? (payload.downloadedPaths as string[]) : [];
  const originalName = String(payload.originalName ?? task.title ?? `task_${task.id}`);
  return files.length ? [{ files, name: originalName }] : [];
}

/** 归档：把模块下载好的文件移到 downd_ok_p2（打包/命名/V-L-T 标记） */
async function processArchiving(): Promise<void> {
  const list = tasksRepo.byStatus(['archiving']) as (Task & { payload?: Record<string, unknown> })[];
  for (const task of list) {
    const payload = payloadOf(task);
    const units = unitsOf(task);
    if (!units.length) {
      tasksRepo.update(task.id, { status: 'failed', error: '归档失败: 没有可归档的文件' });
      bus.emitTask(tasksRepo.get(task.id));
      continue;
    }
    let failed: string | null = null;
    for (const u of units) {
      // 断点续跑：已经归档过的单元不重复做
      if (u.archivePath && fs.existsSync(u.archivePath)) continue;
      const res = await archiveTaskFiles(u.files, {
        originalName: u.name,
        title: task.title,
        multiFileHint: u.files.length > 1,
      });
      if (!res.ok) {
        failed = res.error ?? '未知错误';
        break;
      }
      u.archivePath = res.archivePath;
      u.publishedName = res.publishedName;
      u.originalName = res.originalName;
      u.archiveSize = res.sizeBytes;
      // 逐个落盘，服务重启后能接着做剩下的
      tasksRepo.update(task.id, { payload: { ...payload, publishUnits: units } });
    }
    if (failed) {
      tasksRepo.update(task.id, { status: 'failed', error: `归档失败: ${failed}` });
      bus.emitTask(tasksRepo.get(task.id));
      continue;
    }
    const last = units[units.length - 1];
    tasksRepo.update(task.id, {
      status: 'encrypting',
      publishedName: last?.publishedName ?? null,
      payload: {
        ...payload,
        publishUnits: units,
        // 兼容老字段（单单元时就是它）
        archivePath: last?.archivePath,
        originalName: last?.originalName,
        archiveSize: last?.archiveSize,
      },
    });
    taskLog(task.id, 'pipeline').mark('ARCHIVE', `归档完成 ${units.length} 个成品`, {
      units: units.map((u) => ({ name: u.originalName, sizeBytes: u.archiveSize })),
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
    const payload = payloadOf(task);
    const units = unitsOf(task);
    fs.mkdirSync(config.dirs.encryptTmp, { recursive: true });
    fs.mkdirSync(config.dirs.consumer, { recursive: true });

    let failed: string | null = null;
    const published: { fileId: number; name: string; title: string; sizeBytes: number; path: string }[] = [];

    for (const u of units) {
      if (u.fileId) continue; // 已经发布过的单元（断点续跑）
      const archivePath = String(u.archivePath ?? '');
      const originalName = String(u.originalName ?? u.name ?? task.title ?? `task_${task.id}`);
      if (!archivePath || !fs.existsSync(archivePath)) {
        failed = `归档文件不存在: ${archivePath || '(空)'}`;
        break;
      }
      const base = path.basename(archivePath);
      const inTmp = moveWithDedup(archivePath, config.dirs.encryptTmp, base);
      const encrypted = `${inTmp}.data`;
      const res = await encryptFile(inTmp, encrypted, pwd);
      if (!res.ok) {
        failed = res.error ?? '未知错误';
        break;
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
      u.fileId = fileId;
      u.publishedName = path.basename(finalPath);
      published.push({ fileId, name: path.basename(finalPath), title: originalName, sizeBytes, path: finalPath });
      tasksRepo.update(task.id, { payload: { ...payload, publishUnits: units } });
      taskLog(task.id, 'pipeline').mark('PUBLISH', `发布完成(${published.length}/${units.length}): ${originalName} -> ${finalPath}`, { sizeBytes, finalPath });
    }

    if (failed) {
      tasksRepo.update(task.id, { status: 'failed', error: `加密失败: ${failed}`, payload: { ...payload, publishUnits: units } });
      bus.emitTask(tasksRepo.get(task.id));
      continue;
    }

    const last = published[published.length - 1];
    tasksRepo.update(task.id, {
      status: 'completed',
      progress: 100,
      finishedAt: new Date().toISOString(),
      publishedName: last?.name ?? null,
      payload: {
        ...payloadOf(tasksRepo.get(task.id) as Task & { payload?: Record<string, unknown> }),
        publishUnits: units,
        fileIds: published.map((x) => x.fileId),
        // 兼容老字段（单成品时就是它）
        publishedPath: last?.path,
        fileId: last?.fileId,
      },
    });
    if (published.length > 1) {
      taskLog(task.id, 'pipeline').mark('PUBLISH', `本任务共发布 ${published.length} 个成品`, { fileIds: published.map((x) => x.fileId) });
    }

    // BT：所有成品都发布完了，才清理下载目录 / transmission incomplete 目录
    // （改成"发布之后"是必须的：以前是下载一完成 5 秒后就删，会把还没归档的源文件删掉）
    if (payload.pendingDirCleanup) {
      const torrentName = String(payload.pendingDirCleanupName ?? task.title ?? `task_${task.id}`);
      const freedBytes = cleanupBtTaskDirs(tasksRepo.get(task.id) as Task, torrentName, 'bt-cleanup');
      taskLog(task.id, 'pipeline').mark('BT_CLEANUP', `发布完成后清理任务目录，释放 ${(freedBytes / 1024 / 1024).toFixed(1)}MB`, { freedBytes });
    }
    const updated = tasksRepo.get(task.id);
    bus.emitTask(updated);

    // 每个成品都通知一次前端/安卓（一个任务可能有多个成品）
    for (const p of published) {
      const file = filesRepo.get(p.fileId);
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
}

export async function pipelineTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await processArchiving();
    await processEncrypting();
  } catch (e) {
    logger.child('pipeline').error(`[MARK:ERROR] 流水线异常: ${(e as Error).stack ?? (e as Error).message}`);
  } finally {
    running = false;
  }
}

export function startPipeline(): void {
  if (timer) return;
  timer = setInterval(() => {
    void pipelineTick();
  }, config.pipelineIntervalMs);
  logger.mark('BOOT', `归档/加密流水线已启动（每 ${Math.round(config.pipelineIntervalMs / 1000)} 秒一轮）`);
}

export function stopPipeline(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * 为一个"已经下完、就躺在磁盘上"的文件单独创建一个发布任务。
 *
 * 用途：BT 里的大文件（≥「单独发布阈值」）**一下完就提前交付**，不用等整个种子下完
 * —— 用户能更早在手机上取到第一个成品。任务直接以 archiving 状态创建，
 * 跳过下载阶段，交给流水线正常走 归档 → 加密 → 发布。
 * 调用方负责先把该文件在 transmission 里标成 unwanted（否则文件被移走后会被重新校验/重下）。
 */
export function createPublishTask(opts: {
  module: ModuleId;
  title: string;
  platform?: string | null;
  files: string[];
  originalName: string;
  sizeBytes: number;
  parentTaskId: number;
  /** 扫货来源：发布成功后要删哪个目录、删哪个 transmission 任务 */
  harvest?: Record<string, unknown>;
}): number {
  const task = tasksRepo.create({
    module: opts.module,
    title: opts.title,
    platform: opts.platform ?? null,
    url: null,
    status: 'archiving',
    priority: 0,
    expectBytes: opts.sizeBytes,
    meta: { files: opts.files.map((f) => path.basename(f)) },
    payload: {
      downloadedPaths: opts.files,
      originalName: opts.originalName,
      publishUnits: [{ files: opts.files, name: opts.originalName }],
      parentTaskId: opts.parentTaskId,
      ...(opts.harvest ? { harvest: opts.harvest } : { earlyHandoff: true }),
    },
  });
  taskLog(task.id, 'pipeline').mark('BT_EARLY',
    `大文件已下完，提前进入归档（不等整个种子）: ${opts.originalName}`,
    { sizeBytes: opts.sizeBytes, parentTaskId: opts.parentTaskId, files: opts.files });
  bus.emitTask(tasksRepo.get(task.id));
  return task.id;
}

/** 手工把文件推入归档（模块完成时调用）：更新任务状态即可，流水线会自动接手 */
export function handoffToArchive(
  taskId: number,
  downloadedPaths: string[],
  originalName: string,
  sizeBytes: number,
  opts?: { units?: PublishUnit[]; torrentName?: string; cleanupBtDirs?: boolean },
): void {
  const prev = payloadOf(tasksRepo.get(taskId) as Task & { payload?: Record<string, unknown> });
  const payload: Record<string, unknown> = {
    ...prev,
    downloadedPaths,
    originalName,
  };
  if (opts?.units && opts.units.length) {
    payload.publishUnits = opts.units.map((u) => ({ files: u.files, name: u.name }));
  }
  if (opts?.cleanupBtDirs) {
    payload.pendingDirCleanup = true;
    payload.pendingDirCleanupName = opts.torrentName ?? originalName;
  }
  tasksRepo.update(taskId, {
    status: 'archiving',
    progress: 100,
    speedBps: 0,
    etaSec: 0,
    totalBytes: sizeBytes,
    downloadedBytes: sizeBytes,
    finishedAt: new Date().toISOString(),
    payload,
  });
  const task = tasksRepo.get(taskId);
  bus.emitTask(task);
  const unitCount = Array.isArray(payload.publishUnits) ? (payload.publishUnits as unknown[]).length : 1;
  taskLog(taskId, 'pipeline').mark('PIPELINE', `下载完成，进入归档队列（${downloadedPaths.length} 个文件 / ${unitCount} 个成品）`, {
    originalName,
    sizeBytes,
    files: downloadedPaths,
  });
}
