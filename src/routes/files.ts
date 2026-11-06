import fs from 'node:fs';
import { workDirs } from '../services/usbMount';
import path from 'node:path';
import { Router } from 'express';
import { config } from '../core/config';
import { filesRepo } from '../core/db';
import { deletePublished } from '../services/cleanup';
import { getPlayItem, getPlayJob, playStatusByFile, preparePlayItem, preparePlayable, publicPlayJob } from '../services/player';
import { maskFields } from '../services/mask';
import { logger } from '../core/logger';
import { asyncHandler, badRequest, notFound, streamFileTo } from '../utils/http';
import { tarEnd, tarHeader, tarPadding } from '../utils/tar';
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

/**
 * 已发布文件清单。
 * 「已发布」与「待下载」是**同一张表的两个视图**（待下载 = downloaded=0），所以合并成一个列表页，
 * 用 `status` 参数筛选：all（默认）/ pending（待下载）/ downloaded（已被取走）。
 */
filesRouter.get('/', (req, res) => {
  const page = Number(req.query.page ?? 1) || 1;
  const pageSize = Number(req.query.pageSize ?? 20) || 20;
  const status = String(req.query.status ?? 'all');
  const { rows, total, sum } = filesRepo.list({
    q: req.query.q ? String(req.query.q) : undefined,
    page,
    pageSize,
    pendingOnly: status === 'pending',
    downloadedOnly: status === 'downloaded',
  });
  // 隐私开关：只隐藏**原始下载名**（title）；加密归档名（name，如 wrh2）一直可见
  const playMap = playStatusByFile();
  const items = rows.map((r) => ({ ...toApi(r), playStatus: playMap.get(r.id) ?? null }));
  res.json({ items: maskFields(items as unknown as Record<string, unknown>[], ['title']), total, totalBytes: sum, page, pageSize, status, counts: filesRepo.counts() });
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
  // 同样只隐藏原始名，加密归档名不隐藏
  const playMap = playStatusByFile();
  const items = maskFields(
    rows.map((r) => ({ ...toApi(r), playStatus: playMap.get(r.id) ?? null })) as unknown as Record<string, unknown>[],
    ['title'],
  );
  const oldest = items.reduce<number>((acc, f) => Math.max(acc, Number(f.waitingSec ?? 0)), 0);
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

/** 批量删除一次最多处理多少个（列表页分页最大 500，留点余量） */
export const BULK_DELETE_MAX = 500;

/**
 * 批量删除（列表页「全选当前页 → 全部删除」用）。
 *
 * 为什么不在前端循环调 DELETE /:id：① 一次请求就能拿到汇总结果；② 单个失败不影响其它，
 * 失败原因逐条回给用户；③ 危险操作的上限与参数校验应该由后端把住，而不是只靠前端自觉。
 */
filesRouter.post(
  '/bulk-delete',
  asyncHandler(async (req, res) => {
    const raw: unknown[] = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]) : [];
    const ids: number[] = [
      ...new Set(raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)),
    ];
    if (!ids.length) throw badRequest('请提供要删除的文件 id 列表', 'MISSING_IDS');
    if (ids.length > BULK_DELETE_MAX) {
      throw badRequest(`一次最多删除 ${BULK_DELETE_MAX} 个文件（收到 ${ids.length} 个）`, 'TOO_MANY_IDS');
    }
    const withFile = req.body?.withFile === true || String(req.body?.withFile ?? '') === '1';

    const failed: { id: number; error: string }[] = [];
    let deleted = 0;
    let deletedFiles = 0;
    for (const id of ids) {
      const r = deletePublished(id, withFile);
      if (r.ok) {
        deleted += 1;
        if (r.deletedFile) deletedFiles += 1;
      } else {
        failed.push({ id, error: r.error ?? '删除失败' });
      }
    }
    logger.child('files').mark(
      'FILE_DELETE',
      `批量删除成品文件：请求 ${ids.length} 个，成功 ${deleted} 个${withFile ? '（含磁盘文件）' : '（仅记录）'}`,
      { requested: ids.length, deleted, deletedFiles, failed: failed.length, withFile },
    );
    res.json({ ok: failed.length === 0, requested: ids.length, deleted, deletedFiles, withFile, failed });
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

/**
 * 批量下载（全选 →「全部下载」）：把选中的成品**流式打成一个 tar**，一次连接下完。
 *
 * 为什么必须打包：浏览器对"同一个站点同时下载几个"有硬限制（Chrome 约 6 个），
 * 一个一个点，点到第 7 个就得排队等前面的下完 —— 那是浏览器连接池的限制，
 * 服务端加多少并发都没用。打成一个包 → 只用一条连接 → **没有数量限制**。
 *
 * ⚠️ 必须注册在 `GET /:id/download` 之前，否则 "bulk-download" 会被当成 id 解析。
 */
filesRouter.get(
  '/bulk-download',
  asyncHandler(async (req, res) => {
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) throw badRequest('请先选择文件（ids 不能为空）', 'EMPTY_IDS');
    if (ids.length > 500) throw badRequest('一次最多打包 500 个文件', 'TOO_MANY_IDS');

    const picked: { id: number; name: string; path: string; size: number }[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const file = filesRepo.get(id);
      if (!file || !fs.existsSync(file.path)) {
        missing.push(file?.name ?? `#${id}`);
        continue;
      }
      picked.push({ id, name: path.basename(file.name || `file-${id}`), path: file.path, size: fs.statSync(file.path).size });
    }
    if (!picked.length) throw notFound('选中的文件在磁盘上都不存在了（可能已被安卓端取走）', 'NO_FILES');

    const total = picked.reduce((sum, f) => sum + f.size, 0);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    logger.child('files').mark('FILE_DOWNLOAD', `网页端批量打包下载 ${picked.length} 个文件（${(total / 1024 ** 2).toFixed(1)} MiB）`, {
      ids: picked.map((f) => f.id),
      skipped: missing.length,
    });
    for (const f of picked) filesRepo.trackDownload(f.id, 'web');

    res.setHeader('Content-Type', 'application/x-tar');
    res.setHeader('Content-Disposition', `attachment; filename="ttdownload-${stamp}.tar"`);
    // 长度可算：每个文件 512 头 + 数据 + 填充，末尾 1024 字节结束块
    res.setHeader(
      'Content-Length',
      String(picked.reduce((sum, f) => sum + 512 + f.size + tarPadding(f.size), 0) + 1024),
    );
    res.setHeader('X-Bulk-Files', String(picked.length));
    if (missing.length) res.setHeader('X-Bulk-Skipped', String(missing.length));

    try {
      for (const f of picked) {
        if (res.writableEnded) break;
        res.write(tarHeader(f.name, f.size));
        await new Promise<void>((resolve, reject) => {
          const src = fs.createReadStream(f.path, { highWaterMark: 1 << 20 });
          const onClose = (): void => {
            src.destroy();
          };
          res.once('close', onClose);
          src.on('error', reject);
          src.on('data', (chunk) => {
            if (!res.write(chunk)) src.pause();
          });
          res.on('drain', () => src.resume());
          src.on('end', () => {
            res.off('close', onClose);
            const pad = tarPadding(f.size);
            if (pad) res.write(Buffer.alloc(pad));
            resolve();
          });
        });
      }
      res.end(tarEnd());
    } catch (e) {
      logger.child('files').warn(`批量打包下载中断：${(e as Error).message}`);
      res.destroy();
    }
  }),
);

/** 磁盘上存在但 DB 没记录的孤儿文件（排障用） */
filesRouter.get('/orphans', (_req, res) => {
  const rows = filesRepo.list({ pageSize: 1000 }).rows;
  const known = new Set(rows.map((r) => path.basename(r.path)));
  const orphans: string[] = [];
  try {
    for (const name of fs.readdirSync(workDirs().consumer)) {
      if (name.startsWith('.')) continue;
      if (!known.has(name)) orphans.push(name);
    }
  } catch {
    /* ignore */
  }
  res.json({ orphans });
});


/* ------------------------------------------------------------------ */
/*  播放器：加密归档 → 解密 →（zip 解压）→（重封装 mp4+faststart）→ 流     */
/* ------------------------------------------------------------------ */

/** 开始准备播放（后台解密/解压/重封装，立即返回 job） */
filesRouter.post(
  '/:id/play',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const r = preparePlayable(id);
    if (!r.ok) throw badRequest(r.error, r.code);
    res.json(publicPlayJob(r.job));
  }),
);

/** 查询播放准备进度 */
filesRouter.get(
  '/play/status/:jobId',
  asyncHandler(async (req, res) => {
    const j = getPlayJob(String(req.params.jobId));
    if (!j) throw notFound('播放任务不存在或已过期', 'PLAY_JOB_NOT_FOUND');
    res.json(publicPlayJob(j));
  }),
);

/** 播放列表里某个视频还没转好时，点它就开始转（幂等） */
filesRouter.post(
  '/play/prepare-item',
  asyncHandler(async (req, res) => {
    const jobId = String(req.body?.jobId ?? '');
    const index = Number(req.body?.index ?? NaN);
    if (!jobId || !Number.isFinite(index)) throw badRequest('缺少 jobId / index', 'MISSING_PARAM');
    const item = preparePlayItem(jobId, index);
    if (!item) throw notFound('播放任务或视频不存在', 'PLAY_ITEM_NOT_FOUND');
    res.json({
      index: item.index,
      name: item.name,
      sizeBytes: item.sizeBytes,
      state: item.state,
      ready: item.state === 'ready',
      error: item.error,
    });
  }),
);

/**
 * 播放流（支持 Range，给 <video> 边下边播/拖进度条）；index = 播放列表第几个。
 * · 兼容 `0` 与 `0.mp4` 两种写法（Safari 对没有扩展名的视频 URL 更挑剔）
 * · 兼容旧的 `/play/stream/:jobId`（老缓存前端可能还在用）→ 默认第 0 个
 */
async function streamPlay(req: import('express').Request, res: import('express').Response): Promise<void> {
  {
    const jobId = String(req.params.jobId);
    const index = Number.parseInt(String(req.params.index ?? '0'), 10) || 0;
    const j = getPlayJob(jobId);
    if (!j) throw notFound('播放任务不存在或已过期', 'PLAY_JOB_NOT_FOUND');
    const item = getPlayItem(jobId, index);
    if (!item) throw notFound('视频不在播放列表里', 'PLAY_ITEM_NOT_FOUND');
    if (item.state !== 'ready' || !item.playPath || !fs.existsSync(item.playPath)) {
      throw badRequest('这个视频还没准备好，请稍后再试', 'NOT_READY');
    }
    j.touchedAt = Date.now();
    const stat = fs.statSync(item.playPath);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');

    const range = req.header('range');
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (!m) throw badRequest('Range 头格式错误');
      const start = m[1] ? Number.parseInt(m[1], 10) : 0;
      const end = m[2] ? Number.parseInt(m[2], 10) : stat.size - 1;
      if (start >= stat.size || end >= stat.size || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      streamFileTo(res, item.playPath, { start, end });
      return;
    }
    res.setHeader('Content-Length', String(stat.size));
    streamFileTo(res, item.playPath);
  }
}
filesRouter.get('/play/stream/:jobId', asyncHandler(streamPlay));
filesRouter.get('/play/stream/:jobId/:index', asyncHandler(streamPlay));

/* ------------------------------------------------------------------ */
/*  VLC：原始流（不转封装）                                              */
/* ------------------------------------------------------------------ */

/** 常见容器的 Content-Type（VLC 主要靠内容嗅探，这里只是给浏览器/客户端一个提示） */
const RAW_CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mov': 'video/quicktime',
  '.wmv': 'video/x-ms-wmv',
  '.rmvb': 'application/vnd.rn-realmedia-vbr',
  '.rm': 'application/vnd.rn-realmedia',
  '.3gp': 'video/3gpp',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.vob': 'video/dvd',
  '.ogv': 'video/ogg',
};

/**
 * VLC 用的**原始流**：直接发解密/解压出来的原文件（mkv/avi/hevc… 都行），
 * 不做 ffmpeg 转封装 —— VLC 这些格式全都能播。
 * `?token=` 用于让 VLC（没有登录 cookie）通过 /api 的鉴权。
 */
async function streamRaw(req: import('express').Request, res: import('express').Response): Promise<void> {
  const jobId = String(req.params.jobId);
  const index = Number.parseInt(String(req.params.index ?? '0'), 10) || 0;
  const j = getPlayJob(jobId);
  if (!j) throw notFound('播放任务不存在或已过期', 'PLAY_JOB_NOT_FOUND');
  const item = getPlayItem(jobId, index);
  if (!item) throw notFound('视频不在播放列表里', 'PLAY_ITEM_NOT_FOUND');
  if (j.state !== 'ready') throw badRequest('还没准备好，请稍后再试', 'NOT_READY');
  if (!fs.existsSync(item.srcPath)) throw notFound('原始文件不存在', 'FILE_MISSING');

  j.touchedAt = Date.now();
  const stat = fs.statSync(item.srcPath);
  const ext = path.extname(item.name).toLowerCase();
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', RAW_CONTENT_TYPES[ext] ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(item.name)}`);
  res.setHeader('Cache-Control', 'no-store');

  const range = req.header('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (!m) throw badRequest('Range 头格式错误');
    const start = m[1] ? Number.parseInt(m[1], 10) : 0;
    const end = m[2] ? Number.parseInt(m[2], 10) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    streamFileTo(res, item.srcPath, { start, end });
    return;
  }
  res.setHeader('Content-Length', String(stat.size));
  streamFileTo(res, item.srcPath);
}
filesRouter.get('/play/raw/:jobId', asyncHandler(streamRaw));
filesRouter.get('/play/raw/:jobId/:index', asyncHandler(streamRaw));

/** 给前端拿"用 VLC 播放"的地址（自动带上访问 token，VLC 免登录） */
filesRouter.post(
  '/play/vlc',
  asyncHandler(async (req, res) => {
    const jobId = String(req.body?.jobId ?? '');
    const index = Number(req.body?.index ?? 0) || 0;
    const j = getPlayJob(jobId);
    if (!j) throw notFound('播放任务不存在或已过期', 'PLAY_JOB_NOT_FOUND');
    const item = getPlayItem(jobId, index);
    if (!item) throw notFound('视频不在播放列表里', 'PLAY_ITEM_NOT_FOUND');

    const token = config.androidToken;
    const origin = `${req.protocol}://${req.get('host')}`;
    const q = token ? `?token=${encodeURIComponent(token)}` : '';
    const url = `${origin}/api/files/play/raw/${encodeURIComponent(jobId)}/${index}${q}`;
    const m3u = `${origin}/api/files/play/vlc.m3u?jobId=${encodeURIComponent(jobId)}&index=${index}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    res.json({ url, m3u, name: item.name });
  }),
);

/** .m3u 播放列表（手机上点一下交给 VLC / 其它播放器打开） */
filesRouter.get(
  '/play/vlc.m3u',
  asyncHandler(async (req, res) => {
    const jobId = String(req.query.jobId ?? '');
    const index = Number.parseInt(String(req.query.index ?? '0'), 10) || 0;
    const j = getPlayJob(jobId);
    if (!j) throw notFound('播放任务不存在或已过期', 'PLAY_JOB_NOT_FOUND');
    const item = getPlayItem(jobId, index);
    if (!item) throw notFound('视频不在播放列表里', 'PLAY_ITEM_NOT_FOUND');

    const token = String(req.query.token ?? '') || config.androidToken;
    const origin = `${req.protocol}://${req.get('host')}`;
    const q = token ? `?token=${encodeURIComponent(token)}` : '';
    const url = `${origin}/api/files/play/raw/${encodeURIComponent(jobId)}/${index}${q}`;
    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ttdownload-vlc.m3u"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(`#EXTM3U\n#EXTINF:-1,${item.name.replace(/\r?\n/g, ' ')}\n${url}\n`);
  }),
);
