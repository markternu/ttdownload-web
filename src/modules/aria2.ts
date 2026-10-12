import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { logger, taskLog } from '../core/logger';
import { aria2Client, ensureAria2Daemon, type Aria2Options } from './aria2Client';
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

/** 看着像文件名吗（有扩展名）—— 决定"能不能拿来当标题/out 用" */
export function looksLikeFileName(name: string): boolean {
  return /\.[A-Za-z0-9]{2,6}$/.test(String(name ?? '').trim());
}

/** URL 路径最后一段（去掉查询串） */
function lastPathSegment(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
  } catch {
    return '';
  }
}

/**
 * 从 URL 取"给 aria2 用的文件名"——**只在真像文件名时才返回**，
 * 否则返回空串（让 aria2 用服务器给的 Content-Disposition / 重定向后的真名）。
 *
 * ⚠️ 血案：以前不管像不像文件名都拿来当标题，于是 `.../download?id=123` 这种
 * 直链的**所有任务都叫 "download"**，用户根本分不清谁是谁。
 */
export function guessFileName(url: string): string {
  const base = lastPathSegment(url);
  return base && looksLikeFileName(base) ? base : '';
}

/**
 * URL 里的"基础名"：路径最后一段；取不到就用 `download`。
 * 例：`https://cdn/download?id=1` → `download`；`https://x/a/movie.mp4` → `movie.mp4`
 */
export function baseNameOfUrl(url: string): string {
  const seg = lastPathSegment(url);
  return seg || 'download';
}

/**
 * 给**新任务**起标题 —— 用户明确要求（原话）：
 *   "Url 直链下载可能就是没有什么特定的名字，但是绝对不能所有的 Url 直链下载任务都叫 download。
 *    download1，download2，download3，download4…downloadn 这样也能接受。"
 *
 * 规则：
 *   ① URL 最后一段像文件名（有扩展名）→ 用它；重名就在扩展名前加序号：`movie.mp4` → `movie2.mp4`
 *   ② 不像文件名（例如 `.../download?id=xxx`）→ **一律编号**：`download1`、`download2`、…
 *   ③ 编号只保证"不和已有任务重名"（第一个也是 download1，和用户给的样子一致）
 *
 * @param used 已占用的标题集合（会就地更新）。传 undefined 时只算一个、不查重。
 */
export function titleForNewTask(url: string, used?: Set<string>): string {
  const base = baseNameOfUrl(url);
  if (used && used.has(base) === false && looksLikeFileName(base)) {
    used.add(base);
    return base;
  }
  if (!used && looksLikeFileName(base)) return base;

  // 带扩展名的重名 → movie.mp4 / movie2.mp4；不带扩展名 → download1 / download2 …
  const dot = looksLikeFileName(base) ? base.lastIndexOf('.') : -1;
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const start = dot > 0 ? 2 : 1;
  for (let i = start; i < 100000; i += 1) {
    const cand = `${stem}${i}${ext}`;
    if (!used || !used.has(cand)) {
      used?.add(cand);
      return cand;
    }
  }
  return `${stem}${Date.now()}${ext}`;
}

/**
 * "连接类"失败？—— 这类错误多半是**服务器把多余/并发的连接掐了**，
 * 换成单连接重来一次往往就成功（用户实测：同样的链接，终端里 `aria2c <url>`
 * 单连接能下，而网页任务 16 并发时报
 * "SSL/TLS handshake failure: The TLS connection was non-properly terminated."）。
 */
export function isConnectionError(message: string): boolean {
  return /SSL|TLS|handshake|non-properly|reset by peer|connection reset|timed?\s*out|timeout|socket|EOF|unable to connect|connection refused|too many|temporarily unavailable|502|503|504|429/i.test(
    String(message ?? ''),
  );
}

/** 单连接（保守）参数：连接类失败后的兜底重试用 */
const CONSERVATIVE: Aria2Options = {
  split: '1',
  'max-connection-per-server': '1',
  'min-split-size': '1M',
  'max-tries': '5',
  'retry-wait': '3',
};

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

/**
 * 每个任务一个独立目录 —— 对齐用户手动的做法（`mkdir tmp1 && cd tmp1 && aria2c -i url`）。
 *
 * 为什么必须这样：我们把不同 URL 下到**同一个目录**，而 `.../download?id=x` 这类链接
 * 在服务器上很可能都叫同一个名字（或都被 Content-Disposition 成同一个名），
 * 两个任务同时写同一个文件 → 互相覆盖/续传串味 → 表现就是"其中两个莫名其妙报错"。
 * 目录**记在 payload 里**（`downloadDir`），重试/续传仍用同一个目录，不会重新下。
 */
export function taskDownloadDir(taskId: number, url: string, payload: Record<string, unknown> = {}): string {
  const saved = String(payload.downloadDir ?? '');
  if (saved) return saved;
  const base = guessFileName(url) || (() => {
    try {
      const u = new URL(url);
      return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      return 'download';
    }
  })();
  const slug = base.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'download';
  return path.join(config.dirs.aria2, `${taskId}-${slug}`);
}

/** 统一的 addUri 参数（保守模式走单连接） */
function addOptions(dir: string, name: string, conservative: boolean): Aria2Options {
  const options: Aria2Options = { dir, continue: 'true' };
  if (name) options.out = name;
  if (conservative) Object.assign(options, CONSERVATIVE);
  return options;
}

/**
 * 用留档的地址**重新加回** aria2（gid 丢了的时候用）。
 * 保住原来的目录/out/保守模式，恢复后继续下（`continue=true` 会接着下已下好的部分）。
 * 返回一个"这一轮什么都没变"的 PollResult —— **不是错误**，任务继续跑。
 */
async function reAddUri(task: TaskWithPayload, reason: string): Promise<PollResult> {
  const payload = task.payload ?? {};
  const { tasksRepo } = await import('../core/db');
  try {
    const client = aria2Client();
    const name = guessFileName(task.url ?? '');
    const dir = taskDownloadDir(task.id, task.url ?? '', payload);
    fs.mkdirSync(dir, { recursive: true });
    const gid = await client.call<string>('aria2.addUri', [[task.url], addOptions(dir, name, payload.singleConnection === true)]);
    tasksRepo.update(task.id, {
      status: 'downloading',
      error: null,
      payload: { ...payload, gid, reAddedAt: new Date().toISOString(), statusMissingCount: 0, statusFailCount: 0, statusRetryAt: 0 },
    });
    taskLog(task.id).mark('ARIA2_RETRY', `${reason} → 已重新加入 aria2（新 gid ${gid}），继续下载`);
    return {};
  } catch (e) {
    // 重新加不进去（daemon 还没起来等）→ 退避后再试，同样不判失败
    const fails = Number(payload.statusFailCount ?? 0) + 1;
    tasksRepo.update(task.id, {
      payload: { ...payload, statusFailCount: fails, statusRetryAt: Date.now() + Math.min(60_000, 5_000 * fails), lastStatusError: (e as Error).message },
    });
    return {};
  }
}

/**
 * 把任务标题从"占位名"刷成 aria2 解析出来的**真实文件名**。
 *
 * 为什么需要：`.../download?id=123` 这类链接在 URL 里根本没有文件名，
 * 下完之前只能给个能区分的占位（host/path）；一旦 aria2 从
 * Content-Disposition 或重定向拿到了真名（就是 `files[0].path` 的 basename），
 * 立刻换成真名，用户在列表里才认得出。
 * 只改"占位标题"（不像文件名的），用户/其它逻辑写过的真名不动。
 */
function maybeRenameToRealFile(task: TaskWithPayload, st: Aria2Status): string | null {
  const real = path.basename(String(st.files?.[0]?.path ?? ''));
  if (!real || !looksLikeFileName(real)) return null;
  if (String(task.title ?? '') === real) return null;
  if (looksLikeFileName(String(task.title ?? ''))) return null; // 已经是文件名了，别乱改
  return real;
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
    const payload0 = task.payload ?? {};
    const conservative = payload0.singleConnection === true;
    const name = guessFileName(task.url ?? '');
    // 任务专属目录（重试/续传复用同一个目录，不会白下）
    const dir = taskDownloadDir(task.id, task.url ?? '', payload0);
    fs.mkdirSync(dir, { recursive: true });
    const gid = await client.call<string>('aria2.addUri', [[task.url], addOptions(dir, name, conservative)]);
    const payload = { ...payload0, gid, out: name || null, downloadDir: dir };
    logger.info(`aria2 任务已创建 #${task.id} gid=${gid} url=${task.url}${conservative ? '（单连接保守模式）' : ''}`);
    const { tasksRepo } = await import('../core/db');
    tasksRepo.update(task.id, { payload, status: 'downloading', startedAt: new Date().toISOString() });
  },

  async poll(task): Promise<PollResult> {
    const payload = task.payload ?? {};
    const gid = String(payload.gid ?? '');
    if (!gid) return { error: '缺少 aria2 gid（任务需重试）' };
    const client = aria2Client();
    const { tasksRepo } = await import('../core/db');

    // 上一次状态查询刚失败过 → 先歇一会儿再查（daemon 忙的时候别死命捶它，
    // 也避免每个 tick 都白等一个超时把整轮轮询拖住）
    const retryAt = Number(payload.statusRetryAt ?? 0);
    if (retryAt > Date.now()) return {};

    let st: Aria2Status;
    try {
      st = await client.call<Aria2Status>('aria2.tellStatus', [gid, ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'files', 'errorCode', 'errorMessage', 'dir', 'uris']], 4000);
    } catch (e) {
      const msg = String((e as Error).message ?? '');
      /**
       * ⚠️ 用户明确要求：**"只是什么查询状态失败，只要能下载就不管它"**。
       * 这里以前是 `return { error: 'aria2 状态查询失败: …' }` → 调度器 failTask →
       * 任务被判失败并重试（重试还会再 addUri 一次！），而 aria2 那边其实**下得好好的**。
       * 现在：
       *   · "gid 不存在"（aria2 重启过 / 被外部删掉）连续出现 → 用留档的地址**重新加回**，任务继续；
       *   · 其它（超时/网络抖动/This operation was aborted）→ **绝不让任务失败**，
       *     只退避一会儿再查，连续多次才写一条提示（下载不受影响）。
       */
      if (/not found|GID|No such|未找到/i.test(msg)) {
        const miss = Number(payload.statusMissingCount ?? 0) + 1;
        if (miss < 3) {
          tasksRepo.update(task.id, { payload: { ...payload, statusMissingCount: miss } });
          return {};
        }
        return reAddUri(task, `aria2 里已经没有这个任务（${msg}）`);
      }
      const fails = Number(payload.statusFailCount ?? 0) + 1;
      const backoffMs = Math.min(60_000, 5_000 * fails);
      tasksRepo.update(task.id, {
        payload: { ...payload, statusFailCount: fails, statusRetryAt: Date.now() + backoffMs, lastStatusError: msg },
      });
      if (fails === 1 || fails % 10 === 0) {
        logger.child('aria2').warn(
          `任务 #${task.id} 状态查询失败（第 ${fails} 次，${Math.round(backoffMs / 1000)}s 后再查）：${msg} —— 下载不受影响，不判失败`);
      }
      // 连续失败才提示用户（偶尔一次抖动不用打扰）；hint 不是 error，任务照旧在下载
      return fails >= 3
        ? { hint: `aria2 状态查询暂时超时（已重试 ${fails} 次，下载不受影响，继续观察）` }
        : {};
    }
    if (!st || !st.status) {
      // RPC 通了但没给状态：同样不判失败
      const fails = Number(payload.statusFailCount ?? 0) + 1;
      tasksRepo.update(task.id, { payload: { ...payload, statusFailCount: fails, statusRetryAt: Date.now() + 5000 } });
      return {};
    }
    // 查到了 → 清掉失败计数与那条提示
    if (payload.statusFailCount || payload.statusMissingCount || payload.statusRetryAt || payload.lastStatusError) {
      tasksRepo.update(task.id, {
        payload: { ...payload, statusFailCount: 0, statusMissingCount: 0, statusRetryAt: 0, lastStatusError: null },
      });
    }

    const total = Number.parseInt(st.totalLength || '0', 10) || 0;
    const completed = Number.parseInt(st.completedLength || '0', 10) || 0;
    const speed = Number.parseInt(st.downloadSpeed || '0', 10) || 0;
    const eta = speed > 0 && total > completed ? Math.round((total - completed) / speed) : null;
    const progress = total > 0 ? Math.min(100, (completed / total) * 100) : 0;

    // aria2 已经把真实文件名解析出来了（Content-Disposition / 重定向后的名字）→
    // 把列表里那个占位标题（host/path 之类）换成真名，用户一眼就知道下的是什么
    const realName = maybeRenameToRealFile(task, st);
    if (realName) {
      const { tasksRepo } = await import('../core/db');
      tasksRepo.update(task.id, { title: realName });
      taskLog(task.id).mark('ARIA2_TITLE', `已用真实文件名作标题：${realName}`);
    }

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
      const raw = st.errorMessage || map[code] || `错误码 ${code}`;

      // 连接类失败（服务器把手握/连接掐了）→ 自动换**单连接**再试一次。
      // 真机现象：同样的链接终端里 aria2c 能下，我们这里 16 并发就报
      // "SSL/TLS handshake failure ... non-properly terminated"；
      // 以前只会原样重试（还是 16 并发）→ 必然再失败，用户看到的就是"莫名其妙失败"。
      if (isConnectionError(raw) && payload.singleConnection !== true) {
        try {
          await client.call('aria2.remove', [gid]).catch(() => undefined);
          await client.call('aria2.removeDownloadResult', [gid]).catch(() => undefined);
          const name = guessFileName(task.url ?? '');
          const dir = taskDownloadDir(task.id, task.url ?? '', payload);
          const newGid = await client.call<string>('aria2.addUri', [[task.url], addOptions(dir, name, true)]);
          tasksRepo.update(task.id, {
            payload: { ...payload, gid: newGid, singleConnection: true, singleConnectionAt: new Date().toISOString(), lastAria2Error: raw },
            error: null,
            status: 'downloading',
          });
          taskLog(task.id).mark('ARIA2_RETRY', `连接被服务器掐断（${raw}）→ 已自动改用**单连接**重试（gid ${newGid}）`);
          logger.child('aria2').mark('ARIA2_RETRY', `任务 #${task.id} 连接类失败 → 单连接重试：${raw}`);
          return { progress: 0, speedBps: 0, totalBytes: 0, downloadedBytes: 0, etaSec: null };
        } catch (e) {
          taskLog(task.id).warn(`单连接重试也没能建起来：${(e as Error).message}`);
        }
      }
      return { error: `下载失败：${raw}` };
    }

    if (st.status === 'removed') return { error: '任务已被移除' };
    if (st.status === 'paused') {
      // hint: null = 把之前那条"状态查询超时"提示清掉（查询正常了）
      return { status: 'paused', progress, speedBps: 0, totalBytes: total, downloadedBytes: completed, hint: null };
    }
    return { progress, speedBps: speed, etaSec: eta, totalBytes: total, downloadedBytes: completed, expectBytes: total || task.expectBytes, hint: null };
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
