import { config } from './config';
import { bus } from './events';
import { logger } from './logger';
import { tasksRepo } from './db';
import { freeBytes } from './disk';
import { getSettings } from '../services/settings';
import { handoffToArchive } from '../services/pipeline';
import { aria2Module } from '../modules/aria2';
import { transmissionModule } from '../modules/transmission';
import { webvideoModule } from '../modules/webvideo';
import type { ModuleAdapter, PollResult, TaskWithPayload } from '../modules/types';
import type { ModuleId, Task, TaskStatus } from '../types';

const adapters: Record<ModuleId, ModuleAdapter> = {
  transmission: transmissionModule,
  aria2: aria2Module,
  webvideo: webvideoModule,
};

let timer: NodeJS.Timeout | null = null;
let ticking = false;

function emit(taskId: number): void {
  bus.emitTask(tasksRepo.get(taskId));
}

/**
 * 永久性错误：重试也没用，直接失败。
 * 注意：「需要登录 / 私有 / 会员专享」**不算**永久错误 —— 用户补上 cookies 或换客户端后可能就能下，
 * 属于「尽力重试」范围，交给各模块的策略阶梯与自动重试处理。
 */
function isPermanentError(msg: string): boolean {
  return /URL 格式错误|不支持该链|没有视频或图片|DRM|种子文件不存在|未安装|不可用：请|找不到文件/.test(msg);
}

function failTask(task: TaskWithPayload, message: string): void {
  const settings = getSettings();
  const retryCount = Number(task.retryCount ?? 0);
  if (!isPermanentError(message) && retryCount < settings.autoRetry) {
    tasksRepo.update(task.id, {
      status: 'waiting',
      retryCount: retryCount + 1,
      error: `${message}（第 ${retryCount + 1} 次重试）`,
      speedBps: 0,
    });
    logger.warn(`任务 #${task.id} 失败将重试(${retryCount + 1}/${settings.autoRetry}): ${message}`);
  } else {
    tasksRepo.update(task.id, { status: 'failed', error: message, speedBps: 0, finishedAt: new Date().toISOString() });
    logger.error(`任务 #${task.id} 失败: ${message}`);
  }
  emit(task.id);
}

function applyProgress(taskId: number, r: PollResult): void {
  const patch: Record<string, unknown> = {};
  if (r.status) patch.status = r.status;
  if (typeof r.progress === 'number') patch.progress = Math.max(0, Math.min(100, r.progress));
  if (typeof r.speedBps === 'number') patch.speedBps = r.speedBps;
  if (r.etaSec !== undefined) patch.etaSec = r.etaSec;
  if (typeof r.totalBytes === 'number' && r.totalBytes > 0) patch.totalBytes = r.totalBytes;
  if (typeof r.downloadedBytes === 'number') patch.downloadedBytes = r.downloadedBytes;
  if (typeof r.expectBytes === 'number' && r.expectBytes > 0) patch.expectBytes = r.expectBytes;
  if (Object.keys(patch).length) {
    tasksRepo.update(taskId, patch);
    emit(taskId);
  }
}

async function pollRunning(): Promise<number> {
  const running = tasksRepo.byStatus(['downloading', 'parsing']) as TaskWithPayload[];
  for (const task of running) {
    const adapter = adapters[task.module];
    if (!adapter) continue;
    try {
      const r = await adapter.poll(task);
      if (r.done) {
        handoffToArchive(task.id, r.done.files, r.done.originalName, r.done.sizeBytes);
        continue;
      }
      if (r.error) {
        failTask(task, r.error);
        continue;
      }
      applyProgress(task.id, r);
    } catch (e) {
      logger.error(`轮询任务 #${task.id} 异常: ${(e as Error).message}`);
    }
  }
  return running.length;
}

/** 空间压力：可用空间低于保留值时，暂停正在下载的任务 */
async function applySpacePressure(usable: number): Promise<void> {
  if (usable >= 0) return;
  const running = tasksRepo.byStatus(['downloading', 'parsing']) as TaskWithPayload[];
  for (const task of running) {
    const adapter = adapters[task.module];
    try {
      await adapter.pause(task);
    } catch {
      /* ignore */
    }
    tasksRepo.update(task.id, {
      status: 'paused',
      speedBps: 0,
      error: '磁盘空间不足，已自动暂停（等待空间释放）',
      payload: { ...(task.payload ?? {}), pausedBySpace: true },
    });
    emit(task.id);
    logger.warn(`任务 #${task.id} 因磁盘空间不足被自动暂停`);
  }
}

/** 空间恢复后，恢复被自动暂停的任务 */
async function resumeSpacePaused(usable: number): Promise<void> {
  const paused = tasksRepo.byStatus(['paused']) as TaskWithPayload[];
  for (const task of paused) {
    if (!(task.payload ?? {}).pausedBySpace) continue;
    const need = Math.max(0, task.expectBytes || 0);
    if (usable - need < 0) continue;
    const adapter = adapters[task.module];
    try {
      await adapter.resume(task);
    } catch {
      /* ignore */
    }
    tasksRepo.update(task.id, {
      status: 'downloading',
      error: null,
      payload: { ...(task.payload ?? {}), pausedBySpace: false },
    });
    emit(task.id);
    logger.info(`空间已释放，恢复任务 #${task.id}`);
  }
}

async function startWaiting(): Promise<void> {
  const settings = getSettings();
  let running = tasksRepo.byStatus(['downloading', 'parsing']) as TaskWithPayload[];
  const moduleCount = (m: ModuleId): number => running.filter((t) => t.module === m).length;

  const waiting = tasksRepo.byStatus(['waiting']) as TaskWithPayload[];
  for (const task of waiting) {
    if (running.length >= settings.maxConcurrent) break;
    const limit = settings.moduleConcurrency[task.module] ?? 1;
    if (moduleCount(task.module) >= limit) continue;

    const adapter = adapters[task.module];
    if (!adapter) continue;

    // 需要下载空间：available = 当前可用 - 保留 - 其它运行任务的预留
    const reserved = running.reduce((sum, t) => sum + Math.max(0, t.expectBytes || 0), 0);
    const usable = freeBytes() - settings.reserveFreeBytes - reserved;
    const need = Math.max(0, task.expectBytes || 0);
    if (usable - need < 0) {
      logger.debug(`任务 #${task.id} 空间不足（需要 ${need} 字节，可用 ${usable}），继续等待`);
      continue;
    }

    try {
      if (adapter.prepare) {
        tasksRepo.update(task.id, { status: 'parsing', error: null });
        emit(task.id);
        await adapter.prepare(task);
      }
      const fresh = tasksRepo.get(task.id) as TaskWithPayload;
      const need2 = Math.max(0, fresh.expectBytes || 0);
      if (usable - need2 < 0) {
        tasksRepo.update(task.id, { status: 'waiting', error: '磁盘空间不足，等待中' });
        emit(task.id);
        continue;
      }
      await adapter.start(fresh);
      emit(task.id);
      running = tasksRepo.byStatus(['downloading', 'parsing']) as TaskWithPayload[];
    } catch (e) {
      failTask(task, (e as Error).message);
    }
  }
}

/** 服务重启后的任务恢复 */
export async function recoverTasks(): Promise<void> {
  const stuck = tasksRepo.byStatus(['downloading', 'parsing']) as TaskWithPayload[];
  for (const task of stuck) {
    // aria2 有 gid 且守护进程仍在跑 -> 继续跟踪；其它情况回等待队列
    if (task.module === 'aria2' && (task.payload ?? {}).gid) {
      logger.info(`恢复 aria2 任务 #${task.id}（继续跟踪 gid=${(task.payload ?? {}).gid}）`);
      continue;
    }
    tasksRepo.update(task.id, { status: 'waiting', speedBps: 0, error: '服务重启，任务已重新排队' });
    emit(task.id);
  }
  // 卡在归档/加密中间态的任务交给流水线继续处理
  const pipelineTasks = tasksRepo.byStatus(['archiving', 'encrypting']);
  if (pipelineTasks.length) logger.info(`${pipelineTasks.length} 个任务在流水线中间态，已交给流水线继续`);
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await transmissionModule.produce?.();
    await pollRunning();
    const settings = getSettings();
    const runningAfter = tasksRepo.byStatus(['downloading', 'parsing']) as TaskWithPayload[];
    const reserved = runningAfter.reduce((sum, t) => sum + Math.max(0, t.expectBytes || 0), 0);
    const usable = freeBytes() - settings.reserveFreeBytes - reserved;
    await applySpacePressure(usable);
    await resumeSpacePaused(freeBytes() - settings.reserveFreeBytes);
    await startWaiting();
  } catch (e) {
    logger.error(`调度器异常: ${(e as Error).message}`);
  } finally {
    ticking = false;
  }
}

export function startScheduler(): void {
  if (timer) return;
  // 空间腾挪广播：只要收到通知（无论释放多少），立刻重新评估等待队列
  bus.on('space-freed', (payload: { bytes?: number; reason?: string }) => {
    logger.info(`收到空间腾挪通知（${payload?.reason ?? 'unknown'}，释放 ${(Number(payload?.bytes ?? 0) / 1024 / 1024).toFixed(1)}MB），立即重新评估等待队列`);
    kickScheduler();
  });
  timer = setInterval(() => {
    void tick();
  }, config.schedulerIntervalMs);
  logger.info(`统一下载调度器已启动（每 ${Math.round(config.schedulerIntervalMs / 1000)} 秒一轮，全局并发 ${getSettings().maxConcurrent}，保留空间 ${(getSettings().reserveFreeBytes / 1024 ** 3).toFixed(1)}G）`);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 手动触发一次调度（接口用） */
export function kickScheduler(): void {
  void tick();
}

/** 供测试使用：同步等待一轮调度完成 */
export async function schedulerTick(): Promise<void> {
  await tick();
}

export async function pauseTask(taskId: number): Promise<void> {
  const task = tasksRepo.get(taskId) as TaskWithPayload | null;
  if (!task) throw new Error('任务不存在');
  if (task.status === 'waiting') {
    tasksRepo.update(taskId, { status: 'paused', error: null });
  } else if (task.status === 'downloading' || task.status === 'parsing') {
    await adapters[task.module]?.pause(task);
    tasksRepo.update(taskId, { status: 'paused', speedBps: 0, error: null });
  } else {
    throw new Error(`当前状态（${task.status}）不可暂停`);
  }
  emit(taskId);
}

export async function resumeTask(taskId: number): Promise<void> {
  const task = tasksRepo.get(taskId) as TaskWithPayload | null;
  if (!task) throw new Error('任务不存在');
  if (!['paused', 'failed', 'cancelled'].includes(task.status)) throw new Error(`当前状态（${task.status}）不可继续`);
  const needsStart = task.status !== 'paused' || !(task.payload ?? {}).torrentId;
  if (needsStart && ['failed', 'cancelled'].includes(task.status)) {
    tasksRepo.update(taskId, { status: 'waiting', error: null, progress: 0, speedBps: 0 });
  } else {
    await adapters[task.module]?.resume(task);
    tasksRepo.update(taskId, { status: 'downloading', error: null, payload: { ...(task.payload ?? {}), pausedBySpace: false } });
  }
  emit(taskId);
  kickScheduler();
}

export async function cancelTask(taskId: number): Promise<void> {
  const task = tasksRepo.get(taskId) as TaskWithPayload | null;
  if (!task) throw new Error('任务不存在');
  try {
    await adapters[task.module]?.cancel(task);
  } catch {
    /* ignore */
  }
  tasksRepo.update(taskId, { status: 'cancelled', speedBps: 0, finishedAt: new Date().toISOString() });
  emit(taskId);
}

export function retryTask(taskId: number): void {
  const task = tasksRepo.get(taskId);
  if (!task) throw new Error('任务不存在');
  tasksRepo.update(taskId, { status: 'waiting', error: null, progress: 0, speedBps: 0, downloadedBytes: 0, finishedAt: null });
  emit(taskId);
  kickScheduler();
}

export function deleteTask(taskId: number): void {
  tasksRepo.delete(taskId);
  bus.emit('task', { id: taskId, deleted: true });
}

export const STATUS = {
  RUNNING: ['downloading', 'parsing'] as TaskStatus[],
  ALL: ['waiting', 'parsing', 'downloading', 'paused', 'archiving', 'encrypting', 'completed', 'failed', 'cancelled'] as TaskStatus[],
};
