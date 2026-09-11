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

/** 调用 yt-dlp 解析视频信息（超时保护） */
export async function parseVideo(url: string, ytdlpBin = config.bins.ytdlp, timeoutMs = 60000): Promise<ParseResult> {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL 格式错误（仅支持 http/https）');
  const tool = await toolStatus(ytdlpBin, ['--version']);
  if (!tool.ok) throw new Error(`未安装 yt-dlp（或路径不正确）：${tool.error ?? ''}，请先安装：sudo apt install -y yt-dlp 或 pip3 install -U yt-dlp`);

  const args = ['-J', '--no-warnings', '--no-playlist', '--socket-timeout', '20', url];
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

/** yt-dlp 错误信息人性化（中文） */
export function humanizeYtDlpError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes('unsupported url')) return '当前平台不支持解析该链接';
  if (s.includes('video unavailable') || s.includes('not available')) return '视频不可访问（可能已删除或地区限制）';
  if (s.includes('private video')) return '该视频为私有，无法下载（本工具不绕过登录/权限限制）';
  if (s.includes('sign in') || s.includes('login') || s.includes('cookies')) return '该平台需要登录，本工具不绕过登录限制';
  if (s.includes('drm')) return '该视频受 DRM 保护，无法下载';
  if (s.includes('timed out') || s.includes('timeout')) return '网络超时，请稍后重试';
  if (s.includes('http error 404')) return '视频不存在（404）';
  if (s.includes('no space left')) return '磁盘空间不足';
  if (s.includes('is not a valid url')) return 'URL 格式错误';
  const firstLine = raw.trim().split('\n').filter(Boolean).pop() ?? raw;
  return `下载失败：${firstLine.replace(/^ERROR:\s*/i, '').slice(0, 300)}`;
}

/* ------------------------------------------------------------------ */
/* 下载进程管理                                                        */
/* ------------------------------------------------------------------ */

interface RunningJob {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  startedAt: number;
  lastProgress: { progress: number; speedBps: number; etaSec: number | null; totalBytes: number; downloadedBytes: number; text: string };
  exitCode: number | null;
  paused: boolean;
}

const jobs = new Map<number, RunningJob>();

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
    const meta = await parseVideo(task.url);
    const formatId = String((task.payload ?? {}).formatId ?? meta.defaultFormatId ?? '');
    const chosen = meta.formats.find((f) => f.id === formatId) ?? meta.formats.find((f) => f.id === meta.defaultFormatId) ?? null;
    task.expectBytes = chosen?.filesize ?? meta.expectedBytes ?? 0;
    const { tasksRepo } = await import('../core/db');
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
    const payload = task.payload ?? {};
    const formatId = String(payload.formatId ?? '');
    const args = [
      '--newline',
      '--no-playlist',
      '--no-warnings',
      '--retries',
      '3',
      '--socket-timeout',
      '30',
      '--progress-template',
      'download:PROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.speed)s %(progress.eta)s',
      '-o',
      path.join(config.dirs.webTools, '%(title).150B [%(id)s].%(ext)s'),
    ];
    if (formatId) args.push('-f', formatId);
    else args.push('-f', 'bv*+ba/b');
    const settings = (await import('../services/settings')).getSettings();
    if (settings.maxSpeedBps > 0) args.push('-r', String(settings.maxSpeedBps));
    if (config.bins.ffmpeg) args.push('--ffmpeg-location', config.bins.ffmpeg);
    args.push(task.url ?? '');

    const startedAt = Date.now();
    const child = spawn(config.bins.ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const job: RunningJob = {
      child,
      stdout: '',
      stderr: '',
      startedAt,
      lastProgress: { progress: 0, speedBps: 0, etaSec: null, totalBytes: 0, downloadedBytes: 0, text: '准备中' },
      exitCode: null,
      paused: false,
    };
    jobs.set(task.id, job);
    child.stdout?.on('data', (d: Buffer) => {
      const text = d.toString();
      job.stdout += text;
      for (const line of text.split('\n')) if (line.trim()) parseProgressLine(line, job);
    });
    child.stderr?.on('data', (d: Buffer) => {
      job.stderr += d.toString();
    });
    child.on('close', (code) => {
      job.exitCode = code ?? -1;
    });
    child.on('error', (e) => {
      job.exitCode = -1;
      job.stderr += `\n进程启动失败: ${e.message}`;
    });
    const { tasksRepo } = await import('../core/db');
    tasksRepo.update(task.id, { status: 'downloading', startedAt: new Date().toISOString(), payload: { ...payload, formatId } });
    logger.info(`webvideo 任务已启动 #${task.id} url=${task.url} format=${formatId || 'default'}`);
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
    // 进程已退出
    jobs.delete(task.id);
    if (job.exitCode !== 0) {
      return { error: humanizeYtDlpError(job.stderr || job.stdout) };
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
      process.kill(job.child.pid ?? 0, 'SIGSTOP');
    } catch {
      /* ignore */
    }
  },

  async resume(task): Promise<void> {
    const job = jobs.get(task.id);
    if (!job || job.exitCode !== null) return;
    job.paused = false;
    try {
      process.kill(job.child.pid ?? 0, 'SIGCONT');
    } catch {
      /* ignore */
    }
  },

  async cancel(task): Promise<void> {
    const job = jobs.get(task.id);
    if (!job) return;
    jobs.delete(task.id);
    try {
      process.kill(job.child.pid ?? 0, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(job.child.pid ?? 0, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }, 3000);
    } catch {
      /* ignore */
    }
  },
};
