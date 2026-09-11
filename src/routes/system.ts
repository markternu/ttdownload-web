import { Router } from 'express';
import { config, DIRS } from '../core/config';
import { dbFileSize, computeStats, logsRepo } from '../core/db';
import { dirUsage, freeBytes, statfsBytes, toolStatus, usableBytes } from '../core/disk';
import { bus } from '../core/events';
import { getSettingsPublic, updateSettings } from '../services/settings';
import { kickScheduler } from '../core/scheduler';
import { asyncHandler, badRequest } from '../utils/http';
import type { Settings } from '../types';

export const systemRouter = Router();

const startedAt = Date.now();

systemRouter.get('/health', (_req, res) => {
  res.json({ ok: true, version: config.version, uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
});

systemRouter.get(
  '/system',
  asyncHandler(async (_req, res) => {
    const settings = getSettingsPublic();
    const sf = statfsBytes(DIRS.root);
    const [aria2, transmission, ytdlp, ffmpeg, openssl] = await Promise.all([
      toolStatus(config.bins.aria2, ['--version']),
      toolStatus(config.bins.transmission, ['--version']),
      toolStatus(config.bins.ytdlp, ['--version']),
      toolStatus(config.bins.ffmpeg, ['-version']),
      toolStatus(config.bins.openssl, ['version']),
    ]);
    res.json({
      disk: {
        path: DIRS.root,
        totalBytes: sf.total,
        freeBytes: sf.free,
        usedBytes: sf.total - sf.free,
        reserveBytes: settings.reserveFreeBytes,
        usableBytes: usableBytes(settings.reserveFreeBytes),
      },
      db: { path: config.dbPath, sizeBytes: dbFileSize(), ok: true },
      dirs: DIRS as unknown as Record<string, string>,
      tools: { aria2, transmission, ytdlp, ffmpeg, openssl },
      version: config.version,
      node: process.version,
      usage: {
        archiveReady: dirUsage(DIRS.archiveReady),
        consumer: dirUsage(DIRS.consumer),
        aria2: dirUsage(DIRS.aria2),
      },
    });
  }),
);

systemRouter.get('/stats', (_req, res) => {
  res.json(computeStats());
});

systemRouter.get('/logs', (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200)));
  res.json({ items: logsRepo.recent(limit) });
});

systemRouter.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const onTask = (task: unknown): void => send('task', task);
  const onStats = (stats: unknown): void => send('stats', stats);
  const onFile = (payload: unknown): void => send('file', payload);
  const onLog = (entry: unknown): void => send('log', entry);
  const onSpace = (payload: unknown): void => send('space', payload);

  bus.on('task', onTask);
  bus.on('stats', onStats);
  bus.on('file', onFile);
  bus.on('log', onLog);
  bus.on('space-freed', onSpace);

  const statsTimer = setInterval(() => send('stats', computeStats()), 5000);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(statsTimer);
    clearInterval(ping);
    bus.off('task', onTask);
    bus.off('stats', onStats);
    bus.off('file', onFile);
    bus.off('log', onLog);
    bus.off('space-freed', onSpace);
    res.end();
  });
});

systemRouter.get('/settings', (_req, res) => {
  res.json(getSettingsPublic());
});

systemRouter.put(
  '/settings',
  asyncHandler(async (req, res) => {
    const patch = req.body as Partial<Settings>;
    if (typeof patch !== 'object' || patch === null) throw badRequest('设置内容必须是对象');
    const allowed = [
      'maxConcurrent',
      'defaultQuality',
      'defaultFormat',
      'reserveFreeBytes',
      'maxSpeedBps',
      'requestTimeoutSec',
      'autoRetry',
      'theme',
      'encryptPassword',
      'moduleConcurrency',
      'aria2Rpc',
      'transmissionRpc',
      'ytdlpPath',
      'ffmpegPath',
      'transcodeQuality',
      'webvideoCookiesFile',
      'webvideoCookiesFromBrowser',
      'webvideoExtraArgs',
      'autoDeleteAfterReport',
      'btEvict',
    ];
    const clean: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in patch) clean[key] = (patch as Record<string, unknown>)[key];
    }
    const next = updateSettings(clean as Partial<Settings>);
    kickScheduler();
    res.json({ ...next, encryptPassword: next.encryptPassword ? '******' : '' });
  }),
);

systemRouter.post(
  '/settings/test-connection',
  asyncHandler(async (req, res) => {
    const tool = String((req.body ?? {}).tool ?? '');
    const settings = getSettingsPublic();
    if (tool === 'aria2') {
      const { aria2Client } = await import('../modules/aria2Client');
      try {
        const v = await aria2Client().version();
        res.json({ ok: true, message: `aria2 RPC 正常（版本 ${v}）` });
      } catch (e) {
        res.json({ ok: false, message: `aria2 RPC 不可用：${(e as Error).message}` });
      }
      return;
    }
    if (tool === 'transmission') {
      const { transmissionClient } = await import('../modules/transmission');
      const ok = await transmissionClient().ping();
      res.json({ ok, message: ok ? 'transmission RPC 正常' : 'transmission RPC 不可用（请检查 daemon 是否启动）' });
      return;
    }
    if (tool === 'ytdlp') {
      const st = await toolStatus(settings.ytdlpPath || config.bins.ytdlp, ['--version']);
      res.json({ ok: st.ok, message: st.ok ? `yt-dlp 正常（${st.version}）` : `yt-dlp 不可用：${st.error}` });
      return;
    }
    throw badRequest('未知的检测目标');
  }),
);

systemRouter.get('/free-space', (_req, res) => {
  const settings = getSettingsPublic();
  res.json({ freeBytes: freeBytes(), reserveBytes: settings.reserveFreeBytes, usableBytes: usableBytes(settings.reserveFreeBytes) });
});
