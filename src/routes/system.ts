import path from 'node:path';
import { Router, type RequestHandler } from 'express';
import { config, DIRS } from '../core/config';
import { dbFileSize, computeStats, logsRepo } from '../core/db';
import { dirUsage, freeBytes, statfsBytes, toolStatus, usableBytes } from '../core/disk';
import { bus } from '../core/events';
import { getSettingsPublic, updateSettings } from '../services/settings';
import {
  clearLogs,
  listLogFiles,
  logger,
  readLogFile,
  tailLogs,
  type LogLevel,
} from '../core/logger';
import { tasksRepo } from '../core/db';
import { networkReport } from '../services/netCheck';
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

/** 日志状态（网页「日志」页顶部信息） */
function logsStatus(): {
  file: string;
  dir: string;
  files: { name: string; sizeBytes: number; mtime: string }[];
  debugMode: boolean;
  logLevel: LogLevel;
  markers: { marker: string; description: string }[];
  usedMarkers: string[];
} {
  const file = logger.filePath();
  return {
    file,
    dir: path.dirname(file),
    files: listLogFiles(),
    debugMode: logger.isDebug(),
    logLevel: logger.getLevel(),
    markers: logger.markers(),
    usedMarkers: logger.usedMarkers(),
  };
}

/**
 * 读取日志：文件尾部（lines，最新在最后）+ 数据库结构化事件（items，兼容旧前端）
 * 查询参数：lines / level / q / marker / limit
 */
const logsHandler: RequestHandler = (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200)));
  const lines = Math.min(5000, Math.max(1, Number(req.query.lines ?? 300)));
  const level = String(req.query.level ?? 'all') as LogLevel | 'all';
  const q = String(req.query.q ?? '');
  const marker = String(req.query.marker ?? '');
  res.json({
    ...logsStatus(),
    lines: tailLogs({ lines, level, q, marker }),
    items: logsRepo.recent(limit),
  });
};

/** 下载日志文件（原样文本，便于直接发给开发者排查） */
const logsDownloadHandler: RequestHandler = (req, res) => {
  const file = req.query.file ? String(req.query.file) : undefined;
  const { name, content, truncated } = readLogFile(file);
  logger.child('diag').mark('DIAG', `下载日志文件 ${name}`, { truncated, bytes: content.length });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(truncated ? `# 注意：文件过大，仅包含尾部内容\n${content}` : content);
};

/** 清空日志文件 */
const logsClearHandler: RequestHandler = (_req, res) => {
  const result = clearLogs();
  logger.child('diag').mark('DIAG', `清空日志文件 ${result.cleared} 个（${result.bytes} 字节）`);
  res.json({ ok: true, ...result });
};

/** 调试模式状态 */
const debugGetHandler: RequestHandler = (_req, res) => {
  res.json(logsStatus());
};

/** 切换调试模式 / 日志级别（运行时生效，无需重启） */
const debugPostHandler = asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as { debugMode?: boolean; logLevel?: string };
  if (typeof body.debugMode === 'boolean') {
    logger.setLevel(body.debugMode ? 'debug' : 'info');
  }
  if (body.logLevel) {
    const lv = String(body.logLevel);
    if (!['error', 'warn', 'info', 'debug', 'trace'].includes(lv)) throw badRequest('日志级别非法');
    logger.setLevel(lv as LogLevel);
  }
  logger.child('diag').mark('SETTINGS', '调试设置已更新', {
    debugMode: logger.isDebug(),
    logLevel: logger.getLevel(),
  });
  res.json(logsStatus());
});

/**
 * 诊断包：一个 JSON 文件把「日志 + 配置 + 任务 + 工具 + 网络自检」全打包，
 * 用户遇到问题直接下载发过来即可定位。
 */
const diagnosticsHandler = asyncHandler(async (_req, res) => {
  const settings = getSettingsPublic();
  const sf = statfsBytes(DIRS.root);
  const [aria2, transmission, ytdlp, ffmpeg, openssl] = await Promise.all([
    toolStatus(config.bins.aria2, ['--version']),
    toolStatus(config.bins.transmission, ['--version']),
    toolStatus(config.bins.ytdlp, ['--version']),
    toolStatus(config.bins.ffmpeg, ['-version']),
    toolStatus(config.bins.openssl, ['version']),
  ]);
  const files = listLogFiles();
  const logs = files.map((f) => {
    const { content, truncated } = readLogFile(f.name, 2 * 1024 * 1024);
    return { name: f.name, sizeBytes: f.sizeBytes, truncated, content };
  });
  let network: unknown = null;
  try {
    network = await networkReport(false);
  } catch (e) {
    network = { error: (e as Error).message };
  }
  const envRedacted: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    envRedacted[k] = /token|password|secret|passwd/i.test(k) ? '***' : String(v).slice(0, 500);
  }
  const tasks = tasksRepo.list({ pageSize: 100 });
  const bundle = {
    generatedAt: new Date().toISOString(),
    app: {
      version: config.version,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      cwd: process.cwd(),
      logLevel: logger.getLevel(),
      debugMode: logger.isDebug(),
      logFile: logger.filePath(),
    },
    env: envRedacted,
    config: {
      host: config.host,
      port: config.port,
      dirs: DIRS,
      dbPath: config.dbPath,
      logPath: config.logPath,
      reserveFreeBytes: config.reserveFreeBytes,
      maxConcurrent: config.maxConcurrent,
      moduleConcurrency: config.moduleConcurrency,
      autoRetry: config.autoRetry,
      bins: config.bins,
      webvideo: config.webvideo,
      transmissionIncompleteDir: config.transmissionIncompleteDir,
      btEvict: config.btEvict,
    },
    settings,
    disk: {
      path: DIRS.root,
      totalBytes: sf.total,
      freeBytes: sf.free,
      usableBytes: usableBytes(settings.reserveFreeBytes),
    },
    tools: { aria2, transmission, ytdlp, ffmpeg, openssl },
    tasks: { items: tasks.items, total: tasks.total },
    events: logsRepo.recent(300),
    network,
    markers: logger.markers(),
    logs,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  logger.child('diag').mark('DIAG', '导出诊断包', {
    logFiles: files.map((f) => f.name),
    taskCount: tasks.total,
    bytes: JSON.stringify(bundle).length,
  });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ttdownload-diagnostics-${stamp}.json"`);
  res.send(JSON.stringify(bundle, null, 2));
});

// 同时挂到 /api/xxx 与 /api/system/xxx（前端用 /api/system/*，旧习惯用 /api/*）
for (const register of [
  () => systemRouter.get('/logs', logsHandler),
  () => systemRouter.get('/system/logs', logsHandler),
  () => systemRouter.get('/logs/download', logsDownloadHandler),
  () => systemRouter.get('/system/logs/download', logsDownloadHandler),
  () => systemRouter.delete('/logs', logsClearHandler),
  () => systemRouter.delete('/system/logs', logsClearHandler),
  () => systemRouter.get('/debug', debugGetHandler),
  () => systemRouter.get('/system/debug', debugGetHandler),
  () => systemRouter.post('/debug', debugPostHandler),
  () => systemRouter.post('/system/debug', debugPostHandler),
  () => systemRouter.get('/diagnostics', diagnosticsHandler),
  () => systemRouter.get('/system/diagnostics', diagnosticsHandler),
]) {
  register();
}

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
  logger.child('sse').debug('[MARK:SSE] 已建立事件流连接');

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
    logger.child('settings').mark('SETTINGS', '设置已更新', {
      keys: Object.keys(clean),
      patch: clean,
    });
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
