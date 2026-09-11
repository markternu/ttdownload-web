import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { config } from '../core/config';
import { filesRepo } from '../core/db';
import { deletePublished } from '../services/cleanup';
import { asyncHandler, notFound } from '../utils/http';
import type { PublishedFile } from '../types';

export const filesRouter = Router();

function toApi(row: NonNullable<ReturnType<typeof filesRepo.get>>): PublishedFile {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    module: row.module,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    downloadUrl: `/api/android/download/${row.id}`,
    downloaded: !!row.downloaded,
    downloadedAt: row.downloaded_at,
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
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file.name)}"`);
    res.setHeader('Content-Length', String(fs.statSync(file.path).size));
    fs.createReadStream(file.path).pipe(res);
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
