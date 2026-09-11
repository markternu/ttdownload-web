/**
 * 问题反馈 / 诊断报告生成
 *
 * 目标：用户在网页「问题反馈」页点一下，就把**所有能帮助排查的信息**打包成
 * 一个文件（优先 zip，退化为 json）下载到本地，直接发给开发者即可定位问题。
 *
 * 包含：README、诊断信息、应用日志（含轮转）、部署日志、错误摘要、
 *       任务清单与失败原因、网络自检、标记说明。
 * 所有 token/密码类字段自动打码（见 logger.redact / 环境变量名过滤）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, DIRS } from '../core/config';
import { computeStats, dbFileSize, logsRepo, tasksRepo } from '../core/db';
import { dirUsage, freeBytes, statfsBytes, toolStatus, usableBytes } from '../core/disk';
import { listLogFiles, logger, readLogFile, redact } from '../core/logger';
import { runCommand } from './archive';
import { getSettings, getSettingsPublic } from './settings';
import type { Task } from '../types';

const MAX_LOG_TAIL = 2 * 1024 * 1024; // 每个日志文件最多带 2MB
const MAX_KEEP_REPORTS = 5;

/* ------------------------------------------------------------------ */
/* 基础信息                                                            */
/* ------------------------------------------------------------------ */

export function deployLogPath(): string {
  return path.join(config.dirs.state, 'logs', 'deploy.log');
}

export function reportsDir(): string {
  return path.join(config.dirs.state, 'reports');
}

function redactedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    out[k] = /token|password|secret|passwd|key/i.test(k) ? '***' : String(v).slice(0, 500);
  }
  return out;
}

/**
 * 代码版本（git 提交）：把日志和具体代码版本对应起来，排查时最有价值的信息之一。
 * 非 git 目录（scp 上传）或命令失败时返回 null。
 */
export function gitInfo(): { commit: string; shortCommit: string; branch: string; subject: string; date: string; dirty: boolean } | null {
  try {
    const run = (args: string[]): string => execFileSync('git', args, { cwd: __dirname, timeout: 3000, encoding: 'utf8' }).trim();
    const commit = run(['rev-parse', 'HEAD']);
    return {
      commit,
      shortCommit: commit.slice(0, 7),
      branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
      subject: run(['log', '-1', '--pretty=%s']),
      date: run(['log', '-1', '--pretty=%cI']),
      dirty: run(['status', '--porcelain']).length > 0,
    };
  } catch {
    return null;
  }
}

/** 应用 + 运行环境 */
export function appInfo(): Record<string, unknown> {
  return {
    version: config.version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    cwd: process.cwd(),
    logLevel: logger.getLevel(),
    debugMode: logger.isDebug(),
    logFile: logger.filePath(),
    deployLog: deployLogPath(),
    reportsDir: reportsDir(),
    memory: process.memoryUsage(),
    git: gitInfo(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    nowLocal: new Date().toLocaleString('zh-CN', { hour12: false }),
  };
}

/** 生效配置（密钥打码） */
export function configInfo(): Record<string, unknown> {
  return {
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
    webvideo: { ...config.webvideo, cookiesFromBrowser: config.webvideo.cookiesFromBrowser || '(未启用)' },
    transmissionIncompleteDir: config.transmissionIncompleteDir,
    btEvict: config.btEvict,
  };
}

/** 磁盘 / 工具 / 数据库 */
export async function systemInfo(): Promise<Record<string, unknown>> {
  const sf = statfsBytes(DIRS.root);
  const settings = getSettings();
  const [aria2, transmission, ytdlp, ffmpeg, openssl, zip] = await Promise.all([
    toolStatus(config.bins.aria2, ['--version']),
    toolStatus(config.bins.transmission, ['--version']),
    toolStatus(config.bins.ytdlp, ['--version']),
    toolStatus(config.bins.ffmpeg, ['-version']),
    toolStatus(config.bins.openssl, ['version']),
    toolStatus(config.bins.zip, ['-v']),
  ]);
  return {
    disk: {
      path: DIRS.root,
      totalBytes: sf.total,
      freeBytes: sf.free,
      usableBytes: usableBytes(settings.reserveFreeBytes),
      reserveBytes: settings.reserveFreeBytes,
      usage: {
        archiveReady: dirUsage(DIRS.archiveReady),
        consumer: dirUsage(DIRS.consumer),
        aria2: dirUsage(DIRS.aria2),
        webTools: dirUsage(DIRS.webTools),
      },
    },
    db: { path: config.dbPath, sizeBytes: dbFileSize() },
    tools: { aria2, transmission, ytdlp, ffmpeg, openssl, zip },
    stats: computeStats(),
  };
}

/** 任务清单 + 失败明细 */
export function tasksReport(limit = 200): {
  total: number;
  byStatus: Record<string, number>;
  failed: { id: number; module: string; title: string; url: string | null; error: string | null; retryCount: number; updatedAt: string }[];
  items: Task[];
} {
  const all = tasksRepo.list({ pageSize: limit });
  const byStatus: Record<string, number> = {};
  for (const t of all.items) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const failed = all.items
    .filter((t) => t.status === 'failed')
    .map((t) => ({
      id: t.id,
      module: t.module,
      title: t.title ?? '',
      url: t.url ?? null,
      error: t.error ?? null,
      retryCount: Number((t as Task & { retryCount?: number }).retryCount ?? 0),
      updatedAt: (t.finishedAt ?? t.createdAt) as string,
    }));
  return { total: all.total, byStatus, failed, items: all.items };
}

/** 只保留 WARN/ERROR（以及失败标记）的日志摘要，体积小、重点突出 */
export function errorsLog(maxLines = 5000): string {
  const lines: string[] = [];
  for (const f of listLogFiles()) {
    const { content } = readLogFile(f.name, 4 * 1024 * 1024);
    for (const line of content.split('\n')) {
      if (!line) continue;
      if (
        /\[(WARN|ERROR)\s*\]/.test(line) ||
        /MARK:(TASK_FAIL|TASK_RETRY|HTTP_ERR|ERROR|PROC_EXIT|YTDLP_EXIT|BT_EVICT)\b/.test(line)
      ) {
        lines.push(`[${f.name}] ${line}`);
      }
    }
  }
  return lines.slice(-maxLines).join('\n');
}

/* ------------------------------------------------------------------ */
/* 诊断包（JSON 对象，供 /api/system/diagnostics 与报告复用）           */
/* ------------------------------------------------------------------ */

export async function buildDiagnosticsBundle(): Promise<Record<string, unknown>> {
  const settings = getSettingsPublic();
  const sys = await systemInfo();
  const files = listLogFiles();
  const logs = files.map((f) => {
    const { content, truncated } = readLogFile(f.name, MAX_LOG_TAIL);
    return { name: f.name, sizeBytes: f.sizeBytes, mtime: f.mtime, truncated, content };
  });
  let network: unknown = null;
  try {
    // 一键报告不能久等：网络自检给 8 秒预算，超时就带说明跳过（页面可单独下载完整网络报告）
    const { networkReportWithBudget } = await import('./netCheck');
    network = await networkReportWithBudget(8000);
  } catch (e) {
    network = { error: (e as Error).message };
  }
  return {
    generatedAt: new Date().toISOString(),
    app: appInfo(),
    env: redactedEnv(),
    config: configInfo(),
    settings,
    system: sys,
    disk: sys.disk,
    tools: (sys as { tools: unknown }).tools,
    tasks: tasksReport(200),
    events: logsRepo.recent(300),
    network,
    markers: logger.markers(),
    logs,
  };
}

/* ------------------------------------------------------------------ */
/* 报告文件集合（zip 内容）                                             */
/* ------------------------------------------------------------------ */

const README = (generatedAt: string): string => {
  const git = gitInfo();
  return `ttdownload-web 诊断报告
生成时间：${generatedAt}
代码版本：${git ? `${git.shortCommit} (${git.branch}) ${git.subject}${git.dirty ? ' [有未提交改动]' : ''}` : '(非 git 目录，无法识别版本)'}

这份报告用于排查问题，请把它整个发给开发者（或连同报错截图一起发）。

包含内容：
  diagnostics.json  运行环境 / 配置 / 磁盘 / 工具可用性 / 任务与失败原因 / 事件
  system-info.json  磁盘、数据库、外部工具版本
  tasks.json        任务清单：状态统计 + 失败任务明细（含错误原因与重试次数）
  network.json      网络自检结果（DNS / HTTPS / yt-dlp / YouTube / 视频CDN / 本机RPC）
  markers.json      日志标记说明表（[MARK:XXX] 的含义）
  errors.log        只保留 WARN/ERROR 与失败相关标记的日志摘要（建议先看这个）
  app.log           当前应用日志（若超过 2MB 只带尾部）
  app.log.N         轮转后的历史日志（同上）
  deploy.log        部署/更新脚本的输出记录

怎么看：
  1) 先看 errors.log，找到报错时间点
  2) 再到 app.log 里搜那个时间点前后 50 行（或 grep 报错里的关键词）
  3) 每个日志行都带标记 [MARK:XXX]，含义见 markers.json

隐私：报告中的 token / 密码 / secret 等字段已自动替换为 ***；
      日志里可能包含视频 URL、种子名称等，如介意可自行删除对应行。
`;
};

export interface BundleFile {
  name: string;
  content: string | Buffer;
}

/** 收集报告要包含的所有文件 */
export async function collectBundleFiles(): Promise<BundleFile[]> {
  const generatedAt = new Date().toISOString();
  const files: BundleFile[] = [{ name: 'README.txt', content: README(generatedAt) }];

  const diagnostics = await buildDiagnosticsBundle();
  files.push({ name: 'diagnostics.json', content: JSON.stringify(diagnostics, null, 2) });
  files.push({ name: 'system-info.json', content: JSON.stringify(diagnostics.system, null, 2) });
  files.push({ name: 'tasks.json', content: JSON.stringify(diagnostics.tasks, null, 2) });
  files.push({ name: 'network.json', content: JSON.stringify(diagnostics.network, null, 2) });
  files.push({ name: 'markers.json', content: JSON.stringify(logger.markers(), null, 2) });
  files.push({ name: 'errors.log', content: errorsLog() || '(没有 WARN/ERROR 级别日志)\n' });

  for (const f of listLogFiles()) {
    const { content } = readLogFile(f.name, MAX_LOG_TAIL);
    files.push({ name: f.name, content });
  }

  const deploy = deployLogPath();
  try {
    const st = fs.statSync(deploy);
    const start = Math.max(0, st.size - MAX_LOG_TAIL);
    const fd = fs.openSync(deploy, 'r');
    try {
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      files.push({ name: 'deploy.log', content: buf.toString('utf8') });
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    files.push({ name: 'deploy.log', content: '(还没有部署日志，或未通过 deploy.sh 部署)\n' });
  }
  return files;
}

export const __reportInternals = { gitInfo };

export interface ReportResult {
  kind: 'zip' | 'json';
  path: string;
  name: string;
  sizeBytes: number;
}

/** 生成报告文件（优先 zip；zip 不可用时退化为单个 json） */
export async function createReport(): Promise<ReportResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = reportsDir();
  fs.mkdirSync(dir, { recursive: true });
  const files = await collectBundleFiles();

  // 1) 优先 zip（把文件写进临时目录再打包）
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttdl-report-'));
  try {
    for (const f of files) {
      const target = path.join(tmpDir, f.name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content);
    }
    const zipName = `ttdownload-report-${stamp}.zip`;
    const zipPath = path.join(dir, zipName);
    const res = await runCommand(config.bins.zip, ['-r', '-q', zipPath, '.'], tmpDir);
    if (res.code === 0 && fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0) {
      pruneReports();
      const sizeBytes = fs.statSync(zipPath).size;
      logger.child('report').mark('DIAG', '已生成诊断报告（zip）', { name: zipName, sizeBytes, files: files.map((f) => f.name) });
      return { kind: 'zip', path: zipPath, name: zipName, sizeBytes };
    }
    logger.child('report').warn(`[MARK:DIAG] zip 打包失败（code=${res.code}），退化为 json：${(res.stderr || res.stdout).slice(0, 200)}`);
  } catch (e) {
    logger.child('report').warn(`[MARK:DIAG] zip 打包异常，退化为 json：${(e as Error).message}`);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  // 2) 退化：单个 JSON
  const jsonName = `ttdownload-report-${stamp}.json`;
  const jsonPath = path.join(dir, jsonName);
  const payload = {
    generatedAt: new Date().toISOString(),
    note: '系统缺少 zip 命令，已退化为单个 JSON 报告（内容等价）。安装 zip：sudo apt install -y zip',
    files: files.map((f) => ({
      name: f.name,
      content: Buffer.isBuffer(f.content) ? f.content.toString('utf8') : f.content,
    })),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  pruneReports();
  const sizeBytes = fs.statSync(jsonPath).size;
  logger.child('report').mark('DIAG', '已生成诊断报告（json）', { name: jsonName, sizeBytes });
  return { kind: 'json', path: jsonPath, name: jsonName, sizeBytes };
}

/** 只保留最近 N 份报告，避免占空间 */
function pruneReports(): void {
  try {
    const dir = reportsDir();
    const items = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith('ttdownload-report-'))
      .map((n) => {
        const full = path.join(dir, n);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const item of items.slice(MAX_KEEP_REPORTS)) {
      fs.rmSync(item.full, { force: true });
    }
  } catch {
    /* ignore */
  }
}

/** 出错时把堆栈也写进日志，保证报告里有据可查 */
export function reportError(context: string, e: unknown): void {
  const err = e as Error;
  logger.child('report').error(`[MARK:ERROR] ${context} 失败: ${redact(err?.stack ?? String(e))}`);
}

/** 供页面展示：最近生成的报告 */
export function recentReports(): { name: string; sizeBytes: number; mtime: string }[] {
  try {
    const dir = reportsDir();
    return fs
      .readdirSync(dir)
      .filter((n) => n.startsWith('ttdownload-report-'))
      .map((n) => {
        const st = fs.statSync(path.join(dir, n));
        return { name: n, sizeBytes: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime))
      .slice(0, MAX_KEEP_REPORTS);
  } catch {
    return [];
  }
}

/** 报告下载中的文件也可以被 safe 地读取（仅限 reports 目录内的文件） */
export function reportFilePath(name: string): string | null {
  const base = path.basename(name);
  if (!/^ttdownload-report-[\w.-]+\.(zip|json)$/.test(base)) return null;
  const full = path.join(reportsDir(), base);
  return fs.existsSync(full) ? full : null;
}

export { freeBytes };
