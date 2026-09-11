import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { aria2Client, ensureAria2Daemon } from './aria2Client';
import type { ModuleAdapter, PollResult, TaskWithPayload } from './types';

interface Aria2Status {
  gid: string;
  status: 'active' | 'waiting' | 'paused' | 'complete' | 'error' | 'removed';
  totalLength: string;
  completedLength: string;
  downloadSpeed: string;
  errorCode?: string;
  errorMessage?: string;
  files: { path: string; selected: string; uris?: { uri: string }[] }[];
  dir: string;
  uris?: { uri: string }[];
}

function guessFileName(url: string): string {
  try {
    const u = new URL(url);
    const base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
    return base && base.includes('.') ? base : '';
  } catch {
    return '';
  }
}

/** 请求 Content-Length（用于精确空间判断；失败返回 0） */
export async function probeRemoteSize(url: string, timeoutMs = 8000): Promise<number> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ac.signal });
    if (!res.ok) {
      res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'follow', signal: ac.signal });
    }
    const len = res.headers.get('content-length');
    if (len) return Number.parseInt(len, 10) || 0;
    const range = res.headers.get('content-range');
    if (range) {
      const total = range.split('/').pop();
      if (total) return Number.parseInt(total, 10) || 0;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

export const aria2Module: ModuleAdapter = {
  id: 'aria2',

  async prepare(task): Promise<void> {
    if (!task.url || !/^https?:\/\//i.test(task.url)) {
      throw new Error('URL 格式错误（仅支持 http/https）');
    }
    const size = await probeRemoteSize(task.url);
    if (size > 0) task.expectBytes = size;
  },

  async start(task): Promise<void> {
    const daemon = await ensureAria2Daemon();
    if (!daemon.ok) throw new Error(daemon.message);
    fs.mkdirSync(config.dirs.aria2, { recursive: true });
    const client = aria2Client();
    const name = guessFileName(task.url ?? '');
    const options: Record<string, string> = { dir: config.dirs.aria2, continue: 'true' };
    if (name) options.out = name;
    const gid = await client.call<string>('aria2.addUri', [[task.url], options]);
    const payload = { ...(task.payload ?? {}), gid, out: name || null };
    logger.info(`aria2 任务已创建 #${task.id} gid=${gid} url=${task.url}`);
    const { tasksRepo } = await import('../core/db');
    tasksRepo.update(task.id, { payload, status: 'downloading', startedAt: new Date().toISOString() });
  },

  async poll(task): Promise<PollResult> {
    const payload = task.payload ?? {};
    const gid = String(payload.gid ?? '');
    if (!gid) return { error: '缺少 aria2 gid（任务需重试）' };
    const client = aria2Client();
    let st: Aria2Status;
    try {
      st = await client.call<Aria2Status>('aria2.tellStatus', [gid, ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'files', 'errorCode', 'errorMessage', 'dir', 'uris']]);
    } catch (e) {
      return { error: `aria2 状态查询失败: ${(e as Error).message}` };
    }
    if (!st || !st.status) return { error: 'aria2 任务丢失（可能被外部删除）' };

    const total = Number.parseInt(st.totalLength || '0', 10) || 0;
    const completed = Number.parseInt(st.completedLength || '0', 10) || 0;
    const speed = Number.parseInt(st.downloadSpeed || '0', 10) || 0;
    const eta = speed > 0 && total > completed ? Math.round((total - completed) / speed) : null;
    const progress = total > 0 ? Math.min(100, (completed / total) * 100) : 0;

    if (st.status === 'complete') {
      const file = st.files?.[0]?.path ?? '';
      if (!file || !fs.existsSync(file)) {
        return { error: '下载完成但找不到文件' };
      }
      // 老脚本语义：必须没有 .aria2 控制文件才算真正完成
      if (fs.existsSync(`${file}.aria2`)) {
        return { progress: 100, speedBps: 0, totalBytes: total, downloadedBytes: completed, etaSec: 0 };
      }
      const size = fs.statSync(file).size;
      const originalName = path.basename(file);
      return {
        progress: 100,
        speedBps: 0,
        totalBytes: size,
        downloadedBytes: size,
        etaSec: 0,
        done: { files: [file], originalName, sizeBytes: size },
      };
    }

    if (st.status === 'error') {
      const map: Record<string, string> = {
        '1': '未知错误',
        '3': '资源不存在（404）',
        '8': '服务器不支持断点续传',
        '9': '磁盘空间不足',
        '13': '文件已存在',
        '16': '文件创建失败（权限/路径）',
        '19': '域名解析失败',
        '22': 'HTTP 响应异常',
        '23': '重试次数过多',
        '24': 'HTTP 认证失败',
        '29': '服务器繁忙，稍后重试',
      };
      const code = st.errorCode ?? '';
      return { error: `下载失败：${st.errorMessage || map[code] || `错误码 ${code}`}` };
    }

    if (st.status === 'removed') return { error: '任务已被移除' };
    if (st.status === 'paused') {
      return { status: 'paused', progress, speedBps: 0, totalBytes: total, downloadedBytes: completed };
    }
    return { progress, speedBps: speed, etaSec: eta, totalBytes: total, downloadedBytes: completed, expectBytes: total || task.expectBytes };
  },

  async pause(task): Promise<void> {
    const gid = String((task.payload ?? {}).gid ?? '');
    if (gid) await aria2Client().call('aria2.pause', [gid]).catch(() => undefined);
  },

  async resume(task): Promise<void> {
    const gid = String((task.payload ?? {}).gid ?? '');
    if (gid) await aria2Client().call('aria2.unpause', [gid]).catch(() => undefined);
  },

  async cancel(task): Promise<void> {
    const gid = String((task.payload ?? {}).gid ?? '');
    if (!gid) return;
    const client = aria2Client();
    await client.call('aria2.remove', [gid]).catch(() => undefined);
    await client.call('aria2.removeDownloadResult', [gid]).catch(() => undefined);
  },
};
