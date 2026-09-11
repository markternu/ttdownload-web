import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../core/config';
import { tasksRepo } from '../core/db';
import { kickScheduler } from '../core/scheduler';
import { logger } from '../core/logger';
import {
  buildDownloadAttempts,
  cookiesPathOf,
  cookiesStatus,
  detectPlatform,
  parseOptionsFromSettings,
  parseVideo,
  resolveCookiesFile,
  supportedPlatforms,
} from '../modules/webvideo';
import { asyncHandler, badRequest } from '../utils/http';

export const webvideoRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

webvideoRouter.get('/platforms', (_req, res) => {
  res.json({ platforms: supportedPlatforms() });
});

/** 网络自检：网页首页「网络自检」面板用（DNS/HTTPS/yt-dlp/YouTube/CDN/RPC） */
webvideoRouter.get(
  '/network',
  asyncHandler(async (req, res) => {
    const { networkReport } = await import('../services/netCheck');
    const force = String(req.query.refresh ?? '') === '1' || String(req.query.refresh ?? '') === 'true';
    res.json(await networkReport(force));
  }),
);

/* ---------------- cookies（会员 / 登录 / 年龄限制视频） ---------------- */

webvideoRouter.get(
  '/cookies',
  asyncHandler(async (_req, res) => {
    res.json(await cookiesStatus());
  }),
);

/** 上传 cookies.txt：支持 multipart(file) 或 JSON/文本体（text 字段） */
webvideoRouter.post(
  '/cookies',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { text?: string };
    const content = req.file?.buffer?.toString('utf8') ?? (typeof body.text === 'string' ? body.text : '');
    if (!content.trim()) throw badRequest('cookies 内容为空：请上传 Netscape 格式的 cookies.txt', 'EMPTY_COOKIES');
    const { getSettings } = await import('../services/settings');
    const target = cookiesPathOf(getSettings());
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { mode: 0o600 });
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      /* ignore */
    }
    logger.info(`已保存公开视频 cookies：${target}（${content.length} 字节）`);
    res.json(await cookiesStatus());
  }),
);

webvideoRouter.delete(
  '/cookies',
  asyncHandler(async (_req, res) => {
    const { getSettings } = await import('../services/settings');
    const target = cookiesPathOf(getSettings());
    try {
      fs.unlinkSync(target);
      logger.info(`已删除公开视频 cookies：${target}`);
    } catch {
      /* 本来就不存在 */
    }
    res.json(await cookiesStatus());
  }),
);

/** 预览本次任务会按什么顺序去尝试（便于排查） */
webvideoRouter.get('/attempts', (req, res) => {
  const url = String(req.query.url ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  res.json({
    attempts: buildDownloadAttempts({
      formatId: String(req.query.formatId ?? ''),
      cookiesFile: resolveCookiesFile(),
      cookiesFromBrowser: '',
      isYouTube: detectPlatform(url) === 'YouTube',
    }).map((a) => a.label),
  });
});

webvideoRouter.post(
  '/parse',
  asyncHandler(async (req, res) => {
    const url = String(req.body?.url ?? '').trim();
    if (!url) throw badRequest('请输入视频链接', 'MISSING_URL');
    if (!/^https?:\/\//i.test(url)) throw badRequest('URL 格式错误（仅支持 http/https）', 'INVALID_URL');
    try {
      const { getSettings } = await import('../services/settings');
      const result = await parseVideo(url, config.bins.ytdlp, 60000, parseOptionsFromSettings(getSettings()));
      logger.info(`解析成功: ${result.platform} - ${result.title}`);
      res.json(result);
    } catch (e) {
      // 解析失败不阻断用户：返回 degraded 结果（前端可以“仍然下载”），
      // 真正能不能下交给下载时的多重策略去试。
      const message = (e as Error).message;
      logger.warn(`解析失败 ${url}: ${message}`);
      res.json({
        degraded: true,
        parseError: message,
        platform: detectPlatform(url),
        title: url,
        thumbnail: null,
        durationSec: null,
        author: null,
        formats: [],
        defaultFormatId: null,
        expectedBytes: 0,
      });
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
    logger.child('webvideo').mark('TASK_CREATE', `公开视频任务已入队 #${task.id}`, {
      url,
      formatId: formatId || '(默认)',
      quality: quality || undefined,
      title,
    });
    res.json({ task, duplicated: false });
  }),
);

webvideoRouter.get('/tasks', (_req, res) => {
  const { items, total } = tasksRepo.list({ modules: ['webvideo'], pageSize: 100 });
  res.json({ items, total });
});
