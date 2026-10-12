/**
 * aria2 孤儿收割：把 `downd_aria2_path` 里"**已经下完、但没进归档**"的文件
 * 重新送进归档流水线（→ 加密 → 消费者目录 → 「文件」页）。
 *
 * 真机事故（用户反馈）：
 *   - 用户在「文件」和「任务」里都清空了，可 `downd_aria2_path` 还占着 30G；
 *   - `downd_aria2_path` 里有下好的 mp4，却没出现在「文件」里。
 *
 * 根因：aria2 的完成只靠 `poll()` 的 `done` 分支触发 `handoffToArchive`。一旦
 *   ① 下完的瞬间进程被断电/重启打断；② 用户删了任务（DB 记录没了、磁盘文件还在）；
 *   ③ aria2 daemon 重启后 gid 变了、我们的任务对不上 —— 那个文件就永远留在下载区，
 *   谁也不再管它。
 *
 * 所以这里加一个**定期兜底**：扫描下载区，凡是"已完成（没有 .aria2 控制文件）、
 * 不在 aria2 实时任务里、也不在任何 DB 任务/成品记录里"的文件，都重新送进归档。
 *
 * 安全（写死，别破）：
 *   · 有 `.aria2` 控制文件的 = 还在下，跳过；
 *   · 在 aria2 实时任务集合里的 = 还活着，跳过；
 *   · 被任何 DB 任务（archiving/encrypting/downloading…）或 published_files 引用的 = 跳过；
 *   · mtime < 5 分钟 = 刚下完还没轮到 poll 处理，跳过（等 poll 自己来）；
 *   · aria2 RPC 不可用 → 拿不到"还活着"集合，**整体跳过**（宁可少收，不误收）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { filesRepo, tasksRepo } from '../core/db';
import { logger } from '../core/logger';
import { createPublishTask } from './pipeline';
import { aria2LivePaths } from './junkScan';

const SETTLE_MS = 5 * 60_000;

/** 递归列文件（不跟符号链接，限深度） */
function walk(dir: string, maxDepth = 6): string[] {
  const out: string[] = [];
  const go = (d: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) go(p, depth + 1);
      else if (e.isFile()) out.push(p);
    }
  };
  go(dir, 0);
  return out;
}

/** 被"还在干活"的任何 DB 任务引用的路径（含 downloadedPaths 数组） */
function taskReferencedPaths(): Set<string> {
  const set = new Set<string>();
  for (const t of tasksRepo.byStatus(['waiting', 'parsing', 'downloading', 'paused', 'archiving', 'encrypting'])) {
    const tt = t as (typeof t) & { payload?: Record<string, unknown> };
    for (const v of [tt.outputPath, tt.publishedName, tt.payload?.out, tt.payload?.downloadDir, tt.payload?.seedPath]) {
      if (typeof v === 'string' && v) set.add(path.resolve(v));
    }
    const dp = tt.payload?.downloadedPaths;
    if (Array.isArray(dp)) for (const f of dp) if (typeof f === 'string' && f) set.add(path.resolve(f));
  }
  return set;
}

/** published_files 里已知的成品路径（分页取全） */
function publishedPaths(): Set<string> {
  const set = new Set<string>();
  let page = 1;
  for (;;) {
    const r = filesRepo.list({ page, pageSize: 500 });
    for (const row of r.rows) if (row.path) set.add(path.resolve(row.path));
    if (r.rows.length === 0 || set.size >= r.total) break;
    page += 1;
    if (page > 40) break;
  }
  return set;
}

export interface HarvestResult {
  archived: number;
  skipped: number;
  errors: string[];
}

/**
 * 收割一次。返回送进归档的文件数。
 * maxPerRun 防呆：一次别灌太多（归档/加密会各写一份，磁盘紧张时先少收点）。
 */
export async function harvestOrphanAria2(maxPerRun = 20): Promise<HarvestResult> {
  const dir = config.dirs.aria2;
  if (!fs.existsSync(dir)) return { archived: 0, skipped: 0, errors: [] };

  // ⚠️ 拿不到 aria2 实时集合就整体跳过 —— 宁可少收，不误收正在下的文件
  const live = await aria2LivePaths();
  if (live === null) {
    logger.child('aria2-harvest').warn('aria2 RPC 不可用，本次不收割（不敢乱动下载区）');
    return { archived: 0, skipped: 0, errors: ['aria2 RPC 不可用'] };
  }

  const referenced = taskReferencedPaths();
  for (const p of publishedPaths()) referenced.add(p);

  const result: HarvestResult = { archived: 0, skipped: 0, errors: [] };
  const now = Date.now();

  for (const file of walk(dir)) {
    if (result.archived >= maxPerRun) break;
    const base = path.basename(file);
    if (base.endsWith('.aria2')) continue; // 控制文件，不是数据

    const resolved = path.resolve(file);
    if (live.has(resolved) || referenced.has(resolved)) continue; // 还活着/已被引用

    // 有配套 .aria2 控制文件 = 还在下，跳过
    if (fs.existsSync(`${file}.aria2`)) continue;

    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size === 0) continue;
    if (now - st.mtimeMs < SETTLE_MS) continue; // 刚下完，让 poll 先处理

    try {
      // 每个文件一个发布任务（归档→加密→消费者→「文件」）
      createPublishTask({
        module: 'aria2',
        title: base,
        platform: 'URL',
        files: [file],
        originalName: base,
        sizeBytes: st.size,
        parentTaskId: 0,
      });
      result.archived += 1;
      logger.child('aria2-harvest').mark('ARIA2_HARVEST', `孤儿下载已重新送进归档：${base}（${(st.size / 1024 ** 2).toFixed(1)} MiB）`);
    } catch (e) {
      result.errors.push(`${base}: ${(e as Error).message}`);
    }
  }

  if (result.archived > 0 || result.errors.length) {
    logger.child('aria2-harvest').mark('ARIA2_HARVEST', `收割完成：送归档 ${result.archived} 个，跳过 ${result.skipped} 个，失败 ${result.errors.length} 个`, {
      archived: result.archived,
      errors: result.errors.slice(0, 5),
    });
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startAria2HarvestWorker(everyMs = 60_000): void {
  if (timer) return;
  void harvestOrphanAria2().catch((e) => logger.child('aria2-harvest').error(`[MARK:ERROR] 收割失败: ${(e as Error).message}`));
  timer = setInterval(() => {
    void harvestOrphanAria2().catch((e) => logger.child('aria2-harvest').error(`[MARK:ERROR] 收割失败: ${(e as Error).message}`));
  }, everyMs);
  timer.unref?.();
  logger.mark('BOOT', `aria2 孤儿收割已启动（每 ${Math.round(everyMs / 1000)} 秒一次，把"下完没归档"的文件送回「文件」）`);
}

export function stopAria2HarvestWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
