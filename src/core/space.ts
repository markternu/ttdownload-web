/**
 * 磁盘准入的"预扣额度"计算 —— 调度器与 /api/system 必须用**同一套**算法，
 * 否则用户看到的"可用于下载"和调度器实际判定的数不是一回事（线上真实投诉：
 * 页面显示可用于下载 5.28G，一个 1.6G 的任务却在排队）。
 */
import { tasksRepo } from './db';
import type { TaskWithPayload } from '../modules/types';

/**
 * 一个任务**还差多少字节**才下完。
 *
 * ⚠️ 关键：只预扣"还没下完的部分"，不是整个文件的预计大小。
 *   历史 bug：按 `expectBytes` 全额预扣一整场下载 —— 一个下到 91% 的任务仍占着整整 2.48G，
 *   于是"可用于下载 5.28G"却连 1.6G 的任务都放不进来。
 * 预计最终大小取 `max(expectBytes, totalBytes)`：transmission 报的真实总量（totalBytes）
 *   有时比我们的预估还大（真机见过预估 1.15G、实际 1.44G），少算会导致磁盘写满。
 * 已经下超（downloaded > total）时返回 0，绝不返回负数。
 */
export function remainingBytesOf(t: {
  expectBytes?: number | null;
  totalBytes?: number | null;
  downloadedBytes?: number | null;
}): number {
  const expect = Math.max(0, Number(t.expectBytes ?? 0) || 0);
  const total = Math.max(0, Number(t.totalBytes ?? 0) || 0);
  const done = Math.max(0, Number(t.downloadedBytes ?? 0) || 0);
  return Math.max(0, Math.max(expect, total) - done);
}

/**
 * 正在下载（`downloading`/`parsing`）的任务**总共还差多少**空间 —— 放行新任务时要扣掉的就是它。
 * `excludeId` 用于 prepare 之后的第二次判断：那一刻任务自己已是 `parsing`，
 * 不排掉的话会把自己重复算一遍，导致"自己把自己挡住"。
 */
export function reservedByRunningTasks(excludeId?: number): number {
  const running = tasksRepo.byStatus(['downloading', 'parsing']) as TaskWithPayload[];
  return running.reduce((sum, t) => (t.id === excludeId ? sum : sum + remainingBytesOf(t)), 0);
}
