import { config } from './config';
import { bus } from './events';
import { logger, taskLog } from './logger';
import { tasksRepo } from './db';
import { freeBytes } from './disk';
import { remainingBytesOf, reservedByRunningTasks } from './space';
import { effectiveReserve } from '../services/usbMount';
import { getSettings } from '../services/settings';
import { conflict, notFound } from '../utils/http';
import { handoffToArchive } from '../services/pipeline';
import { HIDDEN_NAME, hideText } from '../services/btAnon';
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
  // ⚠️ 不要把「RPC 不通/凭据不对」算成永久错误：用户改对密码或把 transmission 起起来之后
  //    重试就能成功（血案：以前 `不可用：请` 命中这里 → 任务直接 failed、不自动重试，
  //    用户改好了凭据也只能手动点「继续」）。
  return /URL 格式错误|不支持该链|没有视频或图片|DRM|种子文件不存在|未安装|找不到文件/.test(msg);
}

function failTask(task: TaskWithPayload, message: string): void {
  const settings = getSettings();
  const retryCount = Number(task.retryCount ?? 0);
  // BT：错误信息可能来自文件系统/子进程，里面会带种子名或内容文件名 → 进日志前先脱敏
  // （任务表里的 error 字段照旧保留原文，界面要能看到真正的原因）
  const logMessage = task.module === 'transmission' ? hideText(message) : message;
  if (!isPermanentError(message) && retryCount < settings.autoRetry) {
    tasksRepo.update(task.id, {
      status: 'waiting',
      retryCount: retryCount + 1,
      error: `${message}（第 ${retryCount + 1} 次重试）`,
      speedBps: 0,
    });
    taskLog(task.id).mark('TASK_RETRY', `失败，将自动重试(${retryCount + 1}/${settings.autoRetry})：${logMessage}`);
    logger.child('scheduler').mark('TASK_FAIL', `任务 #${task.id} 失败（可重试）`, {
      module: task.module,
      retryCount: retryCount + 1,
      autoRetry: settings.autoRetry,
      message: logMessage,
    });
  } else {
    tasksRepo.update(task.id, { status: 'failed', error: message, speedBps: 0, finishedAt: new Date().toISOString() });
    logger.child('scheduler').error(`[MARK:TASK_FAIL] 任务 #${task.id} 最终失败（永久错误或重试已用尽）`, {
      module: task.module,
      retryCount,
      autoRetry: settings.autoRetry,
      permanent: isPermanentError(message),
      message: logMessage,
      url: task.url,
      // BT 的内容名不进日志（用户要求）；其它模块保留标题便于排查
      title: task.module === 'transmission' ? HIDDEN_NAME : task.title,
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
      const detail = (e as Error).stack ?? (e as Error).message;
      taskLog(task.id).error(`[MARK:ERROR] 轮询任务异常: ${task.module === 'transmission' ? hideText(detail) : detail}`);
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
async function applySpacePressure(): Promise<void> {
  // 用户规则：**只有「可用于下载 = 系统实际可用 − 预留 ≤ 0」**（df 只剩预留的 10G）才允许暂停。
  // 绝不因为"运行中任务还差多少"去暂停 —— 那会让 df 明明有空闲却显示"空间不足，已自动暂停"。
  const usable = freeBytes() - effectiveReserve();
  if (usable > 0) return;
  const running = tasksRepo.byStatus(['downloading', 'parsing']) as TaskWithPayload[];
  // 已 100%（下完了只等扫货）的不暂停：暂停它只会让 transmission 里永远"暂停"，毫无意义。
  // 新的先暂停（越晚加入的越先让），但保留最老的一个继续跑，保证有任务能下完、空间能回血。
  const ordered = [...running]
    .filter((t) => remainingBytesOf(t) > 0)
    .sort((a, b) => Number(b.id) - Number(a.id));
  let left = ordered.length;
  for (const task of ordered) {
    if (left <= 1) {
      logger.child('scheduler').warn(
        `空间压力：可用于下载已 ≤ 0，暂停到只剩任务 #${task.id}（保留一个在跑，否则没人能下完、空间永远回不来）`);
      break;
    }
    const adapter = adapters[task.module];
    try {
      await adapter.pause(task);
    } catch {
      /* ignore */
    }
    left -= 1;
    tasksRepo.update(task.id, {
      status: 'paused',
      speedBps: 0,
      error: '磁盘空间不足，已自动暂停（等正在跑的任务下完腾出空间后会自动恢复）',
      payload: { ...(task.payload ?? {}), pausedBySpace: true },
    });
    emit(task.id);
    logger.warn(`任务 #${task.id} 因可用于下载为 0 被自动暂停`);
  }
}

/** 空间恢复后，恢复被自动暂停的任务 */
async function resumeSpacePaused(): Promise<void> {
  const paused = tasksRepo.byStatus(['paused']) as TaskWithPayload[];
  // 用户规则：只有「可用于下载 = 系统实际可用 − 预留 > 0」才恢复；不扣运行中任务。
  const usable = freeBytes() - effectiveReserve();
  if (usable <= 0) return;
  let spendable = usable;
  const nothingRunning = tasksRepo.byStatus(['downloading', 'parsing']).length === 0;
  for (const task of paused) {
    if (!(task.payload ?? {}).pausedBySpace) continue;
    const need = remainingBytesOf(task);
    // 防死锁：一个都没在跑时必须放行最老的（否则永远没人下完、空间永远回不来）
    if (spendable - need < 0 && !nothingRunning) continue;
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
    // ⚠️ 放行一个就要把这一个的预留扣掉：以前整个循环用同一个 usable，
    //    4 个各需"几乎全部可用空间"的任务会被一次性全部放行（合计 4 倍），
    //    下一轮又因空间压力把它们暂停 → 来回抖动，而且真的会撑爆磁盘。
    spendable -= need;
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
  // 用户规则（严格 FIFO + 预留）：
  //   可用于下载 = 系统实际可用 − 预留 − **已在跑的任务还差多少**（它们承诺的空间要占着）；
  //   队首任务装得下就放行并继续扣掉它要占的空间；装不下就停在这里（后面不许插队）。
  let usable = freeBytes() - effectiveReserve() - reservedByRunningTasks();
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

    // 用户规则（严格先进先出 + 预留）：
    //   队首任务装得下就放行并**把它的空间预留掉**；装不下就**停在这里**
    //   （后面的一起等，不许让后面的小任务插队）。
    const need = remainingBytesOf(task);
    if (usable - need < 0) {
      const gb = (n: number) => (n / 1024 ** 3).toFixed(2);
      const msg = `可用于下载空间不足，无法支撑下一个队列任务（可用 ${gb(Math.max(0, usable))}G < 需要 ${gb(need)}G），其后任务一并等待`;
      if (task.error !== msg) {
        tasksRepo.update(task.id, { error: msg });
        emit(task.id);
      }
      logger.child('scheduler').mark('DISK_GATE', msg, {
        needBytes: need,
        usableBytes: usable,
        freeBytes: freeBytes(),
        reserveBytes: effectiveReserve(),
        fifoBlocked: true,
      });
      skippedBySpace.push({ taskId: task.id, needBytes: need, usableBytes: usable });
      break; // 严格 FIFO：不跳过
    }

    try {
      if (adapter.prepare) {
        tasksRepo.update(task.id, { status: 'parsing', error: null });
        emit(task.id);
        await adapter.prepare(task);
      }
      const fresh = tasksRepo.get(task.id) as TaskWithPayload;
      const need2 = remainingBytesOf(fresh);
      // 预读的大小和真实大小可能不一致（尤其 BT 只挑视频）：以大的为准再校验一次。
      if (need2 > need && usable - need2 < 0) {
        const gb = (n: number) => (n / 1024 ** 3).toFixed(2);
        const msg = `可用于下载空间不足，无法支撑下一个队列任务（可用 ${gb(Math.max(0, usable))}G < 实际需要 ${gb(need2)}G），其后任务一并等待`;
        tasksRepo.update(task.id, { status: 'waiting', error: msg });
        emit(task.id);
        break;
      }
      tasksRepo.update(task.id, { error: null });
      await adapter.start(fresh);
      // 预留：这个任务要占的空间，从本轮可用额度里扣掉（下个任务只能看到剩下的）
      usable -= Math.max(need, need2);
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
        usableBytes: freeBytes() - effectiveReserve(),
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
    const reserved = reservedByRunningTasks(); // 仅用于日志展示，不再参与准入/暂停判定
    await applySpacePressure();
    await resumeSpacePaused();
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
          reserveBytes: effectiveReserve(),
          usableBytes: free - effectiveReserve() - reserved,
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
  logger.mark('BOOT', `统一下载调度器已启动（每 ${Math.round(config.schedulerIntervalMs / 1000)} 秒一轮，全局并发 ${getSettings().maxConcurrent}，保留空间 ${(effectiveReserve() / 1024 ** 3).toFixed(1)}G）`);
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
