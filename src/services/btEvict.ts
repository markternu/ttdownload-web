/**
 * BT 种子超时策略（用户指定，取代以前那套"停滞/极慢/挽救"的复杂判断）
 *
 * 规则很简单：
 *   · 种子交给 transmission 之后，**8 小时内不做任何干涉**（只读进度）
 *     —— 有的资源这会儿没速度，过一小时才上线；乱干涉只会把能下完的搞坏。
 *   · 满 8 小时时看进度：
 *       进度 ≤ 60%  → 直接清理：删 transmission 任务 + 连下载残留一起删
 *       进度 >  60% → 再给 4 小时宽限（也就是最晚 12 小时）
 *   · 宽限到点还没下完 → 同样清理。
 *   · 已经 100% 的不在这里处理 —— 那是"扫货"(btHarvest) 的事。
 *
 * 三个数字都可以在设置页改（btPolicy）。
 */

import fs from 'node:fs';
import { logger, taskLog } from '../core/logger';
import { tasksRepo } from '../core/db';
import { bus } from '../core/events';
import { getSettings } from './settings';
import { cleanupBtTaskDirs } from './btCleanup';
import { hideText } from './btAnon';
import { transmissionClient } from '../modules/transmission';
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
  const checkAfterMs = Math.max(1, numOr(policy.checkAfterHours, 8)) * 3600 * 1000;
  const graceMs = Math.max(1, numOr(policy.graceHours, 4)) * 3600 * 1000;
  const minPercent = Math.max(0, Math.min(100, numOr(policy.minProgressPercent, 60)));

  const summary: EvictSummary = {
    checked: 0, evicted: 0, salvaged: 0, kept: 0, freedBytes: 0, candidates: [],
    scanned: 0, dropped: 0, inGrace: 0, items: [],
  };
  const torrents = await listTorrents();
  const tasks = tasksRepo.byStatus(['waiting', 'parsing', 'downloading', 'paused']) as TaskWithPayload[];

  for (const task of tasks) {
    if (task.module !== 'transmission') continue;
    const payload = (task.payload ?? {}) as Record<string, unknown>;
    const torrentId = Number(payload.torrentId ?? 0);
    if (!torrentId) continue;
    // 只有"真正交给 transmission 开下过"的才算时间（prepare 了但还在排队的没开始）
    const handedAt = payload.btHandedAt ? Date.parse(String(payload.btHandedAt)) : 0;
    if (!handedAt || Number.isNaN(handedAt)) continue;

    summary.scanned += 1;
    const t = torrents.get(torrentId);
    const name = t?.name || String(payload.torrentName ?? task.title ?? `task_${task.id}`);
    const progress = t ? Math.min(100, (t.percentDone ?? 0) * 100) : Number(payload.btLastProgress ?? 0);
    const ageHours = (Date.now() - handedAt) / 3600 / 1000;

    // 已经下完的不归这里管（扫货会拿走）
    if (progress >= 99.9) {
      summary.kept += 1;
      continue;
    }
    // 还没到 8 小时：什么都不做，只记进度
    if (Date.now() - handedAt < checkAfterMs) {
      tasksRepo.update(task.id, { payload: { ...payload, btLastProgress: progress, btLastCheckAt: new Date().toISOString() } });
      summary.kept += 1;
      continue;
    }

    const graceEnded = Date.now() - handedAt >= checkAfterMs + graceMs;
    let action = '';
    let reason = '';
    if (progress <= minPercent) {
      action = 'drop';
      reason = `已交给 transmission ${ageHours.toFixed(1)} 小时，进度只有 ${progress.toFixed(1)}%（≤ ${minPercent}%）`;
    } else if (graceEnded) {
      action = 'drop';
      reason = `已交给 transmission ${ageHours.toFixed(1)} 小时（含 ${(graceMs / 3600e3).toFixed(0)} 小时宽限），仍未下完，进度 ${progress.toFixed(1)}%`;
    } else {
      action = 'grace';
      reason = `进度 ${progress.toFixed(1)}% > ${minPercent}%，进入宽限期（还剩 ${(((checkAfterMs + graceMs) - (Date.now() - handedAt)) / 3600e3).toFixed(1)} 小时）`;
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
      tasksRepo.update(task.id, { payload: { ...payload, btLastProgress: progress, btLastCheckAt: new Date().toISOString() } });
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
      payload: { ...payload, timedOutAt: new Date().toISOString(), timedOutReason: reason },
    });
    taskLog(task.id).mark('BT_TIMEOUT_DROP', `已清理：${hideText(reason)}`, { freedBytes: freed });
    logger.child('bt-evict').warn(`任务 #${task.id} 超时清理完成（释放 ${(freed / 1024 ** 2).toFixed(1)}MB）`);
  }

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
