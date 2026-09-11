import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { toolStatus } from '../core/disk';
import type { FormatOption } from '../types';
import type { ModuleAdapter, PollResult, TaskWithPayload } from './types';

/* ------------------------------------------------------------------ */
/* 平台识别                                                            */
/* ------------------------------------------------------------------ */

const PLATFORM_RULES: { name: string; match: RegExp }[] = [
  { name: 'YouTube', match: /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/i },
  { name: 'Bilibili', match: /(^|\.)bilibili\.com$|(^|\.)b23\.tv$/i },
  { name: 'Vimeo', match: /(^|\.)vimeo\.com$/i },
  { name: 'X', match: /(^|\.)x\.com$|(^|\.)twitter\.com$/i },
  { name: 'TikTok', match: /(^|\.)tiktok\.com$/i },
  { name: 'Instagram', match: /(^|\.)instagram\.com$/i },
  { name: '抖音', match: /(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/i },
];

export function detectPlatform(url: string): string {
  try {
    const host = new URL(url).hostname;
    for (const rule of PLATFORM_RULES) {
      if (rule.match.test(host)) return rule.name;
    }
    return host;
  } catch {
    return '未知';
  }
}

export function supportedPlatforms(): string[] {
  return PLATFORM_RULES.map((r) => r.name);
}

/* ------------------------------------------------------------------ */
/* 元数据解析（yt-dlp -J）                                              */
/* ------------------------------------------------------------------ */

interface YtDlpFormat {
  format_id?: string;
  ext?: string;
  resolution?: string;
  height?: number;
  vcodec?: string;
  acodec?: string;
  filesize?: number;
  filesize_approx?: number;
  format_note?: string;
  abr?: number;
}

interface YtDlpInfo {
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
  webpage_url?: string;
  formats?: YtDlpFormat[];
  is_live?: boolean;
}

export interface ParseResult {
  platform: string;
  title: string;
  thumbnail: string | null;
  durationSec: number | null;
  author: string | null;
  formats: FormatOption[];
  defaultFormatId: string | null;
  expectedBytes: number;
}

function normalizeFormat(f: YtDlpFormat): FormatOption | null {
  const id = f.format_id;
  if (!id) return null;
  const ext = (f.ext ?? 'mp4').toLowerCase();
  const vcodec = f.vcodec ?? 'none';
  const acodec = f.acodec ?? 'none';
  const hasVideo = vcodec !== 'none' && !!vcodec;
  const hasAudio = acodec !== 'none' && !!acodec;
  let resolution = f.resolution ?? '';
  if (!resolution || resolution === 'audio only') {
    resolution = hasVideo ? `${f.height ?? '?'}p` : 'audio';
  }
  const filesize = f.filesize ?? f.filesize_approx ?? null;
  const sizeText = filesize && filesize > 0 ? ` · ${(filesize / 1024 / 1024).toFixed(0)} MB` : '';
  const kind = hasVideo ? (hasAudio ? '视频+音频' : '仅视频') : '仅音频';
  const label = `${resolution} · ${ext.toUpperCase()} · ${kind}${sizeText}`;
  return {
    id,
    ext,
    resolution,
    label,
    filesize,
    vcodec,
    acodec,
  };
}

export interface ParseOptions {
  /** 上传/指定的 cookies 文件（存在才带） */
  cookiesFile?: string | null;
  /** 从浏览器读取 cookies（''=不启用） */
  cookiesFromBrowser?: string;
  /** 额外参数（如代理），与下载保持一致 */
  extraArgs?: string[];
}

/** 调用 yt-dlp 解析视频信息（超时保护） */
export async function parseVideo(
  url: string,
  ytdlpBin = config.bins.ytdlp,
  timeoutMs = 60000,
  opts: ParseOptions = {},
): Promise<ParseResult> {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL 格式错误（仅支持 http/https）');
  const tool = await toolStatus(ytdlpBin, ['--version']);
  if (!tool.ok) throw new Error(`未安装 yt-dlp（或路径不正确）：${tool.error ?? ''}，请先安装：sudo apt install -y yt-dlp 或 pip3 install -U yt-dlp`);

  // 解析同样带上 cookies/代理：会员或需登录的视频，只有带登录态才拿得到元数据
  const cookiesArgs: string[] = opts.cookiesFile
    ? ['--cookies', opts.cookiesFile]
    : opts.cookiesFromBrowser
      ? ['--cookies-from-browser', opts.cookiesFromBrowser]
      : [];
  const args = [
    '-J',
    '--no-warnings',
    '--no-playlist',
    '--socket-timeout',
    '20',
    ...cookiesArgs,
    ...(opts.extraArgs ?? []),
    url,
  ];
  const info = await new Promise<YtDlpInfo>((resolve, reject) => {
    const child = spawn(ytdlpBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('解析超时（网络较慢或视频较大），请稍后重试'));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`解析失败：${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(humanizeYtDlpError(stderr || stdout)));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as YtDlpInfo);
      } catch {
        reject(new Error('解析结果无法识别（yt-dlp 输出异常）'));
      }
    });
  });

  const formatsRaw = Array.isArray(info.formats) ? info.formats : [];
  const formats = formatsRaw.map(normalizeFormat).filter((f): f is FormatOption => !!f);
  // 优先视频+音频且体积已知的 mp4
  const scored = formats
    .filter((f) => f.resolution !== 'audio' && f.ext === 'mp4')
    .sort((a, b) => (b.filesize ?? 0) - (a.filesize ?? 0));
  const fallback = formats.filter((f) => f.resolution !== 'audio').sort((a, b) => (b.filesize ?? 0) - (a.filesize ?? 0));
  const best = scored[0] ?? fallback[0] ?? formats[0] ?? null;

  return {
    platform: detectPlatform(url),
    title: info.title ?? url,
    thumbnail: info.thumbnail ?? null,
    durationSec: info.duration ?? null,
    author: info.uploader ?? info.channel ?? null,
    formats,
    defaultFormatId: best?.id ?? null,
    expectedBytes: best?.filesize ?? 0,
  };
}

/** yt-dlp 错误信息人性化（中文）—— 不预设「不绕过登录」，只说明该怎么办 */
export function humanizeYtDlpError(raw: string): string {
  const s = raw.toLowerCase();
  const has = (...keys: string[]): boolean => keys.some((k) => s.includes(k));

  // 频道会员专享（如 YouTube「高级VIP会员」）
  if (
    has("available to this channel's members", 'members-only', 'members only', 'join this channel', 'channel members', '会员专享', '会员可看')
  ) {
    return '该视频是「频道会员专享」（如高级VIP会员，只有会员账号能看）。若你本人是该频道会员，请在网页「设置 → 公开视频（yt-dlp）」上传该网站的 cookies.txt（用会员账号登录后导出），然后重试';
  }
  // 年龄限制
  if (has('confirm your age', 'age-restricted', 'age restricted', 'inappropriate for some users')) {
    return '该视频有年龄限制，必须带登录态：请在「设置 → 公开视频（yt-dlp）」上传 cookies.txt（或填「从浏览器读取 cookies」），然后重试';
  }
  // 登录 / 人机校验 / 需要 cookies
  if (has('sign in', 'login required', 'please log in', 'not a bot', 'this video requires login', 'use --cookies', 'cookies')) {
    return '该平台要求登录或人机校验：请在「设置 → 公开视频（yt-dlp）」上传 cookies.txt（或填「从浏览器读取 cookies」）后重试';
  }
  // 私有视频
  if (has('private video', 'this video is private')) {
    return '该视频为私有视频，只有有权限的账号能看：若你有权限，请在设置里上传 cookies.txt 后重试';
  }
  if (has('unsupported url')) return '当前平台不支持解析该链接';
  if (has('video unavailable') || s.includes('not available')) return '视频不可访问（可能已删除、地区限制或需要登录）';
  if (has('drm')) return '该视频受 DRM 保护（Widevine 等），任何下载工具都无法直接下载';
  if (has('timed out', 'timeout')) return '网络超时，请稍后重试';
  if (has('http error 404')) return '视频不存在（404）';
  if (has('no space left')) return '磁盘空间不足';
  if (has('is not a valid url')) return 'URL 格式错误';
  const firstLine = raw.trim().split('\n').filter(Boolean).pop() ?? raw;
  return `下载失败：${firstLine.replace(/^ERROR:\s*/i, '').slice(0, 300)}`;
}

/* ------------------------------------------------------------------ */
/* cookies / 额外参数（会员、登录、年龄限制视频）                        */
/* ------------------------------------------------------------------ */

export interface CookiesStatus {
  /** 当前生效的 cookies 文件路径 */
  cookiesFile: string;
  /** 默认路径（DOWNLOAD_ROOT/state/cookies.txt） */
  defaultPath: string;
  exists: boolean;
  sizeBytes: number;
  updatedAt: string | null;
  /** 设置里的「从浏览器读取 cookies」 */
  fromBrowser: string;
}

/** 把 "a --b 'c d'" 解析成参数数组（支持单双引号） */
export function parseExtraArgs(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const v = m[1] ?? m[2] ?? m[3] ?? '';
    if (v) out.push(v);
  }
  return out;
}

/** 生效的 cookies 路径（设置值优先，否则用默认路径） */
export function cookiesPathOf(settings?: { webvideoCookiesFile?: string }): string {
  const p = String(settings?.webvideoCookiesFile ?? '').trim();
  return p || config.webvideo.defaultCookiesFile;
}

/** 存在且可读的 cookies 文件（不存在返回 null） */
export function resolveCookiesFile(settings?: { webvideoCookiesFile?: string }): string | null {
  const p = cookiesPathOf(settings);
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/** 由设置推导解析参数（cookies / 额外参数），保证「解析」与「下载」用同一套凭据 */
export function parseOptionsFromSettings(settings?: {
  webvideoCookiesFile?: string;
  webvideoCookiesFromBrowser?: string;
  webvideoExtraArgs?: string;
}): ParseOptions {
  const cookiesFile = resolveCookiesFile(settings);
  return {
    cookiesFile,
    cookiesFromBrowser: cookiesFile ? '' : String(settings?.webvideoCookiesFromBrowser ?? '').trim(),
    extraArgs: parseExtraArgs(String(settings?.webvideoExtraArgs ?? '')),
  };
}

/** 查询 cookies 状态（给 /api/webvideo/cookies 用） */export async function cookiesStatus(): Promise<CookiesStatus> {
  const { getSettings } = await import('../services/settings');
  const s = getSettings();
  const file = cookiesPathOf(s);
  let exists = false;
  let sizeBytes = 0;
  let updatedAt: string | null = null;
  try {
    const st = fs.statSync(file);
    exists = st.isFile();
    sizeBytes = st.size;
    updatedAt = st.mtime.toISOString();
  } catch {
    /* 不存在 */
  }
  return {
    cookiesFile: file,
    defaultPath: config.webvideo.defaultCookiesFile,
    exists,
    sizeBytes,
    updatedAt,
    fromBrowser: String(s.webvideoCookiesFromBrowser ?? ''),
  };
}

/* ------------------------------------------------------------------ */
/* 「想尽办法」下载策略阶梯                                             */
/* ------------------------------------------------------------------ */

export interface DownloadAttempt {
  /** 展示给用户/日志用的中文名字 */
  label: string;
  /** 追加到本次 yt-dlp 调用的参数 */
  args: string[];
}

export interface AttemptContext {
  formatId: string;
  /** 已确认存在的 cookies 文件路径 */
  cookiesFile: string | null;
  /** ''=不启用 */
  cookiesFromBrowser: string;
  isYouTube: boolean;
}

/** YouTube 多客户端回退：某个客户端被限流/要求登录时换下一个 */
export const YOUTUBE_TRY_CLIENTS = 'youtube:player_client=default,tv,web_safari,android_vr,web_embedded,mweb';
/** 只走网页内嵌播放器（对部分受限视频可绕过 web 端校验） */
export const YOUTUBE_EMBEDDED_CLIENT = 'youtube:player_client=web_embedded,tv_embedded';

/**
 * 生成按「成功率优先」排序的下载方式序列：
 * 指定格式 -> cookies -> 最佳画质 -> 多客户端 -> 长重试/放宽校验 -> 浏览器指纹 ->
 * 单文件（跳过合并）-> 仅视频流 -> 仅音频保底。
 * 只有全部失败才会把任务判为失败。
 */
export function buildDownloadAttempts(ctx: AttemptContext): DownloadAttempt[] {
  const attempts: DownloadAttempt[] = [];
  const seen = new Set<string>();
  const push = (label: string, args: string[]): void => {
    const key = args.join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({ label, args });
  };

  const cookieArgs: string[] = ctx.cookiesFile
    ? ['--cookies', ctx.cookiesFile]
    : ctx.cookiesFromBrowser
      ? ['--cookies-from-browser', ctx.cookiesFromBrowser]
      : [];
  const withCookies = (args: string[]): string[] => [...cookieArgs, ...args];

  const best = ['-f', 'bv*+ba/b'];
  const singleFile = ['-f', 'b[ext=mp4]/b/bv*+ba'];
  const videoOnly = ['-f', 'bv*/bv'];
  const audioOnly = ['-f', 'ba/b'];
  const multiClient = ['--extractor-args', YOUTUBE_TRY_CLIENTS];
  const embedded = ['--extractor-args', YOUTUBE_EMBEDDED_CLIENT];

  // 1) 用户明确选定的格式（+cookies）
  if (ctx.formatId) {
    const f = `${ctx.formatId}+ba/${ctx.formatId}/bv*+ba/b`;
    if (cookieArgs.length) push('登录态 + 指定格式', withCookies(['-f', f]));
    push('指定格式', ['-f', f]);
  }
  // 2) 带登录态（cookies）的最佳画质 / 多客户端 —— 会员与登录受限视频的关键一步
  if (cookieArgs.length) {
    push('登录态 + 最佳画质', withCookies(best));
    if (ctx.isYouTube) push('登录态 + 多客户端', withCookies([...multiClient, ...best]));
  }
  // 3) 无登录态的各种尝试
  push('最佳画质', best);
  if (ctx.isYouTube) push('多客户端回退', [...multiClient, ...best]);
  push('长重试 + 放宽校验', [
    '--retries',
    '20',
    '--fragment-retries',
    '20',
    '--retry-sleep',
    '5',
    '--no-check-certificates',
    '--geo-bypass',
    ...best,
  ]);
  push('模拟浏览器指纹', ['--impersonate', 'chrome', ...best]);
  if (ctx.isYouTube) push('内嵌播放器客户端', [...embedded, ...singleFile]);
  push('单文件直下（跳过合并）', singleFile);
  push('仅视频流（可能无音轨）', videoOnly);
  push('仅音频（保底）', audioOnly);
  return attempts;
}


/* ------------------------------------------------------------------ */
/* 下载进程管理                                                        */
/* ------------------------------------------------------------------ */

interface AttemptFailure {
  label: string;
  message: string;
}

interface LaunchContext {
  commonArgs: string[];
  url: string;
}

interface RunningJob {
  child: ChildProcess | null;
  /** 本次任务的完整策略阶梯 */
  attempts: DownloadAttempt[];
  attemptIndex: number;
  attemptStartedAt: number;
  attemptErrors: AttemptFailure[];
  stdout: string;
  stderr: string;
  startedAt: number;
  lastProgress: { progress: number; speedBps: number; etaSec: number | null; totalBytes: number; downloadedBytes: number; text: string };
  exitCode: number | null;
  paused: boolean;
  cancelled: boolean;
}

const jobs = new Map<number, RunningJob>();

/** 汇总所有失败尝试，给出「试过什么」的最终错误 */
function buildFinalError(job: RunningJob): string {
  const last = job.attemptErrors[job.attemptErrors.length - 1];
  const base = last?.message ?? '下载失败（未知原因）';
  if (job.attemptErrors.length <= 1) return base;
  const tried = job.attemptErrors.map((e) => e.label).join('、');
  return `${base}（已自动尝试 ${job.attemptErrors.length} 种方式：${tried}）`;
}

/** 启动当前 attemptIndex 指向的那次尝试 */
function launchAttempt(taskId: number, job: RunningJob, ctx: LaunchContext): void {
  const attempt = job.attempts[job.attemptIndex];
  job.attemptStartedAt = Date.now();
  job.stdout = '';
  job.stderr = '';
  job.lastProgress = {
    progress: 0,
    speedBps: 0,
    etaSec: null,
    totalBytes: 0,
    downloadedBytes: 0,
    text: `方式 ${job.attemptIndex + 1}/${job.attempts.length}：${attempt.label}`,
  };
  const args = [...ctx.commonArgs, ...attempt.args, ctx.url];
  logger.info(`webvideo #${taskId} 尝试方式 ${job.attemptIndex + 1}/${job.attempts.length}：${attempt.label}`);
  const child = spawn(config.bins.ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  job.child = child;
  child.stdout?.on('data', (d: Buffer) => {
    const text = d.toString();
    job.stdout += text;
    for (const line of text.split('\n')) if (line.trim()) parseProgressLine(line, job);
  });
  child.stderr?.on('data', (d: Buffer) => {
    job.stderr += d.toString();
  });
  child.on('error', (e) => {
    job.stderr += `\n进程启动失败: ${e.message}`;
  });
  child.on('close', (code) => {
    if (job.cancelled) return;
    const exit = code ?? -1;
    if (exit === 0) {
      job.exitCode = 0;
      return;
    }
    const message = humanizeYtDlpError(job.stderr || job.stdout);
    const failedLabel = job.attempts[job.attemptIndex].label;
    job.attemptErrors.push({ label: failedLabel, message });
    const next = job.attemptIndex + 1;
    if (next < job.attempts.length) {
      job.attemptIndex = next;
      logger.warn(
        `webvideo #${taskId} 方式「${failedLabel}」失败（${message}），继续尝试「${job.attempts[next].label}」`,
      );
      launchAttempt(taskId, job, ctx);
      return;
    }
    job.exitCode = exit;
    logger.error(`webvideo #${taskId} 全部 ${job.attempts.length} 种方式均失败：${message}`);
  });
  // 若任务在启动瞬间处于暂停状态，直接冻结新进程
  if (job.paused) {
    try {
      process.kill(child.pid ?? 0, 'SIGSTOP');
    } catch {
      /* ignore */
    }
  }
}

function parseProgressLine(line: string, job: RunningJob): void {
  // 我们的 --progress-template 约定输出：PROG <downloaded> <total> <speed> <eta>
  const m = line.match(/PROG\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+|NA)/);
  if (m) {
    const downloaded = Number(m[1]);
    const total = Number(m[2]);
    const speed = Number(m[3]) / 8; // yt-dlp speed 单位 bytes/s，这里保持一致
    const eta = m[4] === 'NA' ? null : Number(m[4]);
    job.lastProgress = {
      downloadedBytes: downloaded,
      totalBytes: total,
      progress: total > 0 ? Math.min(99.9, (downloaded / total) * 100) : job.lastProgress.progress,
      speedBps: speed,
      etaSec: eta,
      text: `已下载 ${(downloaded / 1024 / 1024).toFixed(1)}MB`,
    };
    return;
  }
  const pct = line.match(/\[download\]\s+([\d.]+)%/);
  if (pct) {
    job.lastProgress.progress = Math.min(99.9, Number(pct[1]));
  }
}

function collectOutputFiles(dir: string, startedAt: number): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (e.name.endsWith('.part') || e.name.endsWith('.ytdl') || e.name.startsWith('.')) continue;
      try {
        const st = fs.statSync(p);
        if (st.size > 0 && st.mtimeMs >= startedAt - 2000) out.push(p);
      } catch {
        /* ignore */
      }
    }
  };
  walk(dir);
  return out;
}

export const webvideoModule: ModuleAdapter = {
  id: 'webvideo',

  async prepare(task): Promise<void> {
    if (!task.url) throw new Error('缺少视频 URL');
    const { tasksRepo } = await import('../core/db');
    let meta: ParseResult;
    try {
      const { getSettings } = await import('../services/settings');
      meta = await parseVideo(task.url, config.bins.ytdlp, 60000, parseOptionsFromSettings(getSettings()));
    } catch (e) {
      // 解析失败（会员专享/需登录/年龄限制/超时…）不再直接判任务失败，
      // 而是记下原因继续走「多重策略尽力下载」，只有全部方式都失败才算失败。
      const message = (e as Error).message;
      logger.warn(`webvideo #${task.id} 解析失败，仍将尝试下载：${message}`);
      tasksRepo.update(task.id, {
        title: task.title || task.url,
        error: null,
        payload: { ...(task.payload ?? {}), parseError: message },
        meta: { ...((task.meta as Record<string, unknown> | null) ?? {}), parseError: message },
      });
      return;
    }
    const formatId = String((task.payload ?? {}).formatId ?? meta.defaultFormatId ?? '');
    const chosen = meta.formats.find((f) => f.id === formatId) ?? meta.formats.find((f) => f.id === meta.defaultFormatId) ?? null;
    task.expectBytes = chosen?.filesize ?? meta.expectedBytes ?? 0;
    tasksRepo.update(task.id, {
      title: meta.title,
      platform: meta.platform,
      expectBytes: task.expectBytes,
      meta: {
        thumbnail: meta.thumbnail,
        durationSec: meta.durationSec,
        author: meta.author,
        resolution: chosen?.resolution ?? null,
        format: chosen?.ext ?? null,
        formats: meta.formats,
      },
      payload: { ...(task.payload ?? {}), formatId: chosen?.id ?? null },
    });
  },

  async start(task): Promise<void> {
    const tool = await toolStatus(config.bins.ytdlp, ['--version']);
    if (!tool.ok) throw new Error(`未安装 yt-dlp（${config.bins.ytdlp}）`);
    fs.mkdirSync(config.dirs.webTools, { recursive: true });
    const { getSettings } = await import('../services/settings');
    const settings = getSettings();
    const payload = task.payload ?? {};
    const formatId = String(payload.formatId ?? '');
    const url = task.url ?? '';

    // 组装通用参数（每次尝试都会带上）
    const commonArgs = [
      '--newline',
      '--no-playlist',
      '--no-warnings',
      '--continue',
      '--retries',
      '5',
      '--fragment-retries',
      '5',
      '--retry-sleep',
      '3',
      '--socket-timeout',
      '30',
      '--progress-template',
      'download:PROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.speed)s %(progress.eta)s',
      '-o',
      path.join(config.dirs.webTools, '%(title).150B [%(id)s].%(ext)s'),
    ];
    if (settings.maxSpeedBps > 0) commonArgs.push('-r', String(settings.maxSpeedBps));
    if (config.bins.ffmpeg) commonArgs.push('--ffmpeg-location', config.bins.ffmpeg);
    const extraArgs = parseExtraArgs(String(settings.webvideoExtraArgs ?? ''));
    if (extraArgs.length) commonArgs.push(...extraArgs);

    const cookiesFile = resolveCookiesFile(settings);
    const cookiesFromBrowser = cookiesFile ? '' : String(settings.webvideoCookiesFromBrowser ?? '').trim();
    const platform = task.platform || detectPlatform(url);
    const attempts = buildDownloadAttempts({
      formatId,
      cookiesFile,
      cookiesFromBrowser,
      isYouTube: platform === 'YouTube',
    });

    const startedAt = Date.now();
    const job: RunningJob = {
      child: null,
      attempts,
      attemptIndex: 0,
      attemptStartedAt: startedAt,
      attemptErrors: [],
      stdout: '',
      stderr: '',
      startedAt,
      lastProgress: { progress: 0, speedBps: 0, etaSec: null, totalBytes: 0, downloadedBytes: 0, text: '准备中' },
      exitCode: null,
      paused: false,
      cancelled: false,
    };
    jobs.set(task.id, job);
    launchAttempt(task.id, job, { commonArgs, url });

    const { tasksRepo } = await import('../core/db');
    tasksRepo.update(task.id, {
      status: 'downloading',
      error: null,
      startedAt: new Date().toISOString(),
      payload: { ...payload, formatId, attempts: attempts.map((a) => a.label) },
    });
    logger.info(
      `webvideo 任务已启动 #${task.id} url=${url} format=${formatId || 'default'} 策略数=${attempts.length}${
        cookiesFile ? ` cookies=${cookiesFile}` : cookiesFromBrowser ? ` cookies来自浏览器=${cookiesFromBrowser}` : ''
      }`,
    );
  },

  async poll(task): Promise<PollResult> {
    const job = jobs.get(task.id);
    if (!job) return { error: '下载进程不存在（服务可能重启过），请重试' };
    const p = job.lastProgress;
    if (job.exitCode === null) {
      return {
        progress: p.progress,
        speedBps: job.paused ? 0 : p.speedBps,
        etaSec: job.paused ? null : p.etaSec,
        totalBytes: p.totalBytes,
        downloadedBytes: p.downloadedBytes,
      };
    }
    // 所有尝试都已结束
    jobs.delete(task.id);
    if (job.exitCode !== 0) {
      return { error: buildFinalError(job) };
    }
    const files = collectOutputFiles(config.dirs.webTools, job.startedAt);
    if (files.length === 0) {
      return { error: '下载进程结束但没有找到输出文件' };
    }
    files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    const main = files[0];
    const size = fs.statSync(main).size;
    const base = path.basename(main).replace(/\.(mp4|mkv|webm|m4a|mp3|flv|mov|avi)$/i, '');
    return {
      progress: 100,
      speedBps: 0,
      totalBytes: size,
      downloadedBytes: size,
      etaSec: 0,
      done: { files: [main], originalName: `${base}.mp4`.replace(/\.mp4$/, path.extname(main)), sizeBytes: size },
    };
  },

  async pause(task): Promise<void> {
    const job = jobs.get(task.id);
    if (!job || job.exitCode !== null) return;
    job.paused = true;
    try {
      process.kill(job.child?.pid ?? 0, 'SIGSTOP');
    } catch {
      /* ignore */
    }
  },

  async resume(task): Promise<void> {
    const job = jobs.get(task.id);
    if (!job || job.exitCode !== null) return;
    job.paused = false;
    try {
      process.kill(job.child?.pid ?? 0, 'SIGCONT');
    } catch {
      /* ignore */
    }
  },

  async cancel(task): Promise<void> {
    const job = jobs.get(task.id);
    if (!job) return;
    job.cancelled = true;
    jobs.delete(task.id);
    const pid = job.child?.pid ?? 0;
    try {
      process.kill(pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }, 3000);
    } catch {
      /* ignore */
    }
  },
};
