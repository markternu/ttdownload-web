import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../core/config';
import { seedsRepo, tasksRepo } from '../core/db';
import { kickScheduler } from '../core/scheduler';
import { logger } from '../core/logger';
import { enqueueSeed, registerPendingSeeds, scanZipUploads, transmissionClient } from '../modules/transmission';
import { runBtEvict } from '../services/btEvict';
import { asyncHandler, badRequest, notFound } from '../utils/http';

export const btRouter = Router();

fs.mkdirSync(config.dirs.btZip, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.dirs.btZip),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[\\/]/g, '_');
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 512 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/\.zip$/i.test(file.originalname)) {
      cb(new Error('只支持上传 .zip 种子压缩包'));
      return;
    }
    cb(null, true);
  },
});

btRouter.post(
  '/upload',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('未收到上传文件（字段名应为 file）');
    logger.info(`收到种子 zip 上传: ${req.file.filename}（${req.file.size} 字节）`);
    const extracted = await scanZipUploads();
    registerPendingSeeds();
    const seeds = seedsRepo.all();
    res.json({ zipName: req.file.filename, extracted, seeds });
  }),
);

btRouter.get('/seeds', (_req, res) => {
  registerPendingSeeds();
  res.json({ items: seedsRepo.all() });
});

btRouter.post(
  '/seeds/actions',
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n)) : [];
    const action = String(req.body?.action ?? '');
    if (ids.length === 0) throw badRequest('请选择种子');
    const results: { id: number; ok: boolean; message?: string; taskId?: number }[] = [];
    for (const id of ids) {
      const seed = seedsRepo.get(id);
      if (!seed) {
        results.push({ id, ok: false, message: '种子不存在' });
        continue;
      }
      if (action === 'enqueue') {
        const task = enqueueSeed(seed);
        results.push({ id, ok: true, taskId: task.id });
      } else if (action === 'delete') {
        // 删除种子记录 + 文件（若仍在待下载目录）
        if (seed.path.startsWith(config.dirs.btPending)) {
          fs.rmSync(seed.path, { force: true });
        }
        seedsRepo.delete(id);
        results.push({ id, ok: true });
      } else if (action === 'refresh') {
        registerPendingSeeds();
        results.push({ id, ok: true });
      } else {
        throw badRequest(`未知操作: ${action}`);
      }
    }
    kickScheduler();
    res.json({ ok: true, results, items: seedsRepo.all() });
  }),
);

btRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    let version: string | null = null;
    try {
      const s = await transmissionClient().call<{ version?: string }>('session-get', {}, 4000);
      version = s?.version ?? 'unknown';
    } catch {
      version = null;
    }
    res.json({
      running: version !== null,
      rpc: { host: config.transmissionRpc.host, port: config.transmissionRpc.port },
      version,
      pendingSeeds: seedsRepo.all().filter((s) => s.status === 'pending').length,
      dirs: { zip: config.dirs.btZip, pending: config.dirs.btPending, queued: config.dirs.btQueued },
    });
  }),
);

btRouter.delete(
  '/seeds/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const seed = seedsRepo.get(id);
    if (!seed) throw notFound('种子不存在');
    if (seed.path.startsWith(config.dirs.btPending)) fs.rmSync(seed.path, { force: true });
    seedsRepo.delete(id);
    res.json({ ok: true });
  }),
);

/** BT 出清：预览将要被清理/挽救的任务（dry-run，不修改任何数据） */
btRouter.get(
  '/stale',
  asyncHandler(async (_req, res) => {
    const summary = await runBtEvict({ dryRun: true });
    res.json(summary);
  }),
);

/** BT 出清：立即执行一次（手动触发） */
btRouter.post(
  '/evict',
  asyncHandler(async (_req, res) => {
    const summary = await runBtEvict({ dryRun: false });
    kickScheduler();
    res.json(summary);
  }),
);

/** 该模块任务列表（便于前端单独展示） */
btRouter.get('/tasks', (_req, res) => {
  const { items, total } = tasksRepo.list({ modules: ['transmission'], pageSize: 100 });
  res.json({ items, total });
});
