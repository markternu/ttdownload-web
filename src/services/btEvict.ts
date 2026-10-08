/**
 * BT 种子超时策略（用户指定，取代以前那套"停滞/极慢/挽救"的复杂判断）
 *
 * 规则很简单：
 *   · 种子交给 transmission 之后，**12 小时内不做任何干涉**（只读进度）
 *     —— 有的资源这会儿没速度，过一小时才上线；乱干涉只会把能下完的搞坏。
 *   · 满 12 小时时看进度：
 *       进度 ≤ 60%  → 直接清理：删 transmission 任务 + 连下载残留一起删
 *       进度 >  60% → 再给 6 小时宽限（也就是最晚 18 小时）
 *   · 宽限到点还没下完 → 同样清理。
 *   · 已经 100% 的不在这里处理 —— 那是"扫货"(btHarvest) 的事。
 *
 * 三个数字都可以在设置页改（btPolicy）。
 *
 * ===================== 计时口径（2026-10 事故修复，别改回去） =====================
 * 「已下载时长」= `payload.btActiveMs`：**本服务真正在运行、并且这个种子在下载**的累计毫秒数。
 *
 * 以前是 `Date.now() - Date.parse(btHandedAt)`（墙上时钟差值），于是：
 *   ① 断电/关机那几天也被算成"在下载"—— 树莓派停了几天，任务就凭空多出 140+ 小时，
 *      页面显示"已下载 140 小时"（用户报的 bug），随后被本策略当超时任务清掉；
 *   ② 树莓派没有 RTC，重启后要等 NTP 校时，期间 Date.now() 可能差几天，一校准就跳变。
 * 现在改成：
 *   · 每次巡检用**单调时钟**（core/clock.ts 的 monoMs）取增量累加 —— 系统改时间 / NTP
 *     校时都影响不了它；
 *   · 进程重启后内存里的单调锚点丢失 → 那段停机时间**不补**（服务没跑 = 没在下载）；
 *   · 老任务（升级上来只有 btHandedAt、没有 btActiveMs）按 migrateLegacyActiveMs 换算一次。
 * ==============================================================================
 */

import fs from 'node:fs';
import { logger, taskLog } from '../core/logger';
import { tasksRepo } from '../core/db';
import { bus } from '../core/events';
import { getSettings } from './settings';
import { config } from '../core/config';
import { cleanupBtTaskDirs } from './btCleanup';
import { hideText } from './btAnon';
import { transmissionClient } from '../modules/transmission';
import { hours, monoMs, nowIso, nowMs } from '../core/clock';
import type { Task } from '../types';

type TaskWithPayload = Task & { payload?: Record<string, unknown> };

/**
 * 返回结构**同时**保留新旧两套字段名：
 * 前端 BT 页的"出清"面板用的是老字段（checked/evicted/salvaged/candidates），
 * 换名字会让页面在运行时读 undefined 崩掉。新字段给日志和测试用。
 */
export interface EvictCandidate {
  taskId: number;
  torrentId: number | null;
  title: string;
  ageHours: number;
  percent: number;
  rateBps: number;
  etaSec: number;
  peers: number;
  decision: 'evict' | 'keep';
  reason: string;
  detail: string;
}

export interface EvictSummary {
  // —— 老字段（前端在用，别删）——
  checked: number;
  evicted: number;
  salvaged: number;
  kept: number;
  freedBytes: number;
  candidates: EvictCandidate[];
  // —— 新字段 ——
  scanned: number;
  dropped: number;
  inGrace: number;
  items: { id: number; name: string; progress: number; ageHours: number; action: string; reason: string }[];
}

interface TorrentLite {
  id: number;
  name: string;
  hashString: string;
  percentDone: number;
}

/* ------------------------------------------------------------------ *
 *  计时：单调时钟累计（抗断电 / 抗时钟跳变）
 * ------------------------------------------------------------------ */

/**
 * 每个任务"上次巡检时的单调时钟读数"（毫秒）。
 * ⚠️ 只存在内存里：进程重启后这张表是空的，于是**停机那段时长不会被补进来** ——
 *    这正是我们要的（服务没在跑，就没在下载；也避开了树莓派没 RTC 导致的时钟跳变）。
 */
const monoAnchor = new Map<number, number>();

/**
 * 把"从上次巡检到现在的真实运行时长"加到任务上。
 * @returns 本次新增的毫秒数（第一次见到这个任务时为 0）
 */
export function advanceActiveMs(taskId: number, monoNowMs: number = monoMs()): number {
  const last = monoAnchor.get(taskId);
  monoAnchor.set(taskId, monoNowMs);
  if (last === undefined) return 0; // 进程刚起来（或刚接手这个任务）→ 不补历史时间
  // 单调时钟理论上不会倒退；真倒退了（换了时钟源/被 mock 了）也只当 0，绝不让时长缩水
  return Math.max(0, monoNowMs - last);
}

/**
 * 老任务迁移：升级上来只有 `btHandedAt`（墙上时钟），没有 `btActiveMs`。
 *
 * 判断规则（保守优先，宁可晚清理也不误删）：
 *   · 墙上差值 ≤ 策略窗口（12+6 小时）→ 这段不可能藏"断电几天"，可信，照抄；
 *   · 墙上差值 > 窗口 → 这个数已经**不可信**了（可能就是断电那几天 / NTP 校时跳变），
 *     旧代码正好会拿它去"超时清理"。此时**把计时起点重置到当前这一刻**，
 *     给任务一个完整的新窗口，并在日志里打点说明。旧任务只迁移这一次
 *     （迁移后 payload 里就有 btActiveMs 了）。
 */
export function migrateLegacyActiveMs(wallAgeMs: number, windowMs: number): { activeMs: number; reset: boolean } {
  if (!Number.isFinite(wallAgeMs) || wallAgeMs <= 0) return { activeMs: 0, reset: false };
  if (wallAgeMs <= windowMs) return { activeMs: wallAgeMs, reset: false };
  return { activeMs: 0, reset: true };
}

/** 读出任务的"实际下载尝试时长"（毫秒）。老数据在这里做一次性迁移。 */
export function activeMsOf(task: TaskWithPayload, windowMs: number, wallNowMs: number = nowMs()): { activeMs: number; reset: boolean; legacy: boolean } {
  const payload = (task.payload ?? {}) as Record<string, unknown>;
  const stored = Number(payload.btActiveMs);
  if (payload.btActiveMs !== undefined && payload.btActiveMs !== null && Number.isFinite(stored) && stored >= 0) {
    return { activeMs: stored, reset: false, legacy: false };
  }
  const handedAt = payload.btHandedAt ? Date.parse(String(payload.btHandedAt)) : 0;
  if (!handedAt || Number.isNaN(handedAt)) return { activeMs: 0, reset: false, legacy: false };
  const migrated = migrateLegacyActiveMs(wallNowMs - handedAt, windowMs);
  return { ...migrated, legacy: true };
}

async function listTorrents(): Promise<Map<number, TorrentLite>> {
  const out = new Map<number, TorrentLite>();
  try {
    const client = transmissionClient();
    if (!(await client.ping())) return out;
    const info = await client.call<{ torrents: Record<string, unknown>[] }>('torrent-get', {
      fields: ['id', 'name', 'hashString', 'percentDone'],
    });
    for (const t of info.torrents ?? []) {
      const id = Number(t.id ?? 0);
      out.set(id, {
        id,
        name: String(t.name ?? ''),
        hashString: String(t.hashString ?? ''),
        percentDone: Number(t.percentDone ?? 0),
      });
    }
  } catch (e) {
    logger.child('bt-evict').warn(`读取 transmission 清单失败：${(e as Error).message}`);
  }
  return out;
}

/** 真正清理：删 transmission 任务（连数据） + 删本任务的残留目录 */
async function dropTorrent(task: TaskWithPayload, name: string, reason: string): Promise<number> {
  const payload = (task.payload ?? {}) as Record<string, unknown>;
  const torrentId = Number(payload.torrentId ?? 0);
  if (torrentId) {
    try {
      const client = transmissionClient();
      if (await client.ping()) {
        await client.call('torrent-remove', { ids: [torrentId], 'delete-local-data': true }).catch(() => undefined);
      }
    } catch {
      /* 删不掉也继续清目录 */
    }
  }
  const freed = cleanupBtTaskDirs(task as Task, name, 'bt-timeout');
  // ⚠️ detail 会被调度器的 SPACE_FREED 日志整个打出来 → 不能带种子名
  if (freed > 0) bus.emitSpaceFreed({ bytes: freed, reason: 'bt-timeout', detail: { taskId: task.id, reason: hideText(reason) } });
  return freed;
}

export async function runBtEvict({ dryRun = false } = {}): Promise<EvictSummary> {
  const policy = getSettings().btPolicy;
  // ⚠️ 别用 `Number(x) || 默认值`：那样 minProgressPercent=0（"到点就清，不看进度"）会被
  //    悄悄换成 60，用户在设置页填 0 却怎么都不生效。
  const numOr = (v: unknown, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const checkAfterMs = Math.max(1, numOr(policy.checkAfterHours, config.btPolicy.checkAfterHours)) * 3600 * 1000;
  const graceMs = Math.max(1, numOr(policy.graceHours, config.btPolicy.graceHours)) * 3600 * 1000;
  const minPercent = Math.max(0, Math.min(100, numOr(policy.minProgressPercent, config.btPolicy.minProgressPercent)));

  const summary: EvictSummary = {
    checked: 0, evicted: 0, salvaged: 0, kept: 0, freedBytes: 0, candidates: [],
    scanned: 0, dropped: 0, inGrace: 0, items: [],
  };
  const torrents = await listTorrents();
  const tasks = tasksRepo.byStatus(['waiting', 'parsing', 'downloading', 'paused']) as TaskWithPayload[];
  const windowMs = checkAfterMs + graceMs;
  const monoNow = monoMs();
  const wallNow = nowMs();
  const seen = new Set<number>();

  for (const task of tasks) {
    if (task.module !== 'transmission') continue;
    const payload = (task.payload ?? {}) as Record<string, unknown>;
    const torrentId = Number(payload.torrentId ?? 0);
    if (!torrentId) continue;
    // 只有"真正交给 transmission 开下过"的才算时间（prepare 了但还在排队的没开始）
    const handedAt = payload.btHandedAt ? Date.parse(String(payload.btHandedAt)) : 0;
    if (!handedAt || Number.isNaN(handedAt)) continue;

    summary.scanned += 1;
    seen.add(task.id);
    const t = torrents.get(torrentId);
    const name = t?.name || String(payload.torrentName ?? task.title ?? `task_${task.id}`);
    const progress = t ? Math.min(100, (t.percentDone ?? 0) * 100) : Number(payload.btLastProgress ?? 0);

    // —— 计时：单调时钟累计"服务真正在跑"的时长（断电/关机不计）——
    const { activeMs: storedMs, reset: legacyReset, legacy } = activeMsOf(task, windowMs, wallNow);
    const grownMs = advanceActiveMs(task.id, monoNow);
    let activeMs = storedMs + grownMs;
    if (legacyReset) {
      // 旧数据里那个数已经不可信（很可能就是断电几天 + 时钟跳变），重置计时起点
      logger.child('bt-evict').mark(
        'BT_TIMEOUT_MIGRATE',
        `任务 #${task.id} 的旧版计时不可信（按墙上时钟算出来是 ${hours(wallNow - handedAt).toFixed(1)} 小时，含断电停机/时钟跳变），已重置计时起点，重新给 ${(windowMs / 3600e3).toFixed(0)} 小时窗口`,
        { taskId: task.id, wallHours: Number(hours(wallNow - handedAt).toFixed(2)), newActiveHours: Number(hours(grownMs).toFixed(3)) });
      activeMs = grownMs;
    }
    const ageHours = hours(activeMs);
    const persist = (extra: Record<string, unknown>): void => {
      tasksRepo.update(task.id, {
        payload: {
          ...payload,
          btActiveMs: activeMs,
          btActiveCheckedAt: nowIso(),
          btLastProgress: progress,
          ...extra,
        },
      });
    };

    // 已经下完的不归这里管（扫货会拿走）
    if (progress >= 99.9) {
      persist({});
      summary.kept += 1;
      continue;
    }
    // 还没到 12 小时：什么都不做，只记进度
    if (activeMs < checkAfterMs) {
      persist({});
      summary.kept += 1;
      continue;
    }

    const graceEnded = activeMs >= windowMs;
    let action = '';
    let reason = '';
    const clockNote = legacy ? '（实际下载尝试时长，通电运行期间累计）' : '';
    if (progress <= minPercent) {
      action = 'drop';
      reason = `已交给 transmission ${ageHours.toFixed(1)} 小时，进度只有 ${progress.toFixed(1)}%（≤ ${minPercent}%）${clockNote}`;
    } else if (graceEnded) {
      action = 'drop';
      reason = `已交给 transmission ${ageHours.toFixed(1)} 小时（含 ${(graceMs / 3600e3).toFixed(0)} 小时宽限），仍未下完，进度 ${progress.toFixed(1)}%${clockNote}`;
    } else {
      action = 'grace';
      reason = `进度 ${progress.toFixed(1)}% > ${minPercent}%，进入宽限期（还剩 ${((windowMs - activeMs) / 3600e3).toFixed(1)} 小时）${clockNote}`;
      summary.inGrace += 1;
    }

    summary.items.push({ id: task.id, name, progress, ageHours, action, reason });
    summary.checked += 1;
    summary.candidates.push({
      taskId: Number(task.id),
      torrentId: torrentId || null,
      title: name,
      ageHours: Number(ageHours.toFixed(2)),
      percent: Number(progress.toFixed(1)),
      rateBps: 0,
      etaSec: 0,
      peers: 0,
      decision: action === 'drop' ? 'evict' : 'keep',
      reason: action === 'drop' ? '超时清理' : (action === 'grace' ? '宽限中' : '继续观察'),
      detail: reason,
    });
    logger.child('bt-evict').mark(action === 'drop' ? 'BT_TIMEOUT_DROP' : 'BT_TIMEOUT_GRACE',
      `任务 #${task.id}：${reason}`, { progress, ageHours, action });

    if (action !== 'drop') {
      persist({});
      continue;
    }

    summary.dropped += 1;
    summary.evicted += 1;
    if (dryRun) continue;

    const freed = await dropTorrent(task, name, reason);
    summary.freedBytes += freed;
    tasksRepo.update(task.id, {
      status: 'failed',
      speedBps: 0,
      error: `超时清理：${reason}${freed > 0 ? `（已释放 ${(freed / 1024 ** 2).toFixed(1)}MB）` : ''}`,
      payload: {
        ...payload,
        btActiveMs: activeMs,
        btActiveCheckedAt: nowIso(),
        timedOutAt: nowIso(),
        timedOutReason: reason,
        timedOutAgeHours: Number(ageHours.toFixed(2)),
      },
    });
    taskLog(task.id).mark('BT_TIMEOUT_DROP', `已清理：${hideText(reason)}`, { freedBytes: freed });
    logger.child('bt-evict').warn(`任务 #${task.id} 超时清理完成（释放 ${(freed / 1024 ** 2).toFixed(1)}MB）`);
  }

  // 已经不在这批任务里的（清完/删掉/归档走）→ 丢掉锚点，别让 Map 无限长
  for (const id of [...monoAnchor.keys()]) if (!seen.has(id)) monoAnchor.delete(id);

  return summary;
}

let timer: NodeJS.Timeout | null = null;

export function startBtEvictWorker(): void {
  if (timer) return;
  const everyMs = Math.max(60_000, Number(process.env.BT_EVICT_INTERVAL_MS ?? 10 * 60_000));
  timer = setInterval(() => {
    runBtEvict().catch((e) => logger.child('bt-evict').error(`[MARK:ERROR] BT 超时检查异常: ${(e as Error).message}`));
  }, everyMs);
  const p = getSettings().btPolicy;
  logger.mark('BOOT', `BT 超时策略已启动（每 ${Math.round(everyMs / 60000)} 分钟检查一次：${p.checkAfterHours} 小时后进度 ≤ ${p.minProgressPercent}% 就清理，> ${p.minProgressPercent}% 再宽限 ${p.graceHours} 小时）`);
}

export function stopBtEvictWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 给设置页"预览"用：只报告不动作 */
export async function previewBtEvict(): Promise<EvictSummary> {
  return runBtEvict({ dryRun: true });
}

/** 兼容旧引用 */
export const BT_EVICT_INTERVAL_MS = 10 * 60_000;
export const _unusedFs = fs;
