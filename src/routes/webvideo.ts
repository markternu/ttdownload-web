import { Router } from 'express';
import { tasksRepo } from '../core/db';
import { kickScheduler } from '../core/scheduler';
import { logger } from '../core/logger';
import { detectPlatform, parseVideo, supportedPlatforms } from '../modules/webvideo';
import { asyncHandler, badRequest } from '../utils/http';

export const webvideoRouter = Router();

webvideoRouter.get('/platforms', (_req, res) => {
  res.json({ platforms: supportedPlatforms() });
});

webvideoRouter.post(
  '/parse',
  asyncHandler(async (req, res) => {
    const url = String(req.body?.url ?? '').trim();
    if (!url) throw badRequest('请输入视频链接', 'MISSING_URL');
    if (!/^https?:\/\//i.test(url)) throw badRequest('URL 格式错误（仅支持 http/https）', 'INVALID_URL');
    try {
      const result = await parseVideo(url);
      logger.info(`解析成功: ${result.platform} - ${result.title}`);
      res.json(result);
    } catch (e) {
      const message = (e as Error).message;
      logger.warn(`解析失败 ${url}: ${message}`);
      res.status(400).json({ error: { code: 'PARSE_FAILED', message } });
    }
  }),
);

webvideoRouter.post(
  '/tasks',
  asyncHandler(async (req, res) => {
    const url = String(req.body?.url ?? '').trim();
    if (!url || !/^https?:\/\//i.test(url)) throw badRequest('URL 格式错误（仅支持 http/https）', 'INVALID_URL');
    const formatId = req.body?.formatId ? String(req.body.formatId) : '';
    const quality = req.body?.quality ? String(req.body.quality) : '';
    const title = req.body?.title ? String(req.body.title) : url;

    const dup = tasksRepo
      .list({ modules: ['webvideo'], statuses: ['waiting', 'parsing', 'downloading', 'paused', 'archiving', 'encrypting'], pageSize: 200 })
      .items.find((t) => t.url === url && (!formatId || String((t as { payload?: Record<string, unknown> }).payload?.formatId ?? '') === formatId));
    if (dup) {
      res.json({ task: dup, duplicated: true });
      return;
    }

    const task = tasksRepo.create({
      module: 'webvideo',
      title,
      platform: detectPlatform(url),
      url,
      status: 'waiting',
      payload: { formatId, quality },
      meta: { format: null, resolution: quality || null },
    });
    kickScheduler();
    logger.info(`公开视频任务已入队 #${task.id}: ${url}`);
    res.json({ task, duplicated: false });
  }),
);

webvideoRouter.get('/tasks', (_req, res) => {
  const { items, total } = tasksRepo.list({ modules: ['webvideo'], pageSize: 100 });
  res.json({ items, total });
});
