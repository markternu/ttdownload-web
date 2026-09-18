/**
 * BT 扫货：定期扫 transmission 自己的两个目录，把"已经下载好的视频"交给
 * 归档 → 加密 → 发布流水线。与"种子超时策略"完全独立、互不干涉。
 *
 *   /var/lib/transmission/downloads    ← 下完了的（100%）
 *   /var/lib/transmission/incomplete   ← 正在下的（没 100%）
 *
 * 打包规则（用户指定，阈值默认 300MB）：
 *   downloads：
 *     · 只有 1 个文件            → 直接改名加密归档一条龙
 *     · 多个文件且全都 < 阈值     → 全部装进一个 zip，再改名加密归档
 *     · 有文件 ≥ 阈值            → 这些大文件一个一个单独走
 *     处理完（发布成功后）→ rm -rf 对应文件夹 → 再删掉 transmission 里的任务
 *   incomplete：
 *     · 只有 1 个文件 → 跳过（还没下完）
 *     · 多个文件且其中有下完的 → 下完的那些按同样规则（<阈值打包 / ≥阈值单独）交出去
 *     注意：**不动文件夹、不动 transmission 任务**（它还在下）
 *
 * 为什么不在下载完成的瞬间直接处理：用户要求"扔给 transmission 就别管它，
 * 12 小时内不干涉"。扫货是按目录独立判断的，天然不会干扰 transmission。
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { bus } from '../core/events';
import { logger, taskLog } from '../core/logger';
import { tasksRepo, seedsRepo } from '../core/db';
import { getSettings } from './settings';
import { buildPublishUnits, extOfName } from './btSelect';
import { hidePath, hidePathDeep, hideText } from './btAnon';
import { createPublishTask } from './pipeline';
import { cleanupBtTaskDirs } from './btCleanup';
import { transmissionClient } from '../modules/transmission';
import type { Task } from '../types';

interface HarvestInfo {
  dir?: string;
  torrentId?: number;
  torrentHash?: string;
  torrentName?: string;
  downloadTaskId?: number;
  files?: string[];
  /** 来自 incomplete 的交接：种子还在下 → 收尾阶段只记账，绝不删目录/删任务 */
  keepTorrent?: boolean;
}

type TaskWithPayload = Task & { payload?: Record<string, unknown> };

export interface HarvestSummary {
  downloadsScanned: number;
  incompleteScanned: number;
  published: number;
  finished: number;
  tasks: number[];
}

interface TorrentLite {
  id: number;
  name: string;
  hashString: string;
  percentDone: number;
  downloadDir: string;
  files: { name: string; length: number; bytesCompleted: number }[];
}

const VIDEO_EXT = new Set(config.videoExts.map((e) => e.toLowerCase()));

function isVideo(name: string): boolean {
  return VIDEO_EXT.has(extOfName(name));
}

function sizeOf(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function baseName(p: string): string {
  return path.basename(p).replace(/\.[^.]+$/, '');
}

/** 列出 transmission 里所有种子（读操作，不影响它们） */
async function listTorrents(): Promise<TorrentLite[]> {
  try {
    const client = transmissionClient();
    if (!(await client.ping())) return [];
    const info = await client.call<{ torrents: Record<string, unknown>[] }>('torrent-get', {
      fields: ['id', 'name', 'hashString', 'percentDone', 'downloadDir', 'files'],
    });
    return (info.torrents ?? []).map((t) => ({
      id: Number(t.id ?? 0),
      name: String(t.name ?? ''),
      hashString: String(t.hashString ?? ''),
      percentDone: Number(t.percentDone ?? 0),
      downloadDir: String(t.downloadDir ?? ''),
      files: Array.isArray(t.files)
        ? (t.files as Record<string, unknown>[]).map((f) => ({
            name: String(f.name ?? ''),
            length: Number(f.length ?? 0),
            bytesCompleted: Number(f.bytesCompleted ?? 0),
          }))
        : [],
    }));
  } catch (e) {
    logger.child('bt-harvest').warn(`读取 transmission 清单失败：${(e as Error).message}`);
    return [];
  }
}

/** 递归收集一个目录里的普通文件（只一层层往下，不跟符号链接） */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * 把"已经从 incomplete 里交出去"的文件在 transmission 里标成 unwanted。
 *
 * 为什么必须做：这些文件马上会被归档搬走/重命名，transmission 发现文件缺失会**重新下载**，
 * 于是重复占空间带宽，而且下一轮扫货又会把它们当"新下完的"再发布一次。
 * 只动勾选、不动任务、不动目录（种子该下的其它文件继续下）。
 */
async function markFilesUnwanted(torrent: TorrentLite, dir: string, files: string[]): Promise<void> {
  const wanted = new Set(files.map((f) => path.resolve(f)));
  const idx: number[] = [];
  for (let i = 0; i < torrent.files.length; i += 1) {
    const rel = String(torrent.files[i]?.name ?? '');
    if (!rel) continue;
    if (wanted.has(path.resolve(path.join(dir, rel)))) idx.push(i);
  }
  if (!idx.length) return;
  try {
    const client = transmissionClient();
    if (!(await client.ping())) return;
    await client.call('torrent-set', { ids: [torrent.id], 'files-unwanted': idx }).catch(() => undefined);
    logger.child('bt-harvest').mark('BT_HARVEST', `已把 ${idx.length} 个已取走的文件在 transmission 里标为不再下载（防止重复下载）`, {
      torrentId: torrent.id,
      fileCount: idx.length,
    });
  } catch (e) {
    logger.child('bt-harvest').warn(`标记 unwanted 失败（不影响已交接的货）：${hideText((e as Error).message)}`);
  }
}

/** 已经有发布任务在处理的文件（防止每个 tick 重复交同一个文件） */
function filesInFlight(): Set<string> {
  const out = new Set<string>();
  const active = tasksRepo.list({ statuses: ['waiting', 'parsing', 'downloading', 'archiving', 'encrypting', 'paused'], pageSize: 500 }).items as TaskWithPayload[];
  for (const t of active) {
    const paths = Array.isArray((t.payload ?? {}).downloadedPaths) ? ((t.payload ?? {}).downloadedPaths as string[]) : [];
    for (const f of paths) out.add(path.resolve(String(f)));
  }
  return out;
}

/**
 * **已经交出去过**的文件（含已经发布完成的任务）。
 *
 * 为什么不能只看 filesInFlight：发布任务一旦 completed 就不在 in-flight 里了，
 * 而 incomplete 分支的源文件是**留在原地**的（我们不删还在下的目录）——
 * 只要 `downloadTask` 找不到（任务被界面删掉、种子是外部直接加进 transmission、
 * 同名种子匹配到别的任务），每个 tick 都会把同一批文件重新发布一遍（重复成品 + 重复占空间）。
 * 所以这里按"所有任务 payload.harvest.files"做文件级账本，谁交过就记谁。
 */
function filesAlreadyHandedOff(): Set<string> {
  const out = new Set<string>();
  for (const statuses of [
    ['waiting', 'parsing', 'downloading', 'paused', 'archiving', 'encrypting'],
    ['completed', 'failed', 'cancelled'],
  ]) {
    const items = tasksRepo.list({ statuses: statuses as never, pageSize: 500 }).items as TaskWithPayload[];
    for (const t of items) {
      const h = (t.payload ?? {}).harvest as HarvestInfo | undefined;
      for (const f of h?.files ?? []) out.add(path.resolve(String(f)));
    }
  }
  return out;
}

/** 这个目录是不是已经有发布任务在处理了（防止每个 tick 重复建任务） */
function alreadyHarvesting(dir: string): boolean {
  const tasks = tasksRepo.list({ statuses: ['waiting', 'parsing', 'downloading', 'archiving', 'encrypting', 'paused'], pageSize: 500 }).items as TaskWithPayload[];
  if (tasks.some((t) => ((t.payload ?? {}).harvest as HarvestInfo | undefined)?.dir === dir)) return true;
  // 已经发布完、但还没做收尾（harvestDone）的也算 —— 中间可能隔着一次重启，
  // 这时源文件还在目录里，不能再建一个任务。
  const done = tasksRepo.list({ statuses: ['completed'], pageSize: 500 }).items as TaskWithPayload[];
  return done.some((t) => {
    const p = t.payload ?? {};
    const h = p.harvest as HarvestInfo | undefined;
    return h?.dir === dir && !p.harvestDone;
  });
}

/**
 * 扫一轮。
 * @param dryRun 只报告不落库（给"预览"用）
 */
export async function btHarvestTick({ dryRun = false } = {}): Promise<HarvestSummary> {
  const settings = getSettings();
  const maxSmall = Math.max(0, Number(settings.btSelect.smallFileMaxBytes) || 0);
  const summary: HarvestSummary = { downloadsScanned: 0, incompleteScanned: 0, published: 0, finished: 0, tasks: [] };

  const torrents = await listTorrents();
  const byName = new Map<string, TorrentLite>();
  for (const t of torrents) byName.set(t.name, t);

  // ---------- ① 完成目录 ----------
  const completeDir = config.dirs.btDownload;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(completeDir, { withFileTypes: true });
  } catch (e) {
    logger.child('bt-harvest').warn(`读不到完成目录 ${completeDir}：${(e as Error).message}`);
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(completeDir, entry.name);
    summary.downloadsScanned += 1;
    if (alreadyHarvesting(abs)) continue;

    const torrent = byName.get(entry.name);
    const all = entry.isDirectory() ? collectFiles(abs) : [abs];
    const inflightDone = filesInFlight();
    const videos = all.filter((f) => isVideo(f) && sizeOf(f) > 0 && !inflightDone.has(path.resolve(f)));
    if (!videos.length) continue;

    const units = buildPublishUnits(videos, maxSmall, sizeOf, baseName, entry.name);
    const downloadTask = torrent
      ? (tasksRepo.list({ modules: ['transmission'], statuses: ['waiting', 'parsing', 'downloading', 'paused'], pageSize: 500 }).items as TaskWithPayload[])
          .find((t) => Number((t.payload ?? {}).torrentId ?? 0) === torrent.id)
      : undefined;

    // ⚠️ 一个目录只建**一个**任务（带多个成品单元）。若拆成多个任务，
    //    先完成的那个会在收尾时把目录删掉，正在打包的那个源文件就没了。
    const totalBytes = units.reduce((sum, u) => sum + u.files.reduce((a, f) => a + sizeOf(f), 0), 0);
    if (dryRun) {
      summary.published += units.length;
      continue;
    }
    const id = createPublishTask({
      module: 'transmission',
      title: entry.name,
      platform: 'BT',
      files: videos,
      originalName: entry.name,
      sizeBytes: totalBytes,
      parentTaskId: downloadTask ? Number(downloadTask.id) : 0,
      units,
      harvest: {
        dir: abs,
        torrentId: torrent?.id,
        torrentHash: torrent?.hashString,
        torrentName: entry.name,
        downloadTaskId: downloadTask ? Number(downloadTask.id) : undefined,
        files: videos,
      },
    });
    summary.published += units.length;
    summary.tasks.push(id);
    // ⚠️ entry.name 就是种子名 / 内容文件夹名 → 日志只记目录（hidePath 隐藏最后一段）
    logger.child('bt-harvest').mark('BT_HARVEST',
      `扫到货（${hidePath(abs)}）：${videos.length} 个视频 / ${units.length} 个成品（${(totalBytes / 1024 ** 2).toFixed(1)}MB）→ 任务 #${id}`, {
        torrentId: torrent?.id,
        videoCount: videos.length,
        unitSizes: units.map((u) => u.files.length),
        totalBytes,
      });
  }

  // ---------- ② incomplete 目录（只取已经下完的文件，绝不动任务和目录） ----------
  const incompleteDir = config.transmissionIncompleteDir;
  let incEntries: fs.Dirent[] = [];
  try {
    incEntries = fs.readdirSync(incompleteDir, { withFileTypes: true });
  } catch {
    /* 目录不存在就算了 */
  }
  for (const entry of incEntries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(incompleteDir, entry.name);
    summary.incompleteScanned += 1;
    const torrent = byName.get(entry.name);
    if (!torrent) continue;
    const all = entry.isDirectory() ? collectFiles(abs) : [abs];
    // 只有一个文件 → 跳过（还没下完，用户明确要求）
    if (all.length <= 1) continue;

    const doneVideos = torrent.files
      .filter((f) => isVideo(f.name) && f.length > 0 && f.bytesCompleted >= f.length)
      .map((f) => path.join(abs, f.name))
      .filter((p) => fs.existsSync(p) && sizeOf(p) > 0);
    if (!doneVideos.length) continue;

    // 已经交出去过的文件不再重复交（下载任务的 harvestedFiles + 全量文件级账本 + 在飞的）
    const downloadTask = (tasksRepo.list({ modules: ['transmission'], statuses: ['waiting', 'parsing', 'downloading', 'paused'], pageSize: 500 }).items as TaskWithPayload[])
      .find((t) => Number((t.payload ?? {}).torrentId ?? 0) === torrent.id);
    const doneList = downloadTask && Array.isArray((downloadTask.payload ?? {}).harvestedFiles)
      ? ((downloadTask.payload ?? {}).harvestedFiles as string[])
      : [];
    const inflight = filesInFlight();
    const handedOff = filesAlreadyHandedOff();
    const fresh = doneVideos.filter(
      (p) => !doneList.includes(p) && !inflight.has(path.resolve(p)) && !handedOff.has(path.resolve(p)),
    );
    if (!fresh.length) continue;

    // 交接前先在 transmission 里把这些文件标成 unwanted：
    // 否则归档把它们搬走/重命名后，transmission 会认为文件缺失而**重新下载**一遍
    // （重复占空间与带宽，而且下次扫货又会把它们当成"新下完的"再发布一次）。
    await markFilesUnwanted(torrent, abs, fresh);

    const units = buildPublishUnits(fresh, maxSmall, sizeOf, baseName, entry.name);
    for (const u of units) {
      if (dryRun) {
        summary.published += 1;
        continue;
      }
      const sizeBytes = u.files.reduce((sum, f) => sum + sizeOf(f), 0);
      const id = createPublishTask({
        module: 'transmission',
        title: u.files.length > 1 ? `${entry.name}（已下完${u.files.length}个）` : baseName(u.files[0]),
        platform: 'BT',
        files: u.files,
        originalName: u.name,
        sizeBytes,
        parentTaskId: downloadTask ? Number(downloadTask.id) : 0,
        harvest: {
          // incomplete：**绝不能删目录、绝不能删 transmission 任务**（它还在下）。
          // keepTorrent 就是给收尾阶段（③）看的：它只做记账，不做任何清理。
          keepTorrent: true,
          torrentId: torrent.id,
          torrentHash: torrent.hashString,
          torrentName: entry.name,
          downloadTaskId: downloadTask ? Number(downloadTask.id) : undefined,
          files: u.files,
        },
      });
      summary.published += 1;
      summary.tasks.push(id);
      logger.child('bt-harvest').mark('BT_HARVEST',
        `incomplete 里发现已下完的视频（${hidePath(abs)}）：${u.files.length} 个文件 → 任务 #${id}（不动目录与任务）`);
    }
    if (downloadTask) {
      const prev = (downloadTask.payload ?? {}) as Record<string, unknown>;
      tasksRepo.update(Number(downloadTask.id), {
        payload: { ...prev, harvestedFiles: [...doneList, ...fresh] },
      });
    }
  }

  // ---------- ③ 收尾：已发布成功的货 → 删文件夹 + 删 transmission 任务 ----------
  const published = tasksRepo.list({ statuses: ['completed'], pageSize: 500 }).items as TaskWithPayload[];
  for (const t of published) {
    const h = (t.payload ?? {}).harvest as HarvestInfo | undefined;
    if (!h || (t.payload ?? {}).harvestDone) continue;
    if (dryRun) {
      summary.finished += 1;
      continue;
    }

    // 3-0) 来自 incomplete 的交接：只记账，**一个字节都不动**
    //      （种子还在下、目录还是它的，删任务等于把还没下完的种子干掉）
    if (h.keepTorrent) {
      tasksRepo.update(t.id, { payload: { ...((t.payload ?? {}) as Record<string, unknown>), harvestDone: true } });
      continue;
    }

    // 3-0b) 目录还有别的扫货任务在处理 → 整块推迟，**不能置 harvestDone**
    //       （否则 transmission 任务被删了、目录却永远留在磁盘上没人管）
    const dirBusy = h.dir
      ? (tasksRepo.list({ statuses: ['waiting', 'parsing', 'downloading', 'archiving', 'encrypting', 'paused'], pageSize: 500 }).items as TaskWithPayload[])
          .some((x) => Number(x.id) !== Number(t.id) && ((x.payload ?? {}).harvest as HarvestInfo | undefined)?.dir === h.dir)
      : false;
    if (h.dir && dirBusy) {
      logger.child('bt-harvest').mark('BT_HARVEST', `还有别的扫货任务在处理 ${hidePath(h.dir)}，本次不清理（下轮再说）`);
      continue;
    }

    summary.finished += 1;

    // 3a) 先删 transmission 任务（否则文件没了它会重新校验/重下）
    if (h.torrentId || h.torrentHash) {
      try {
        const client = transmissionClient();
        if (await client.ping()) {
          const ids: (number | string)[] = h.torrentId ? [h.torrentId] : [String(h.torrentHash)];
          await client.call('torrent-remove', { ids, 'delete-local-data': false }).catch(() => undefined);
          // torrentName 可能是异常/多段的名字 → 用深层隐藏，别只砍最后一段
          logger.child('bt-harvest').mark('BT_HARVEST', `已从 transmission 移除任务：${hidePathDeep(h.torrentName ?? h.torrentHash ?? '')}`, { ids });
        }
      } catch (e) {
        logger.child('bt-harvest').warn(`移除 transmission 任务失败：${hideText((e as Error).message)}`);
      }
    }

    // 3b) 再删掉对应的文件夹（只删这一个种子自己的目录，走白名单安全检查）
    //     "目录还有别的任务在用"的情况已经在 3-0b 提前挡掉了
    if (h.dir) {
      const freed = cleanupBtTaskDirs(t as Task, h.torrentName ?? path.basename(h.dir), 'bt-harvest');
      logger.child('bt-harvest').mark('BT_HARVEST',
        `扫货完成，已清理 ${hidePath(h.dir)}${freed ? `（释放 ${(freed / 1024 ** 2).toFixed(1)}MB）` : ''}`, { freedBytes: freed });
      if (freed > 0) bus.emitSpaceFreed({ bytes: freed, reason: 'bt-harvest', detail: { taskId: t.id } });
    }

    // 3c) 下载任务收尾
    if (h.downloadTaskId) {
      const dt = tasksRepo.get(Number(h.downloadTaskId)) as TaskWithPayload | null;
      if (dt && !['completed', 'failed', 'cancelled'].includes(dt.status)) {
        tasksRepo.update(Number(h.downloadTaskId), {
          status: 'completed',
          progress: 100,
          speedBps: 0,
          finishedAt: new Date().toISOString(),
          error: null,
          payload: { ...((dt.payload ?? {}) as Record<string, unknown>), harvestedAt: new Date().toISOString() },
        });
        // 种子记录也要收尾：以前只写 queued/downloading/failed，'done' 从来没被写过，
        // 界面上种子永远显示"下载中"、按钮永久禁用。
        const seedId = Number((dt.payload ?? {}).seedId ?? 0);
        if (seedId) seedsRepo.update(seedId, { status: 'done' });
        taskLog(Number(h.downloadTaskId)).mark('BT_HARVEST', `货物已被扫走、文件夹与 transmission 任务已清理，任务收尾`);
      }
    }

    // 只有**目录真的没了**才算收尾完成。清理被跳过/失败时留着 harvestDone=false，
    // 下一轮还会再来（否则 transmission 任务删了、目录却永远留在磁盘上没人管）。
    if (h.dir && fs.existsSync(h.dir)) {
      logger.child('bt-harvest').warn(`目录还没能删掉（${hidePath(h.dir)}），保留收尾标记等下一轮重试`);
      continue;
    }
    tasksRepo.update(t.id, { payload: { ...((t.payload ?? {}) as Record<string, unknown>), harvestDone: true } });
  }

  return summary;
}

let timer: NodeJS.Timeout | null = null;

export function startBtHarvestWorker(): void {
  if (timer) return;
  const everyMs = Math.max(30_000, Number(process.env.BT_HARVEST_INTERVAL_MS ?? 120_000));
  timer = setInterval(() => {
    btHarvestTick().catch((e) => logger.child('bt-harvest').error(`[MARK:ERROR] 扫货异常: ${(e as Error).message}`));
  }, everyMs);
  logger.mark('BOOT', `BT 扫货已启动（每 ${Math.round(everyMs / 1000)} 秒扫一次 ${config.dirs.btDownload} 与 ${config.transmissionIncompleteDir}）`);
}

export function stopBtHarvestWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
