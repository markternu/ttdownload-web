import { config } from './config';
import { bus } from './events';
import { logger, taskLog } from './logger';
import { tasksRepo } from './db';
import { freeBytes } from './disk';
import { getSettings } from '../services/settings';
import { conflict, notFound } from '../utils/http';
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
    taskLog(task.id).mark('TASK_RETRY', `失败，将自动重试(${retryCount + 1}/${settings.autoRetry})：${message}`);
    logger.child('scheduler').mark('TASK_FAIL', `任务 #${task.id} 失败（可重试）`, {
      module: task.module,
      retryCount: retryCount + 1,
      autoRetry: settings.autoRetry,
      message,
    });
  } else {
    tasksRepo.update(task.id, { status: 'failed', error: message, speedBps: 0, finishedAt: new Date().toISOString() });
    logger.child('scheduler').error(`[MARK:TASK_FAIL] 任务 #${task.id} 最终失败（永久错误或重试已用尽）`, {
      module: task.module,
      retryCount,
      autoRetry: settings.autoRetry,
      permanent: isPermanentError(message),
      message,
      url: task.url,
      // BT 的内容名不进日志（用户要求）；其它模块保留标题便于排查
      title: task.module === 'transmission' ? '（已隐藏）' : task.title,
    });
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
        // BT 会带上发布单元（大视频各自一个成品）和"发布后清理下载目录"的标记
        handoffToArchive(task.id, r.done.files, r.done.originalName, r.done.sizeBytes, {
          units: r.done.units,
          torrentName: r.done.torrentName,
          cleanupBtDirs: r.done.cleanupBtDirs,
        });
        continue;
      }
      if (r.error) {
        failTask(task, r.error);
        continue;
      }
      applyProgress(task.id, r);
    } catch (e) {
      taskLog(task.id).error(`[MARK:ERROR] 轮询任务异常: ${(e as Error).stack ?? (e as Error).message}`);
    }
  }
  return running.length;
}

/**
 * 空间压力：可用空间低于保留值时，暂停部分正在下载的任务。
 *
 * ⚠️ 这里必须**留至少一个任务在跑**（真事故）：
 *   以前是"usable < 0 就把所有在跑任务全暂停"，而暂停的任务永远下不完
 *   → 永远腾不出空间 → resume 又要求"空间够了才恢复" → **永久死锁**，
 *   表现就是"十来个任务全停住、磁盘满着、一个成品都没有"。
 *   现在从新到旧暂停（后加入的先让位），但绝不动最后一个在跑的任务，
 *   让它把当前这个下完 → 走完流水线 → 被安卓取走 → 服务端删除 → 空间回血。
 */
async function applySpacePressure(usable: number): Promise<void> {
  if (usable >= 0) return;
  const running = tasksRepo.byStatus(['downloading', 'parsing']) as TaskWithPayload[];
  // 新的先暂停（越晚加入的越先让），但保留最老的那个继续跑以保证一定能回血
  const ordered = [...running].sort((a, b) => Number(b.id) - Number(a.id));
  let remaining = running.length;
  for (const task of ordered) {
    if (remaining <= 1) {
      logger.child('scheduler').warn(
        `空间压力：已暂停到只剩任务 #${task.id}（保留一个在跑，否则没人能下完、空间永远回不来）`);
      break;
    }
    const adapter = adapters[task.module];
    try {
      await adapter.pause(task);
    } catch {
      /* ignore */
    }
    remaining -= 1;
    tasksRepo.update(task.id, {
      status: 'paused',
      speedBps: 0,
      error: '磁盘空间不足，已自动暂停（等正在跑的任务下完腾出空间后会自动恢复）',
      payload: { ...(task.payload ?? {}), pausedBySpace: true },
    });
    emit(task.id);
    logger.warn(`任务 #${task.id} 因磁盘空间不足被自动暂停（保留其它任务继续跑以腾空间）`);
  }
}

/** 空间恢复后，恢复被自动暂停的任务 */
async function resumeSpacePaused(freeMinusReserve: number): Promise<void> {
  const paused = tasksRepo.byStatus(['paused']) as TaskWithPayload[];
  // 与准入用同一口径：可用 = 系统可用 - 预留 - 运行中任务的预留
  const runningNow = tasksRepo.byStatus(['downloading', 'parsing']) as TaskWithPayload[];
  const reservedNow = runningNow.reduce((sum, t) => sum + Math.max(0, t.expectBytes || 0), 0);
  const usable = freeMinusReserve - reservedNow;
  const nothingRunning = runningNow.length === 0;
  for (const task of paused) {
    if (!(task.payload ?? {}).pausedBySpace) continue;
    const need = Math.max(0, task.expectBytes || 0);
    // 防死锁：一个都没在跑时必须放行最老的（否则永远没人下完、空间永远回不来）
    if (usable - need < 0 && !nothingRunning) continue;
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

const MODULE_CN: Record<ModuleId, string> = { transmission: 'BT', aria2: '直链', webvideo: '在线视频' };

// 模块并发门控的提示节流：数量变了或超过 60 秒才再说一次（这个 tick 每 3 秒一轮）
let gateNotice = { at: 0, sig: '' };

async function startWaiting(): Promise<void> {
  const settings = getSettings();
  let running = tasksRepo.byStatus(['downloading', 'parsing']) as TaskWithPayload[];
  const moduleCount = (m: ModuleId): number => running.filter((t) => t.module === m).length;

  const gated = new Map<ModuleId, { count: number; limit: number }>();
  const skippedBySpace: { taskId: number; needBytes: number; usableBytes: number }[] = [];
  const waiting = tasksRepo.byStatus(['waiting']) as TaskWithPayload[];
  for (const task of waiting) {
    // 0 = 不限：只让磁盘空间当"闸门"（用户要的就是这个：有空间就下）
    if (settings.maxConcurrent > 0 && running.length >= settings.maxConcurrent) break;
    const limit = settings.moduleConcurrency[task.module] ?? 0;
    if (limit > 0 && moduleCount(task.module) >= limit) {
      // ⚠️ 这里以前是静默 continue：用户传 10 多个种子只跑一个，界面上只有"等待"、
      //    日志里一个字都没有，根本没法自己排查。现在两处都写清楚：
      //    ① 任务上写原因（任务列表直接能看到） ② 日志打 MODULE_GATE（节流）
      const g = gated.get(task.module) ?? { count: 0, limit };
      g.count++;
      gated.set(task.module, g);
      const msg = `${MODULE_CN[task.module]} 并发已满（上限 ${limit} 个，可到「设置」里调大）`;
      if (task.error !== msg) {
        tasksRepo.update(task.id, { error: msg });
        emit(task.id);
      }
      continue;
    }

    const adapter = adapters[task.module];
    if (!adapter) continue;

    // 需要下载空间：available = 当前可用 - 保留 - 其它运行任务的预留
    const reserved = running.reduce((sum, t) => sum + Math.max(0, t.expectBytes || 0), 0);
    const usable = freeBytes() - settings.reserveFreeBytes - reserved;
    const need = Math.max(0, task.expectBytes || 0);
    if (usable - need < 0) {
      // 装不下的**跳过**，让后面装得下的先跑 —— 别让一个大家伙把可用空间白白空着。
      // 顺序仍然是先进先出（谁先来谁先拿到空间），只是遇到放不下的会先让位。
      logger.child('scheduler').mark('DISK_GATE',
        `任务 #${task.id} 需要 ${(need / 1024 ** 3).toFixed(2)}G，当前可用 ${(usable / 1024 ** 3).toFixed(2)}G —— 先跳过它，放行后面装得下的（不浪费空间）`, {
        needBytes: need,
        usableBytes: usable,
        freeBytes: freeBytes(),
        reserveBytes: settings.reserveFreeBytes,
        reservedRunningBytes: reserved,
        skipped: true,
      });
      skippedBySpace.push({ taskId: task.id, needBytes: need, usableBytes: usable });
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
      tasksRepo.update(task.id, { error: null });
      await adapter.start(fresh);
      logger.child('scheduler').mark('TASK_STATE', `任务 #${task.id} 已启动`, {
        module: task.module,
        url: task.url,
        expectBytes: fresh.expectBytes,
        usableBytes: usable,
      });
      emit(task.id);
      running = tasksRepo.byStatus(['downloading', 'parsing']) as TaskWithPayload[];
    } catch (e) {
      failTask(task, (e as Error).message);
    }
  }

  if (skippedBySpace.length) {
    logger.child('scheduler').mark('DISK_GATE',
      `本轮因空间不足跳过 ${skippedBySpace.length} 个任务，等回血后再来（顺序仍是先进先出）`, {
        skipped: skippedBySpace.slice(0, 10),
        usableBytes: freeBytes() - settings.reserveFreeBytes,
      });
  }

  if (gated.size) {
    const sig = [...gated.entries()].map(([m, g]) => `${m}:${g.count}`).join(',');
    const now = Date.now();
    if (sig !== gateNotice.sig || now - gateNotice.at > 60_000) {
      gateNotice = { at: now, sig };
      for (const [m, g] of gated) {
        logger.child('scheduler').mark('MODULE_GATE',
          `${MODULE_CN[m]} 并发已满：正在跑 ${g.limit} 个（模块上限），还有 ${g.count} 个在等待。` +
          `想同时跑更多请到「设置 → 模块并发」把 ${m} 调大（全局并发上限 ${settings.maxConcurrent}）`,
          { module: m, moduleLimit: g.limit, gated: g.count, maxConcurrent: settings.maxConcurrent });
      }
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
    logger.child('scheduler').warn(`[MARK:TASK_STATE] 服务重启后任务 #${task.id} 重新排队（原状态 ${task.status}）`);
    tasksRepo.update(task.id, { status: 'waiting', speedBps: 0, error: '服务重启，任务已重新排队' });
    emit(task.id);
  }
  // 卡在归档/加密中间态的任务交给流水线继续处理
  const pipelineTasks = tasksRepo.byStatus(['archiving', 'encrypting']);
  if (pipelineTasks.length) logger.info(`${pipelineTasks.length} 个任务在流水线中间态，已交给流水线继续`);
}

let lastTickSummary = '';

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
    if (logger.isDebug()) {
      const waiting = tasksRepo.byStatus(['waiting']).length;
      const running = tasksRepo.byStatus(['downloading', 'parsing']).length;
      const free = freeBytes();
      if (waiting > 0 || running > 0 || lastTickSummary !== `${waiting}/${running}`) {
        lastTickSummary = `${waiting}/${running}`;
        logger.child('scheduler').mark('SCHED_TICK', `等待 ${waiting} / 运行 ${running}`, {
          waiting,
          running,
          freeBytes: free,
          reserveBytes: settings.reserveFreeBytes,
          usableBytes: free - settings.reserveFreeBytes - reserved,
          moduleConcurrency: settings.moduleConcurrency,
          maxConcurrent: settings.maxConcurrent,
        });
      }
    }
  } catch (e) {
    logger.child('scheduler').error(`[MARK:ERROR] 调度器异常: ${(e as Error).stack ?? (e as Error).message}`);
  } finally {
    ticking = false;
  }
}

export function startScheduler(): void {
  if (timer) return;
  // 空间腾挪广播：只要收到通知（无论释放多少），立刻重新评估等待队列
  bus.on('space-freed', (payload: { bytes?: number; reason?: string }) => {
    logger.child('scheduler').mark('SPACE_FREED', `收到空间腾挪通知（${payload?.reason ?? 'unknown'}，释放 ${(Number(payload?.bytes ?? 0) / 1024 / 1024).toFixed(1)}MB），立即重新评估等待队列`, payload);
    kickScheduler();
  });
  timer = setInterval(() => {
    void tick();
  }, config.schedulerIntervalMs);
  logger.mark('BOOT', `统一下载调度器已启动（每 ${Math.round(config.schedulerIntervalMs / 1000)} 秒一轮，全局并发 ${getSettings().maxConcurrent}，保留空间 ${(getSettings().reserveFreeBytes / 1024 ** 3).toFixed(1)}G）`);
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
  logger.child('scheduler').mark('TASK_STATE', `暂停任务 #${taskId}`);
  const task = tasksRepo.get(taskId) as TaskWithPayload | null;
  if (!task) throw notFound('任务不存在');
  if (task.status === 'waiting') {
    tasksRepo.update(taskId, { status: 'paused', error: null });
  } else if (task.status === 'downloading' || task.status === 'parsing') {
    await adapters[task.module]?.pause(task);
    tasksRepo.update(taskId, { status: 'paused', speedBps: 0, error: null });
  } else {
    // 用 409 + 明确中文：以前是普通 Error → 页面只显示「服务器内部错误」，看不出为什么
    throw conflict(`当前状态「${task.status}」不能暂停（只有等待中/下载中/解析中可以暂停）`, 'TASK_NOT_PAUSABLE');
  }
  emit(taskId);
}

export async function resumeTask(taskId: number): Promise<void> {
  logger.child('scheduler').mark('TASK_STATE', `继续任务 #${taskId}`);
  const task = tasksRepo.get(taskId) as TaskWithPayload | null;
  if (!task) throw notFound('任务不存在');
  if (!['paused', 'failed', 'cancelled'].includes(task.status)) {
    throw conflict(`当前状态「${task.status}」不能继续（只有已暂停/失败/已取消的任务可以继续）`, 'TASK_NOT_RESUMABLE');
  }
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
  if (!task) throw notFound('任务不存在');
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
  if (!task) throw notFound('任务不存在');
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
