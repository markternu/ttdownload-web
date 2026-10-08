import { Router } from 'express';
import { tasksRepo } from '../core/db';
import { cancelTask, deleteTask, pauseTask, resumeTask, retryTask, kickScheduler } from '../core/scheduler';
import { asyncHandler, badRequest, notFound } from '../utils/http';
import { logger } from '../core/logger';
import type { ModuleId, TaskStatus } from '../types';

export const tasksRouter = Router();

const MODULES: ModuleId[] = ['transmission', 'aria2', 'webvideo'];
const STATUSES: TaskStatus[] = ['waiting', 'parsing', 'downloading', 'paused', 'archiving', 'encrypting', 'completed', 'failed', 'cancelled'];
/** 批量操作支持的动作（与单个任务的动作一一对应） */
const BULK_ACTIONS = ['pause', 'resume', 'cancel', 'retry', 'delete'] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];

/** 把 query 里的筛选条件解析出来（列表 / 统计 / 批量取 id 共用同一套，避免两套口径） */
function parseFilter(query: Record<string, unknown>): {
  modules?: ModuleId[];
  statuses?: TaskStatus[];
  q?: string;
  kind?: 'download' | 'publish';
} {
  const modules = String(query.module ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ModuleId => MODULES.includes(s as ModuleId));
  const statuses = String(query.status ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is TaskStatus => STATUSES.includes(s as TaskStatus));
  const kindRaw = String(query.kind ?? '');
  const kind = kindRaw === 'download' || kindRaw === 'publish' ? (kindRaw as 'download' | 'publish') : undefined;
  return {
    modules: modules.length ? modules : undefined,
    statuses: statuses.length ? statuses : undefined,
    q: query.q ? String(query.q) : undefined,
    kind,
  };
}

tasksRouter.get('/', (req, res) => {
  const filter = parseFilter(req.query as Record<string, unknown>);
  const page = Number(req.query.page ?? 1) || 1;
  const pageSize = Number(req.query.pageSize ?? 20) || 20;
  const { items, total } = tasksRepo.list({
    ...filter,
    sort: req.query.sort ? String(req.query.sort) : 'created_desc',
    page,
    pageSize,
  });
  // 同一套筛选条件的统计：页面头部用它把 total 解释清楚
  // （BT 的「归档发布」是**子任务**，不算种子下载任务 —— 否则数字永远对不上）
  const summary = tasksRepo.summary(filter);
  res.json({ items, total, page, pageSize, summary });
});

/**
 * 按**当前筛选条件**取出全部任务 id（不分页）。
 *
 * 用途：任务页的「全选」—— 用户要的是"把这一批全暂停/全删除"，
 * 而列表是分页的（每页 20 条），只选当前页会漏掉后面的。
 * ⚠️ 必须注册在 `GET /:id` **之前**，否则 `/ids` 会被当成 id 解析。
 */
tasksRouter.get('/ids', (req, res) => {
  const filter = parseFilter(req.query as Record<string, unknown>);
  const CAP = 5000; // 防呆：一次最多返回 5000 个 id
  const ids: number[] = [];
  let pageNo = 1;
  let total = 0;
  for (;;) {
    const page = tasksRepo.list({ ...filter, sort: 'created_desc', page: pageNo, pageSize: 1000 });
    total = page.total;
    for (const t of page.items) ids.push(Number(t.id));
    if (!page.items.length || ids.length >= total || ids.length >= CAP) break;
    pageNo += 1;
  }
  res.json({ ids, total: ids.length, capped: ids.length >= CAP });
});

tasksRouter.use((req, _res, next) => {
  if (req.method !== 'GET') {
    logger.child('tasks').mark('TASK_STATE', `${req.method} ${req.originalUrl}`, { body: req.body });
  }
  next();
});

/**
 * 批量操作：任务页/历史页的「全选 → 暂停 / 恢复 / 重试 / 取消 / 删除」。
 *
 * 约定（与 BT 种子批量删除一致，前端要能逐条显示结果）：
 *   · **逐条执行、逐条回报**：某一条状态不允许（比如"已完成的任务不能暂停"）
 *     只影响它自己，不会让整批失败；
 *   · 返回 succeeded/failed 计数 + 每条的原因，前端据此给一句话总结。
 */
tasksRouter.post(
  '/actions',
  asyncHandler(async (req, res) => {
    const rawIds: unknown[] = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]) : [];
    const ids: number[] = [
      ...new Set(rawIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)),
    ];
    const action = String(req.body?.action ?? '') as BulkAction;
    if (!ids.length) throw badRequest('请先选择任务（ids 不能为空）', 'EMPTY_IDS');
    if (!BULK_ACTIONS.includes(action)) throw badRequest(`未知操作: ${action}`, 'UNKNOWN_ACTION');

    const results: { id: number; ok: boolean; message?: string }[] = [];
    for (const id of ids) {
      const task = tasksRepo.get(id);
      if (!task) {
        results.push({ id, ok: false, message: '任务不存在（可能已被删除）' });
        continue;
      }
      try {
        switch (action) {
          case 'pause':
            await pauseTask(id);
            break;
          case 'resume':
            await resumeTask(id);
            break;
          case 'cancel':
            await cancelTask(id);
            break;
          case 'retry':
            retryTask(id);
            break;
          case 'delete':
            // 批量删除前先把还在跑/排队的停掉：直接删记录的话，transmission/aria2 里会留下
            // 一个**没人管的孤儿下载**（页面看不见、却一直占带宽和磁盘）。
            if (task.status === 'downloading' || task.status === 'parsing' || task.status === 'waiting') {
              await cancelTask(id).catch(() => undefined);
            }
            deleteTask(id);
            break;
        }
        results.push({ id, ok: true });
      } catch (e) {
        // 单条失败不能打断整批：把原因如实带回去（例如「当前状态「completed」不能暂停」）
        results.push({ id, ok: false, message: (e as Error).message });
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.length - succeeded;
    logger
      .child('tasks')
      .mark('TASK_STATE', `批量操作 ${action}：成功 ${succeeded} / 失败 ${failed}（共 ${ids.length} 个）`, {
        action,
        ids: ids.length,
        succeeded,
        failed,
      });
    kickScheduler();
    res.json({ ok: failed === 0, action, total: ids.length, succeeded, failed, results });
  }),
);

tasksRouter.get('/:id', (req, res) => {
  const task = tasksRepo.get(Number(req.params.id));
  if (!task) throw notFound('任务不存在', 'TASK_NOT_FOUND');
  res.json(task);
});

tasksRouter.post(
  '/:id/actions',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const action = String((req.body ?? {}).action ?? '');
    const task = tasksRepo.get(id);
    if (!task) throw notFound('任务不存在', 'TASK_NOT_FOUND');
    switch (action) {
      case 'pause':
        await pauseTask(id);
        break;
      case 'resume':
        await resumeTask(id);
        break;
      case 'cancel':
        await cancelTask(id);
        break;
      case 'retry':
        retryTask(id);
        break;
      case 'delete':
        deleteTask(id);
        break;
      default:
        throw badRequest(`未知操作: ${action}`, 'UNKNOWN_ACTION');
    }
    kickScheduler();
    res.json({ ok: true });
  }),
);

tasksRouter.get('/status/summary', (_req, res) => {
  const counts: Record<string, number> = {};
  for (const s of STATUSES) {
    counts[s] = tasksRepo.list({ statuses: [s], pageSize: 1 }).total;
  }
  res.json({ counts });
});
