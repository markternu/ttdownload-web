import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { Router, type RequestHandler } from 'express';
import { config, DIRS } from '../core/config';
import { dbFileSize, computeStats, logsRepo } from '../core/db';
import { dirUsage, freeBytes, statfsBytes, toolStatus, usableBytes } from '../core/disk';
import { reservedByRunningTasks } from '../core/space';
import { bus } from '../core/events';
import { getSettings, getSettingsPublic, updateSettings } from '../services/settings';
import {
  clearLogs,
  listLogFiles,
  logger,
  readLogFile,
  tailLogs,
  type LogLevel,
} from '../core/logger';
import { tasksRepo } from '../core/db';
import {
  deleteScript,
  getScript,
  readScript,
  readScriptLog,
  refreshRun,
  runScript,
  saveScript,
  scriptFilePath,
  scriptLogPath,
  scriptExecEnabled,
  scriptsOverview,
  setScriptExecEnabled,
  tokenOk,
  maintenanceToken,
} from '../services/scriptRunner';
import {
  buildDiagnosticsBundle,
  createReport,
  deployLogPath,
  errorsLog,
  recentReports,
  reportFilePath,
  systemInfo,
  tasksReport,
} from '../services/report';
import { kickScheduler } from '../core/scheduler';
import { asyncHandler, badRequest, notFound } from '../utils/http';
import type { Settings, Task } from '../types';

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
    // 运行中任务"预计要占"的空间：调度器放行新任务时会把它扣掉，
    // 所以"还能不能再放行"= 系统可用 - 预留 - 这些预留。前端要能说清楚这个差额。
    // ⚠️ 历史 bug：这里读的是 `expect_bytes`，而 tasksRepo 返回的是驼峰 `expectBytes` →
    //    reservedBytes 恒为 0，接口把"可用于下载"直接当成"还能再放行"，用户看到的数
    //    和调度器判定的数根本不是一回事。现在与调度器共用同一个算法（只算"还差多少"）。
    const reservedBytes = reservedByRunningTasks();
    const usable = usableBytes(settings.reserveFreeBytes);
    res.json({
      disk: {
        path: DIRS.root,
        totalBytes: sf.total,
        freeBytes: sf.free,
        usedBytes: sf.total - sf.free,
        reserveBytes: settings.reserveFreeBytes,
        usableBytes: usable,
        reservedBytes,
        admittableBytes: usable - reservedBytes,
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
  const bundle = await buildDiagnosticsBundle();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  logger.child('diag').mark('DIAG', '导出诊断包（JSON）', {
    logFiles: (bundle.logs as { name: string }[]).map((l) => l.name),
    bytes: JSON.stringify(bundle).length,
  });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ttdownload-diagnostics-${stamp}.json"`);
  res.send(JSON.stringify(bundle, null, 2));
});

/** 一键诊断报告（推荐）：优先 zip（含 README/日志/部署日志/错误摘要/任务/网络），失败退化为 JSON */
const reportHandler = asyncHandler(async (req, res) => {
  const report = await createReport();
  // 「下载后清空已有日志」：开关在网页「问题反馈」页；也可用 ?clear=1 / ?clear=0 强制覆盖
  const q = String(req.query.clear ?? '');
  const shouldClear = q === '1' ? true : q === '0' ? false : getSettings().clearLogsAfterReport === true;
  let cleared: { cleared: number; bytes: number } | null = null;
  if (shouldClear) {
    // 注意：报告文件已经生成完毕，此时清空日志不会影响报告内容
    cleared = clearLogs();
    logger.child('report').mark('DIAG', `按要求清空日志（${cleared.cleared} 个文件 / ${cleared.bytes} 字节）后再提供报告下载`);
  }
  if (cleared) {
    res.setHeader('X-Logs-Cleared', String(cleared.cleared));
    res.setHeader('X-Logs-Cleared-Bytes', String(cleared.bytes));
  }
  res.download(report.path, report.name, (err) => {
    if (err) logger.child('report').warn(`[MARK:DIAG] 报告下载中断：${err.message}`);
  });
});

/** 页面用：可下载项清单（含建议文件名、说明、大小、时间、下载地址） */
const reportListHandler = asyncHandler(async (_req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sys = await systemInfo();
  const logs = listLogFiles();
  const deploy = deployLogPath();
  let deploySize: number | null = null;
  let deployMtime: string | null = null;
  try {
    const st = fs.statSync(deploy);
    deploySize = st.size;
    deployMtime = st.mtime.toISOString();
  } catch {
    /* 还没有部署日志 */
  }
  const zipOk = await toolStatus(config.bins.zip, ['-v']);
  const dlog = logs.find((l) => l.name === path.basename(config.logPath));
  const items = [
    {
      id: 'report',
      title: '完整诊断报告（推荐）',
      name: `ttdownload-report-${stamp}.${zipOk.ok ? 'zip' : 'json'}`,
      description: '一次性打包：README + 全部日志（含轮转）+ 部署日志 + 错误摘要 + 任务失败原因 + 网络自检 + 标记说明。排查问题发这一个文件就够。',
      sizeBytes: null as number | null,
      updatedAt: null as string | null,
      url: '/api/system/report',
      recommended: true,
      kind: (zipOk.ok ? 'zip' : 'json') as 'zip' | 'json',
    },
    {
      id: 'diagnostics',
      title: '诊断信息（JSON）',
      name: `ttdownload-diagnostics-${stamp}.json`,
      description: '运行环境、生效配置（密钥已打码）、磁盘、外部工具版本、任务清单、事件、网络自检。',
      sizeBytes: null,
      updatedAt: null,
      url: '/api/system/diagnostics',
      recommended: false,
      kind: 'json' as const,
    },
    {
      id: 'errors',
      title: '错误日志摘要（体积小，建议先看）',
      name: `ttdownload-errors-${stamp}.log`,
      description: '所有日志里的 WARN/ERROR 行 + 失败/重试/外部命令非零退出等关键标记，最多 5000 行。',
      sizeBytes: null,
      updatedAt: dlog?.mtime ?? null,
      url: '/api/system/logs/export?level=warn&lines=5000',
      recommended: false,
      kind: 'log' as const,
    },
    {
      id: 'app-log',
      title: '当前应用日志 app.log',
      name: 'app.log',
      description: `完整应用日志（最新在最后）。当前 ${dlog ? `${(dlog.sizeBytes / 1024).toFixed(1)} KB` : '尚未生成'}，超过 20MB 会自动轮转。`,
      sizeBytes: dlog?.sizeBytes ?? null,
      updatedAt: dlog?.mtime ?? null,
      url: '/api/system/logs/download',
      recommended: false,
      kind: 'log' as const,
    },
    ...logs
      .filter((l) => l.name !== path.basename(config.logPath))
      .map((l) => ({
        id: `log-${l.name}`,
        title: `轮转日志 ${l.name}`,
        name: l.name,
        description: '历史日志（文件写满后轮转出来的）。',
        sizeBytes: l.sizeBytes as number | null,
        updatedAt: l.mtime as string | null,
        url: `/api/system/logs/download?file=${encodeURIComponent(l.name)}`,
        recommended: false,
        kind: 'log' as const,
      })),
    {
      id: 'deploy-log',
      title: '部署脚本日志 deploy.log',
      name: 'deploy.log',
      description: 'deploy.sh 的全部输出：装依赖、git pull、构建、重启、健康检查。部署/更新失败时看它。',
      sizeBytes: deploySize,
      updatedAt: deployMtime,
      url: '/api/system/deploy-log',
      recommended: false,
      kind: 'log' as const,
    },
    {
      id: 'tasks',
      title: '任务清单与失败原因',
      name: `ttdownload-tasks-${stamp}.json`,
      description: '任务状态统计 + 每个失败任务的错误原因、重试次数（JSON）。',
      sizeBytes: null,
      updatedAt: null,
      url: '/api/system/report/tasks',
      recommended: false,
      kind: 'json' as const,
    },
    {
      id: 'tasks-csv',
      title: '任务清单（CSV，方便表格查看）',
      name: `ttdownload-tasks-${stamp}.csv`,
      description: '同样的任务信息，逗号分隔，可用 Excel 打开。',
      sizeBytes: null,
      updatedAt: null,
      url: '/api/system/report/tasks?format=csv',
      recommended: false,
      kind: 'csv' as const,
    },
    {
      id: 'network',
      title: '网络自检报告',
      name: `ttdownload-network-${stamp}.json`,
      description: 'DNS / HTTPS(Google,YouTube,GitHub) / yt-dlp 解析 / 视频 CDN / 本机 RPC 的逐项实测结果与建议。',
      sizeBytes: null,
      updatedAt: null,
      url: '/api/system/report/network',
      recommended: false,
      kind: 'json' as const,
    },
  ];
  res.json({
    generatedAt: new Date().toISOString(),
    clearLogsAfterReport: getSettings().clearLogsAfterReport === true,
    zipAvailable: zipOk.ok,
    zipHint: zipOk.ok ? null : '未检测到 zip 命令：完整报告会退化为单个 JSON。可执行 sudo apt install -y zip 后重试。',
    logLevel: logger.getLevel(),
    debugMode: logger.isDebug(),
    reports: recentReports(),
    items,
    tasksSummary: (sys as { stats: unknown }).stats,
  });
});

/** 下载历史上已经生成过的报告 */
const reportFileHandler = asyncHandler(async (req, res) => {
  const name = String(req.query.name ?? '');
  const full = reportFilePath(name);
  if (!full) throw notFound('报告不存在或已被清理（只保留最近 5 份）', 'REPORT_NOT_FOUND');
  res.download(full, path.basename(full));
});

/** 按级别/标记/关键字导出日志（默认 warn 及以上） */
const logExportHandler = asyncHandler(async (req, res) => {
  const level = String(req.query.level ?? 'warn') as LogLevel | 'all';
  const marker = String(req.query.marker ?? '');
  const q = String(req.query.q ?? '');
  const lines = Math.min(20000, Math.max(1, Number(req.query.lines ?? 5000)));
  const body = marker || q ? tailLogs({ lines, level, marker, q }) : errorsLog(lines).split('\n');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `ttdownload-${level === 'all' ? 'log' : `${level}-log`}-${stamp}.log`;
  logger.child('report').mark('DIAG', `导出日志文件 ${name}`, { level, marker, q, lineCount: body.length });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(
    `# ttdownload-web 日志导出\n# 生成时间: ${new Date().toISOString()}\n# 级别: ${level}${marker ? ` 标记: ${marker}` : ''}${q ? ` 关键字: ${q}` : ''}\n# 共 ${body.length} 行\n\n${body.join('\n')}\n`,
  );
});

/** 部署脚本日志 */
const deployLogHandler = asyncHandler(async (_req, res) => {
  const full = deployLogPath();
  if (!fs.existsSync(full)) throw notFound('还没有部署日志（未通过 deploy.sh 部署，或日志已被清理）', 'DEPLOY_LOG_NOT_FOUND');
  logger.child('report').mark('DIAG', '下载部署日志 deploy.log');
  res.download(full, 'deploy.log');
});

/** 任务清单导出（json / csv） */
const tasksReportHandler = asyncHandler(async (req, res) => {
  const format = String(req.query.format ?? 'json') === 'csv' ? 'csv' : 'json';
  const report = tasksReport(500);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  logger.child('report').mark('DIAG', `导出任务清单（${format}）`, { total: report.total, failed: report.failed.length });
  if (format === 'csv') {
    const esc = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""').replace(/\n/g, ' ')}"`;
    const head = ['id', 'module', 'status', 'title', 'url', 'progress', 'error', 'retryCount', 'createdAt', 'finishedAt'];
    const rows = report.items.map((t) =>
      [
        t.id,
        t.module,
        t.status,
        t.title,
        t.url,
        t.progress,
        t.error,
        (t as Task & { retryCount?: number }).retryCount ?? 0,
        t.createdAt,
        t.finishedAt,
      ]
        .map(esc)
        .join(','),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ttdownload-tasks-${stamp}.csv"`);
    res.send(`\uFEFF${head.join(',')}\n${rows.join('\n')}\n`);
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ttdownload-tasks-${stamp}.json"`);
  res.send(JSON.stringify(report, null, 2));
});

/** 网络自检报告下载 */
const networkReportHandler = asyncHandler(async (_req, res) => {
  const { networkReport } = await import('../services/netCheck');
  const report = await networkReport(true);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ttdownload-network-${stamp}.json"`);
  res.send(JSON.stringify(report, null, 2));
});

/* ------------------------------------------------------------------ */
/* 修复脚本上传 / 执行（环境问题的远程修复通道）                          */
/* ------------------------------------------------------------------ */

const maintenanceTokenConfigured = (): boolean => maintenanceToken().length > 0;

const scriptTokenFrom = (req: { headers: Record<string, unknown>; query: Record<string, unknown> }): string =>
  String(req.headers['x-maint-token'] ?? req.query.token ?? '');

function requireScriptToken(req: { headers: Record<string, unknown>; query: Record<string, unknown> }): void {
  if (!scriptExecEnabled()) {
    throw badRequest('修复脚本功能未开启：请先在上方打开开关，或设置 .env 的 SCRIPT_UPLOAD_ENABLED=1 后重启', 'SCRIPT_DISABLED');
  }
  if (!tokenOk(scriptTokenFrom(req))) {
    throw badRequest('维护令牌不正确（取 .env 的 MAINTENANCE_TOKEN 或 ANDROID_TOKEN，在页面右上角填入）', 'SCRIPT_TOKEN');
  }
}

/** 概览：开关状态、是否需要令牌、超时、历史脚本列表 */
const scriptsOverviewHandler = asyncHandler(async (_req, res) => {
  res.json(scriptsOverview());
});

/** 开启/关闭脚本执行 */
const scriptsToggleHandler = asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as { enabled?: boolean };
  if (typeof body.enabled !== 'boolean') throw badRequest('enabled 必须是布尔值');
  if (body.enabled && !tokenOk(scriptTokenFrom(req as never))) {
    throw badRequest('开启该功能需要维护令牌（.env 的 MAINTENANCE_TOKEN 或 ANDROID_TOKEN）', 'SCRIPT_TOKEN');
  }
  setScriptExecEnabled(body.enabled);
  res.json(scriptsOverview());
});

const scriptUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

/** 上传脚本：multipart(file) 或 JSON { name, content } */
const scriptUploadHandler = [
  scriptUpload.single('file'),
  asyncHandler(async (req, res) => {
    requireScriptToken(req as never);
    const body = (req.body ?? {}) as { name?: string; content?: string };
    const content = req.file?.buffer?.toString('utf8') ?? (typeof body.content === 'string' ? body.content : '');
    const name = req.file?.originalname ?? body.name ?? 'fix.sh';
    const saved = saveScript(name, content);
    if (!saved.ok || !saved.item) throw badRequest(saved.error ?? '保存失败', 'SCRIPT_SAVE');
    res.json({ item: saved.item, overview: scriptsOverview() });
  }),
];

/** 单个脚本详情（含内容预览与日志尾部；运行中会刷新状态） */
const scriptDetailHandler = asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const item = refreshRun(id);
  if (!item) throw notFound('脚本不存在', 'SCRIPT_NOT_FOUND');
  const script = readScript(id);
  const { content, total } = readScriptLog(id, Math.min(2000, Math.max(50, Number(req.query.lines ?? 300))));
  res.json({
    item,
    preview: script?.content ?? '',
    log: content,
    logLines: total,
    enabled: scriptExecEnabled(),
    tokenRequired: maintenanceTokenConfigured(),
    timeoutSec: scriptsOverview().timeoutSec,
  });
});

/** 执行脚本（分离运行：即使脚本里重启本服务也不会中断） */
const scriptRunHandler = asyncHandler(async (req, res) => {
  requireScriptToken(req as never);
  const id = String(req.params.id);
  const result = runScript(id);
  if (!result.ok || !result.item) throw badRequest(result.error ?? '执行失败', 'SCRIPT_RUN');
  res.json({ item: result.item, via: result.via });
});

/** 下载脚本文件 */
const scriptFileHandler = asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const item = getScript(id);
  const p = scriptFilePath(id);
  if (!item || !p) throw notFound('脚本不存在', 'SCRIPT_NOT_FOUND');
  res.download(p, item.name);
});

/** 下载执行日志 */
const scriptLogHandler = asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const item = getScript(id);
  const p = scriptLogPath(id);
  if (!item || !p) throw notFound('还没有执行日志（可能尚未运行过）', 'SCRIPT_LOG_NOT_FOUND');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.download(p, `fix-script-${item.id}-${stamp}.log`);
});

/** 删除脚本（运行中不允许） */
const scriptDeleteHandler = asyncHandler(async (req, res) => {
  requireScriptToken(req as never);
  const id = String(req.params.id);
  const ok = deleteScript(id);
  if (!ok) throw badRequest('删除失败：脚本不存在或正在运行', 'SCRIPT_DELETE');
  res.json({ ok: true, overview: scriptsOverview() });
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
  () => systemRouter.get('/report', reportHandler),
  () => systemRouter.get('/system/report', reportHandler),
  () => systemRouter.get('/report/list', reportListHandler),
  () => systemRouter.get('/system/report/list', reportListHandler),
  () => systemRouter.get('/report/file', reportFileHandler),
  () => systemRouter.get('/system/report/file', reportFileHandler),
  () => systemRouter.get('/report/tasks', tasksReportHandler),
  () => systemRouter.get('/system/report/tasks', tasksReportHandler),
  () => systemRouter.get('/report/network', networkReportHandler),
  () => systemRouter.get('/system/report/network', networkReportHandler),
  () => systemRouter.get('/logs/export', logExportHandler),
  () => systemRouter.get('/system/logs/export', logExportHandler),
  () => systemRouter.get('/deploy-log', deployLogHandler),
  () => systemRouter.get('/system/deploy-log', deployLogHandler),
  () => systemRouter.get('/scripts', scriptsOverviewHandler),
  () => systemRouter.get('/system/scripts', scriptsOverviewHandler),
  () => systemRouter.post('/scripts/toggle', scriptsToggleHandler),
  () => systemRouter.post('/system/scripts/toggle', scriptsToggleHandler),
  () => systemRouter.post('/scripts', ...(scriptUploadHandler as [RequestHandler, RequestHandler])),
  () => systemRouter.post('/system/scripts', ...(scriptUploadHandler as [RequestHandler, RequestHandler])),
  () => systemRouter.get('/scripts/:id', scriptDetailHandler),
  () => systemRouter.get('/system/scripts/:id', scriptDetailHandler),
  () => systemRouter.post('/scripts/:id/run', scriptRunHandler),
  () => systemRouter.post('/system/scripts/:id/run', scriptRunHandler),
  () => systemRouter.get('/scripts/:id/file', scriptFileHandler),
  () => systemRouter.get('/system/scripts/:id/file', scriptFileHandler),
  () => systemRouter.get('/scripts/:id/log', scriptLogHandler),
  () => systemRouter.get('/system/scripts/:id/log', scriptLogHandler),
  () => systemRouter.delete('/scripts/:id', scriptDeleteHandler),
  () => systemRouter.delete('/system/scripts/:id', scriptDeleteHandler),
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
      'scriptUploadEnabled',
      'scriptRunTimeoutSec',
      'clearLogsAfterReport',
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
