import fs from 'node:fs';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../core/config';
import { filesRepo, tasksRepo } from '../core/db';
import { computeStats } from '../core/db';
import { freeBytes } from '../core/disk';
import { logger } from '../core/logger';
import { cleanupPublished } from '../services/cleanup';
import { getSettings } from '../services/settings';
import { asyncHandler, badRequest, notFound, unauthorized } from '../utils/http';
import type { PublishedFile } from '../types';

export const androidRouter = Router();

/** 安卓端所有请求都留痕（含鉴权失败），便于排查 App 连不上的问题 */
androidRouter.use((req, _res, next) => {
  logger.child('android').mark('ANDROID', `${req.method} ${req.originalUrl}`, {
    token: req.headers['x-auth-token'] ? '(有)' : req.query.token ? '(query)' : '(无)',
    ua: req.headers['user-agent'],
  });
  next();
});

/** 安卓接口鉴权：X-Auth-Token 或 ?token= */
function requireToken(req: Request, _res: Response, next: NextFunction): void {
  const token = config.androidToken;
  if (!token) {
    next(unauthorized('服务端未配置 ANDROID_TOKEN，安卓接口已关闭', 'ANDROID_DISABLED'));
    return;
  }
  const provided = String(req.header('x-auth-token') ?? req.query.token ?? '');
  if (provided !== token) {
    next(unauthorized('token 无效', 'INVALID_TOKEN'));
    return;
  }
  next();
}

androidRouter.use(requireToken);

function toAndroidFile(row: NonNullable<ReturnType<typeof filesRepo.get>>): Omit<PublishedFile, 'downloaded' | 'downloadedAt'> & { url: string } {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    module: row.module,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    downloadUrl: `/api/android/download/${row.id}`,
    url: `/api/android/download/${row.id}?token=${encodeURIComponent(config.androidToken)}`,
  };
}

/** 待下载清单（安卓轮询这个接口） */
androidRouter.get('/files', (req, res) => {
  const page = Number(req.query.page ?? 1) || 1;
  const pageSize = Number(req.query.pageSize ?? 200) || 200;
  const { rows, total, sum } = filesRepo.list({ pendingOnly: true, page, pageSize });
  res.json({
    items: rows.map(toAndroidFile),
    total,
    totalBytes: sum,
    freeBytes: freeBytes(),
    reserveBytes: getSettings().reserveFreeBytes,
  });
});

/** 文件下载（支持 Range 断点续传；token 可用 query，方便 aria2 直接下） */
androidRouter.get(
  '/download/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const file = filesRepo.get(id);
    if (!file) throw notFound('文件不存在', 'FILE_NOT_FOUND');
    if (!fs.existsSync(file.path)) throw notFound('磁盘上的文件已不存在', 'FILE_MISSING');

    const stat = fs.statSync(file.path);
    const range = req.header('range');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file.name)}"`);

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (!m) throw badRequest('Range 头格式错误');
      const start = m[1] ? Number.parseInt(m[1], 10) : 0;
      const end = m[2] ? Number.parseInt(m[2], 10) : stat.size - 1;
      if (start >= stat.size || end >= stat.size || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
        return;
      }
      // 只在第一块（start=0）记一次，避免 aria2 多线程分片把下载次数刷爆
      if (start === 0) {
        filesRepo.trackDownload(id, 'android');
        logger.child('android').mark('FILE_DOWNLOAD', `安卓端开始下载成品文件 #${id}`, { name: file.name, sizeBytes: stat.size });
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      fs.createReadStream(file.path, { start, end }).pipe(res);
      return;
    }

    // 整文件下载（不带 Range）
    filesRepo.trackDownload(id, 'android');
    logger.child('android').mark('FILE_DOWNLOAD', `安卓端开始下载成品文件 #${id}`, { name: file.name, sizeBytes: stat.size });
    res.setHeader('Content-Length', String(stat.size));
    fs.createReadStream(file.path).pipe(res);
  }),
);

/** 上报下载完成：删除服务器文件，腾出空间 */
androidRouter.post(
  '/done',
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const raw = Array.isArray(body.ids) ? body.ids : body.id !== undefined ? [body.id] : [];
    const ids = raw.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n));
    if (ids.length === 0) throw badRequest('请提供 ids（数组）或 id', 'MISSING_IDS');
    const result = cleanupPublished(ids);
    logger.info(`安卓上报完成：${ids.join(',')} → 删除 ${result.deleted} 个，释放 ${(result.freedBytes / 1024 / 1024).toFixed(1)}MB`);
    res.json(result);
  }),
);

/** 状态（App 自检/展示） */
androidRouter.get('/status', (_req, res) => {
  const stats = computeStats();
  return res.json({
    ok: true,
    freeBytes: freeBytes(),
    reserveBytes: getSettings().reserveFreeBytes,
    publishedCount: filesRepo.list({ pageSize: 1 }).total,
    publishedBytes: filesRepo.list({ pageSize: 1 }).sum,
    waitingTasks: tasksRepo.list({ statuses: ['waiting', 'paused'], pageSize: 1 }).total,
    downloadingTasks: stats.downloading,
    version: config.version,
  });
});
