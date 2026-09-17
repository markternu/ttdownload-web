import { Router } from 'express';
import { tasksRepo } from '../core/db';
import { cancelTask, deleteTask, pauseTask, resumeTask, retryTask, kickScheduler } from '../core/scheduler';
import { asyncHandler, badRequest, notFound } from '../utils/http';
import { logger } from '../core/logger';
import type { ModuleId, TaskStatus } from '../types';

export const tasksRouter = Router();

const MODULES: ModuleId[] = ['transmission', 'aria2', 'webvideo'];
const STATUSES: TaskStatus[] = ['waiting', 'parsing', 'downloading', 'paused', 'archiving', 'encrypting', 'completed', 'failed', 'cancelled'];

tasksRouter.get('/', (req, res) => {
  const modules = String(req.query.module ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ModuleId => MODULES.includes(s as ModuleId));
  const statuses = String(req.query.status ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is TaskStatus => STATUSES.includes(s as TaskStatus));
  const kindRaw = String(req.query.kind ?? '');
  const kind = kindRaw === 'download' || kindRaw === 'publish' ? (kindRaw as 'download' | 'publish') : undefined;
  const page = Number(req.query.page ?? 1) || 1;
  const pageSize = Number(req.query.pageSize ?? 20) || 20;
  const filter = {
    modules: modules.length ? modules : undefined,
    statuses: statuses.length ? statuses : undefined,
    q: req.query.q ? String(req.query.q) : undefined,
    kind,
  };
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

tasksRouter.use((req, _res, next) => {
  if (req.method !== 'GET') {
    logger.child('tasks').mark('TASK_STATE', `${req.method} ${req.originalUrl}`, { body: req.body });
  }
  next();
});

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
