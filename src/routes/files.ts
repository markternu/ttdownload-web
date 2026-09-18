import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { config } from '../core/config';
import { filesRepo } from '../core/db';
import { deletePublished } from '../services/cleanup';
import { logger } from '../core/logger';
import { asyncHandler, notFound, streamFileTo } from '../utils/http';
import type { PublishedFile } from '../types';

export const filesRouter = Router();

function toApi(row: NonNullable<ReturnType<typeof filesRepo.get>>): PublishedFile {
  const createdMs = Date.parse(row.created_at);
  // 安卓端上报完成后服务器会删掉成品文件，但**数据库记录会留着**（作为历史）。
  // 于是「已发布文件」页会列出一堆磁盘上已经不存在的文件 —— 点下载只会 404。
  // 这里明确告诉前端：文件还在不在，前端据此把下载按钮置灰并标注。
  let available = false;
  try {
    available = fs.existsSync(row.path) && fs.statSync(row.path).isFile();
  } catch {
    available = false;
  }
  return {
    available,
    id: row.id,
    name: row.name,
    title: row.title,
    module: row.module,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    // 管理端下载（本页面按钮走这个，不鉴权、便于排障）
    downloadUrl: `/api/files/${row.id}/download`,
    // 安卓端下载（需要 X-Auth-Token；App 自己会用这个地址）
    androidDownloadUrl: `/api/android/download/${row.id}`,
    downloaded: !!row.downloaded,
    downloadedAt: row.downloaded_at,
    androidDownloads: row.android_downloads ?? 0,
    lastAndroidDownloadAt: row.last_android_download_at ?? null,
    webDownloads: row.web_downloads ?? 0,
    lastWebDownloadAt: row.last_web_download_at ?? null,
    waitingSec: Number.isFinite(createdMs) ? Math.max(0, Math.round((Date.now() - createdMs) / 1000)) : 0,
  };
}

filesRouter.get('/', (req, res) => {
  const page = Number(req.query.page ?? 1) || 1;
  const pageSize = Number(req.query.pageSize ?? 20) || 20;
  const { rows, total, sum } = filesRepo.list({
    q: req.query.q ? String(req.query.q) : undefined,
    page,
    pageSize,
  });
  res.json({ items: rows.map(toApi), total, totalBytes: sum, page, pageSize });
});

/**
 * 待下载清单：**已下载成功、已加密归档，但安卓端还没取走/还没上报完成**的成品。
 * 这些文件就躺在消费者目录里，页面提供下载按钮（管理端下载），也可以看到安卓端是否已取过。
 */
filesRouter.get('/pending', (req, res) => {
  const page = Number(req.query.page ?? 1) || 1;
  const pageSize = Number(req.query.pageSize ?? 50) || 50;
  const { rows, total, sum } = filesRepo.pending({
    q: req.query.q ? String(req.query.q) : undefined,
    page,
    pageSize,
  });
  const items = rows.map(toApi);
  const oldest = items.reduce<number>((acc, f) => Math.max(acc, f.waitingSec ?? 0), 0);
  res.json({
    items,
    total,
    totalBytes: sum,
    oldestWaitingSec: total > 0 ? oldest : 0,
    generatedAt: new Date().toISOString(),
  });
});

filesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const withFile = String(req.query.withFile ?? '0') === '1' || req.query.withFile === 'true';
    const result = deletePublished(id, withFile);
    if (!result.ok) throw notFound(result.error ?? '删除失败');
    res.json(result);
  }),
);

/** 管理端下载（不鉴权，便于排障；安卓走 /api/android/download/:id） */
filesRouter.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const file = filesRepo.get(id);
    if (!file) throw notFound('文件不存在');
    if (!fs.existsSync(file.path)) throw notFound('磁盘上的文件已不存在');
    filesRepo.trackDownload(id, 'web');
    logger.child('files').mark('FILE_DOWNLOAD', `网页端下载成品文件 #${id}`, {
      name: file.name,
      sizeBytes: file.size_bytes,
      path: file.path,
    });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file.name)}"`);
    res.setHeader('Content-Length', String(fs.statSync(file.path).size));
    streamFileTo(res, file.path);
  }),
);

/** 磁盘上存在但 DB 没记录的孤儿文件（排障用） */
filesRouter.get('/orphans', (_req, res) => {
  const rows = filesRepo.list({ pageSize: 1000 }).rows;
  const known = new Set(rows.map((r) => path.basename(r.path)));
  const orphans: string[] = [];
  try {
    for (const name of fs.readdirSync(config.dirs.consumer)) {
      if (name.startsWith('.')) continue;
      if (!known.has(name)) orphans.push(name);
    }
  } catch {
    /* ignore */
  }
  res.json({ orphans });
});
