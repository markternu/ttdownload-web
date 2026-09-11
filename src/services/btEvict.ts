import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { bus } from '../core/events';
import { logger } from '../core/logger';
import { seedsRepo, tasksRepo } from '../core/db';
import { handoffToArchive } from './pipeline';
import { cleanupBtTaskDirs, removeDirs } from './btCleanup';
import { getSettings } from './settings';
import { transmissionClient } from '../modules/transmission';
import type { Task } from '../types';

/**
 * BT（transmission）出清机制
 * ------------------------------------------------------------------
 * 目的：识别"永远下不完"的 BT 任务并清理，避免长期占用磁盘与队列：
 *   ① 完全没有资源（无 peer、速率为 0、进度不动）
 *   ② 中途没资源（曾经能下，后来长期停滞在某个百分比）
 *   ③ 还有资源但极慢（速率极低、预计还要几天甚至更久）
 *
 * 安全策略（防误删）：
 *   - 只有"开始下载超过 minAgeHours 小时（默认 10 小时）"的任务才参与判断；
 *   - 进度 >= salvagePercent（默认 79%）且存在视频文件时，**不删除**，
 *     而是按"文件可播放（如 mp4 未下完 VLC 也能播）视为完整"处理：
 *     把已存在的视频/图片移交归档→加密→发布流水线；
 *   - 删除前会同时清理 transmission 的 incomplete 目录
 *     （默认 /var/lib/transmission/incomplete）与我们的任务下载目录，
 *     且只允许删除白名单根目录内、非符号链接的普通目录；
 *   - 每次出清后广播"空间已腾挪"事件（space-freed），等待队列立即重新评估。
 */

const VIDEO_IMAGE_EXT = new Set([...config.videoExts, ...config.imageExts]);

const extOf = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
};

const isVideo = (name: string): boolean => config.videoExts.includes(extOf(name));

interface TorrentSnapshot {
  id: number;
  name: string;
  status: number;
  percentDone: number;
  rateDownload: number;
  eta: number;
  leftUntilDone: number;
  totalSize: number;
  downloadDir: string;
  error: number;
  errorString?: string;
  peersConnected?: number;
  peersSendingToUs?: number;
  files?: { name: string; length: number; bytesCompleted: number }[];
  wanted?: number[];
}

export type EvictReason = 'no-resource' | 'stalled' | 'too-slow';

export interface StaleCandidate {
  taskId: number;
  torrentId: number | null;
  title: string;
  ageHours: number;
  percent: number;
  rateBps: number;
  etaSec: number;
  peers: number;
  decision: 'evict' | 'salvage' | 'keep';
  reason: EvictReason | 'young' | 'progressing' | 'salvageable' | 'no-torrent' | 'paused' | 'paused-by-space';
  detail: string;
}

export interface EvictSummary {
  checked: number;
  evicted: number;
  salvaged: number;
  kept: number;
  freedBytes: number;
  candidates: StaleCandidate[];
}

/**
 * 累计"实际下载尝试时长"（毫秒）。
 *  - 只在任务处于 downloading/parsing（真正在尝试下载）时累计；
 *  - 因磁盘空间不足被自动暂停的时间不计入；
 *  - 老版本任务没有累计值时从 0 开始（保守：宁可晚清理，也不误删）。
 */
function accumulateActiveMs(task: Task, nowMs: number): { activeMs: number; lastCheckAt: string } {
  const payload = (task as Task & { payload?: Record<string, unknown> }).payload ?? {};
  const prevMs = Number(payload.btActiveMs ?? 0) || 0;
  const lastCheckAt = payload.btLastCheckAt ? Date.parse(String(payload.btLastCheckAt)) : 0;
  // 单次最多累计一个检查周期（默认 5 分钟），防止服务长时间停机后一次性跳满
  const delta = lastCheckAt ? Math.min(nowMs - lastCheckAt, 5 * 60_000) : 0;
  return { activeMs: prevMs + Math.max(0, delta), lastCheckAt: new Date(nowMs).toISOString() };
}

/** 读取 transmission 快照（拿不到 torrentId 则返回 null） */
async function snapshot(task: Task): Promise<TorrentSnapshot | null> {
  const torrentId = Number(((task as Task & { payload?: Record<string, unknown> }).payload ?? {}).torrentId ?? 0);
  if (!torrentId) return null;
  const client = transmissionClient();
  const info = await client.call<{ torrents: TorrentSnapshot[] }>('torrent-get', {
    ids: [torrentId],
    fields: [
      'id',
      'name',
      'status',
      'percentDone',
      'rateDownload',
      'eta',
      'leftUntilDone',
      'totalSize',
      'downloadDir',
      'error',
      'errorString',
      'peersConnected',
      'peersSendingToUs',
      'files',
      'wanted',
    ],
  });
  return info.torrents?.[0] ?? null;
}

/** 判断并执行单个任务的出清/挽救 */
async function handleTask(task: Task, dryRun: boolean): Promise<{ candidate: StaleCandidate; summary: { evicted: boolean; salvaged: boolean; freedBytes: number } }> {
  const settings = getSettings().btEvict;
  const payload = (task as Task & { payload?: Record<string, unknown> }).payload ?? {};
  const nowMs = Date.now();
  const base: StaleCandidate = {
    taskId: task.id,
    torrentId: Number(payload.torrentId ?? 0) || null,
    title: task.title,
    ageHours: 0,
    percent: 0,
    rateBps: 0,
    etaSec: 0,
    peers: 0,
    decision: 'keep',
    reason: 'progressing',
    detail: '',
  };

  // 因空间不足被自动暂停的任务：不算"尝试下载时间"，直接保留（不给它扣时间）
  if (payload.pausedBySpace === true) {
    return { candidate: { ...base, decision: 'keep', reason: 'paused-by-space', detail: '因磁盘空间不足被暂停，不计入尝试时长，等待空间释放' }, summary: { evicted: false, salvaged: false, freedBytes: 0 } };
  }
  // 手动暂停的任务同样不参与出清判断
  if (task.status === 'paused') {
    return { candidate: { ...base, decision: 'keep', reason: 'paused', detail: '任务处于暂停状态，不做判断' }, summary: { evicted: false, salvaged: false, freedBytes: 0 } };
  }

  // 【硬门槛】累计"实际下载尝试时间"，不足 minAgeHours 小时（默认 10 小时）一律不做任何出清判断
  const { activeMs, lastCheckAt } = accumulateActiveMs(task, nowMs);
  const activeHours = activeMs / 3600_000;
  if (!dryRun) {
    tasksRepo.update(task.id, { payload: { ...payload, btActiveMs: activeMs, btLastCheckAt: lastCheckAt } });
  }
  if (activeMs < settings.minAgeHours * 3600_000) {
    return {
      candidate: {
        ...base,
        ageHours: Number(activeHours.toFixed(2)),
        decision: 'keep',
        reason: 'young',
        detail: `实际下载尝试 ${activeHours.toFixed(2)} 小时（< ${settings.minAgeHours} 小时），仍在给的尝试时间内`,
      },
      summary: { evicted: false, salvaged: false, freedBytes: 0 },
    };
  }

  let snap: TorrentSnapshot | null = null;
  try {
    snap = await snapshot(task);
  } catch (e) {
    return { candidate: { ...base, decision: 'keep', reason: 'progressing', detail: `transmission 查询失败: ${(e as Error).message}` }, summary: { evicted: false, salvaged: false, freedBytes: 0 } };
  }
  if (!snap) {
    return { candidate: { ...base, decision: 'keep', reason: 'no-torrent', detail: 'transmission 中找不到任务' }, summary: { evicted: false, salvaged: false, freedBytes: 0 } };
  }

  const percent = Math.round((snap.percentDone ?? 0) * 1000) / 10; // 0.5 -> 50
  const rate = snap.rateDownload ?? 0;
  const eta = snap.eta && snap.eta > 0 ? snap.eta : 0;
  const peers = (snap.peersConnected ?? 0) + (snap.peersSendingToUs ?? 0);
  const candidate: StaleCandidate = {
    ...base,
    title: snap.name || task.title,
    ageHours: Number(activeHours.toFixed(2)),
    percent,
    rateBps: rate,
    etaSec: eta,
    peers,
  };

  const meta = (task.meta ?? {}) as Record<string, unknown>;
  const stall = (meta.btStall ?? {}) as { lastPercent?: number; lastChangeAt?: string };
  const nowIso = new Date().toISOString();
  const lastPercent = typeof stall.lastPercent === 'number' ? stall.lastPercent : -1;
  const changed = Math.abs(percent - lastPercent) >= 0.1;
  const lastChangeAt = changed || !stall.lastChangeAt ? nowIso : stall.lastChangeAt;
  const stallMs = Date.now() - new Date(lastChangeAt).getTime();

  if (!dryRun && (changed || !stall.lastChangeAt)) {
    tasksRepo.update(task.id, { meta: { ...meta, btStall: { lastPercent: percent, lastChangeAt, updatedAt: nowIso } } });
  }

  const noResource = rate === 0 && peers === 0 && stallMs >= settings.stallMinutes * 60_000;
  const stalled = rate === 0 && stallMs >= settings.stallMinutes * 60_000;
  const tooSlow = rate > 0 && rate < settings.slowKbps * 1024 && (eta === 0 || eta > settings.slowEtaHours * 3600);
  const reason: EvictReason | null = noResource ? 'no-resource' : stalled ? 'stalled' : tooSlow ? 'too-slow' : null;

  // 进度 >= salvagePercent：视为"可播放/基本完整"，做资源移交而不是删除
  // 文件可能位于：任务下载目录，或 transmission 的 incomplete 目录（取决于 daemon 配置）
  const searchRoots = [
    snap?.downloadDir ?? config.dirs.btDownload,
    path.join(config.transmissionIncompleteDir, String(snap?.name ?? task.title).replace(/[/\\]/g, '_')),
  ];
  const salvageableFiles = (snap.files ?? [])
    .filter((f, idx) => (snap?.wanted?.length ? snap.wanted[idx] !== 0 : true))
    .filter((f) => VIDEO_IMAGE_EXT.has(extOf(f.name)))
    .map((f) => {
      for (const root of searchRoots) {
        const abs = path.join(root, f.name);
        try {
          if (fs.statSync(abs).isFile() && fs.statSync(abs).size > 0) return { ...f, abs };
        } catch {
          /* 继续找下一个根目录 */
        }
      }
      return null;
    })
    .filter((f): f is { name: string; length: number; bytesCompleted: number; abs: string } => !!f);

  if (percent >= settings.salvagePercent && salvageableFiles.length > 0) {
    const hasVideo = salvageableFiles.some((f) => isVideo(f.name));
    if (!hasVideo) {
      candidate.decision = 'keep';
      candidate.reason = 'progressing';
      candidate.detail = `${percent}% 但可用的都是图片，不按可播放处理`;
      return { candidate, summary: { evicted: false, salvaged: false, freedBytes: 0 } };
    }
    candidate.decision = 'salvage';
    candidate.reason = 'salvageable';
    candidate.detail = `进度 ${percent}% ≥ ${settings.salvagePercent}%，按"未下完但可播放"处理，移交归档（${salvageableFiles.length} 个文件）`;
    if (dryRun) return { candidate, summary: { evicted: false, salvaged: false, freedBytes: 0 } };

    logger.warn(`BT 出清[挽救] 任务 #${task.id} ${candidate.title}: ${candidate.detail}`);
    // 1) 先停任务，避免边移边写
    const client = transmissionClient();
    await client.call('torrent-stop', { ids: [snap.id] }).catch((e) => logger.warn(`BT 出清停止任务失败: ${(e as Error).message}`));
    // 2) 移交给归档流水线（文件会被移出下载目录）
    const size = salvageableFiles.reduce((s, f) => s + fs.statSync(f.abs).size, 0);
    handoffToArchive(task.id, salvageableFiles.map((f) => f.abs), snap.name || task.title, size);
    // 3) 移除 transmission 任务，但**保留文件**给归档流水线搬运；
    //    剩余文件/目录（含 incomplete 目录里的分片）等发布完成后再清理（见 pipeline）
    await client.call('torrent-remove', { ids: [snap.id], 'delete-local-data': false }).catch((e) => logger.warn(`BT 出清删除 transmission 任务失败: ${(e as Error).message}`));
    const latest = tasksRepo.get(task.id) as Task & { payload?: Record<string, unknown> };
    tasksRepo.update(task.id, {
      payload: {
        ...((latest?.payload ?? payload) as Record<string, unknown>),
        torrentId: null,
        pendingDirCleanup: true,
        pendingDirCleanupName: snap.name || task.title,
      },
    });
    logger.info(`BT 出清[挽救] 任务 #${task.id} 已移交归档；下载目录与 incomplete 目录将在发布完成后清理`);
    return { candidate, summary: { evicted: false, salvaged: true, freedBytes: 0 } };
  }

  if (!reason) {
    candidate.decision = 'keep';
    candidate.reason = 'progressing';
    candidate.detail = `进度 ${percent}% 速率 ${(rate / 1024).toFixed(1)}KB/s，仍在推进`;
    return { candidate, summary: { evicted: false, salvaged: false, freedBytes: 0 } };
  }

  candidate.decision = 'evict';
  candidate.reason = reason;
  candidate.detail =
    reason === 'no-resource'
      ? `超过 ${settings.minAgeHours} 小时无资源（无 peer、速率为 0、停滞 ≥ ${settings.stallMinutes} 分钟），进度 ${percent}%`
      : reason === 'stalled'
        ? `停滞在 ${percent}%（≥ ${settings.stallMinutes} 分钟无进度），无资源可继续下载`
        : `速率仅 ${(rate / 1024).toFixed(1)}KB/s（< ${settings.slowKbps}KB/s），预计还需 ${eta > 0 ? (eta / 3600).toFixed(0) : '未知'} 小时，过慢`;

  if (dryRun) return { candidate, summary: { evicted: false, salvaged: false, freedBytes: 0 } };

  logger.warn(`BT 出清[删除] 任务 #${task.id} ${candidate.title}: ${candidate.detail}`);
  const client = transmissionClient();
  await client.call('torrent-remove', { ids: [snap.id], 'delete-local-data': true }).catch((e) => logger.warn(`BT 出清删除 transmission 任务失败: ${(e as Error).message}`));
  const freedBytes = cleanupBtTaskDirs(task, snap.name || task.title, 'bt-evict');
  const seedId = Number(payload.seedId ?? 0);
  if (seedId) seedsRepo.update(seedId, { status: 'failed', error: `长时间无法完成，已出清：${candidate.detail}` });
  tasksRepo.update(task.id, {
    status: 'failed',
    error: `已出清（${reason === 'no-resource' ? '无资源' : reason === 'stalled' ? '停滞无资源' : '资源过慢'}）：${candidate.detail}`,
    speedBps: 0,
    finishedAt: new Date().toISOString(),
  });
  bus.emitTask(tasksRepo.get(task.id));
  return { candidate, summary: { evicted: true, salvaged: false, freedBytes } };
}

/** 扫描所有 BT 任务，执行出清判断（dryRun=true 时只返回候选，不做任何修改） */
export async function runBtEvict({ dryRun = false } = {}): Promise<EvictSummary> {
  const settings = getSettings().btEvict;
  const summary: EvictSummary = { checked: 0, evicted: 0, salvaged: 0, kept: 0, freedBytes: 0, candidates: [] };
  if (!settings.enabled && !dryRun) {
    logger.debug('BT 出清机制已关闭，跳过检查');
    return summary;
  }

  const tasks = tasksRepo.list({
    modules: ['transmission'],
    statuses: ['downloading', 'parsing', 'paused'],
    pageSize: 200,
  }).items;

  for (const task of tasks) {
    summary.checked += 1;
    try {
      const { candidate, summary: r } = await handleTask(task, dryRun);
      summary.candidates.push(candidate);
      if (r.evicted) summary.evicted += 1;
      else if (r.salvaged) summary.salvaged += 1;
      else summary.kept += 1;
      summary.freedBytes += r.freedBytes;
    } catch (e) {
      logger.error(`BT 出清检查任务 #${task.id} 异常: ${(e as Error).message}`);
      summary.kept += 1;
    }
  }
  if (summary.checked > 0) {
    logger.info(
      `BT 出清检查完成：检查 ${summary.checked} 个，删除 ${summary.evicted} 个，挽救 ${summary.salvaged} 个，保留 ${summary.kept} 个，释放 ${(summary.freedBytes / 1024 / 1024).toFixed(1)}MB`,
    );
  }
  return summary;
}

/* ------------------------------------------------------------------ */
/* 定时 worker                                                        */
/* ------------------------------------------------------------------ */

let timer: NodeJS.Timeout | null = null;
let lastRun = 0;
let running = false;

export function startBtEvictWorker(): void {
  if (timer) return;
  const settings = getSettings().btEvict;
  logger.info(
    `BT 出清机制已启动：仅处理下载 ≥ ${settings.minAgeHours} 小时的任务；停滞 ${settings.stallMinutes} 分钟判定无资源；` +
      `速率 < ${settings.slowKbps}KB/s 且预计 > ${settings.slowEtaHours} 小时判定过慢；进度 ≥ ${settings.salvagePercent}% 按可播放处理；每 ${settings.checkIntervalMin} 分钟检查一次`,
  );
  timer = setInterval(() => {
    void (async () => {
      if (running) return;
      const s = getSettings().btEvict;
      if (!s.enabled) return;
      if (Date.now() - lastRun < Math.max(1, s.checkIntervalMin) * 60_000) return;
      running = true;
      lastRun = Date.now();
      try {
        await runBtEvict();
      } catch (e) {
        logger.error(`BT 出清定时检查失败: ${(e as Error).message}`);
      } finally {
        running = false;
      }
    })();
  }, 60_000);
}

export function stopBtEvictWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
