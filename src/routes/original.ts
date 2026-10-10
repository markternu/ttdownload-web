import { Router } from 'express';
import fs from 'node:fs';
import { asyncHandler, badRequest, forbidden, notFound, streamFileTo } from '../utils/http';
import { logger } from '../core/logger';
import {
  CODE_WINDOW_MS,
  UNLOCK_TTL_MS,
  currentCode,
  isUnlocked,
  originalDownloadEnabled,
  secondsLeftInWindow,
  sessionKeyOf,
  tryUnlock,
  unlockSecondsLeft,
} from '../services/originalCode';
import { cancelJob, dropJob, getJob, listJobs, publicJob, startOriginalJob } from '../services/originalDownload';
import { tarEnd, tarHeader, tarPadding } from '../utils/tar';

/**
 * 「下载原始文件」：把加密归档临时解密成原样再下载。
 *
 * 鉴权：整个 /api 都已在 authMiddleware 后面（必须登录）；这里再叠一层
 * **每 15 分钟换一次的 6 位数字密码**（由 .env 里的 ORIGINAL_DL_SECRET 推导）。
 */
export const originalRouter = Router();

/** 状态：功能是否启用、当前会话是否还在免问期内 */
originalRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    const key = sessionKeyOf(req);
    res.json({
      enabled: originalDownloadEnabled(),
      unlocked: isUnlocked(key),
      unlockSecondsLeft: unlockSecondsLeft(key),
      unlockTtlSec: Math.round(UNLOCK_TTL_MS / 1000),
      codeWindowSec: Math.round(CODE_WINDOW_MS / 1000),
      codeValidSec: originalDownloadEnabled() ? secondsLeftInWindow() : 0,
      tempMaxAgeSec: 3600,
    });
  }),
);

/** 校验 6 位密码；成功后 15 分钟内不再问 */
originalRouter.post(
  '/unlock',
  asyncHandler(async (req, res) => {
    const key = sessionKeyOf(req);
    const code = String(req.body?.code ?? '');
    const r = tryUnlock(key, code);
    if (r.ok) {
      logger.child('original').mark('ORIGINAL_DL', '下载原始文件：密码校验通过');
      res.json({ ok: true, unlockSecondsLeft: r.secondsLeft });
      return;
    }
    if (r.reason === 'disabled') throw badRequest('服务端未配置 ORIGINAL_DL_SECRET，该功能未启用', 'ORIGINAL_DL_DISABLED');
    if (r.reason === 'locked') {
      res.status(429).json({
        error: { code: 'TOO_MANY_ATTEMPTS', message: `密码错误次数过多，请 ${r.retryAfterSec ?? 0} 秒后再试` },
      });
      return;
    }
    throw forbidden('下载密码不正确（6 位数字，每 15 分钟换一次）', 'BAD_ORIGINAL_CODE');
  }),
);

/** 发起解密任务（后台跑，前端轮询进度） */
originalRouter.post(
  '/jobs',
  asyncHandler(async (req, res) => {
    const key = sessionKeyOf(req);
    if (!isUnlocked(key)) throw forbidden('请先输入下载密码', 'ORIGINAL_LOCKED');
    const fileId = Number(req.body?.fileId);
    if (!Number.isInteger(fileId) || fileId <= 0) throw badRequest('缺少 fileId', 'MISSING_FILE_ID');

    const r = startOriginalJob(fileId, key);
    if (!r.ok) {
      if (r.code === 'FILE_NOT_FOUND' || r.code === 'FILE_MISSING') throw notFound(r.error);
      throw badRequest(r.error, r.code);
    }
    res.json({ job: publicJob(r.job) });
  }),
);

/**
 * 批量「下载原始文件」（文件页全选 → 全部下载原始文件）。
 *
 * 为什么要批量接口：浏览器对"同一站点同时下载几个"有硬限制（Chrome 约 6 个），
 * 一个个点，第 7 个就得排队等前面的下完。这里改成：
 *   ① 一次把选中的文件**全部**丢进解密队列（解密本来就是并行的，只受磁盘周转空间限制）；
 *   ② 前端等它们都 ready 后，走 `GET /bulk/download` **打成一个 tar 一次下载**（一条连接 → 没有数量限制）。
 */
originalRouter.post(
  '/bulk',
  asyncHandler(async (req, res) => {
    const key = sessionKeyOf(req);
    if (!isUnlocked(key)) throw forbidden('请先输入下载密码', 'ORIGINAL_LOCKED');
    const raw: unknown[] = Array.isArray(req.body?.fileIds) ? req.body.fileIds : [];
    const fileIds = [...new Set(raw.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
    if (!fileIds.length) throw badRequest('请先选择文件（fileIds 不能为空）', 'EMPTY_IDS');
    if (fileIds.length > 200) throw badRequest('一次最多解密 200 个文件', 'TOO_MANY_IDS');

    const jobs: Record<string, unknown>[] = [];
    const failed: { fileId: number; error: string; code?: string }[] = [];
    for (const fileId of fileIds) {
      const r = startOriginalJob(fileId, key);
      if (r.ok) jobs.push(publicJob(r.job));
      else failed.push({ fileId, error: r.error, code: r.code });
    }
    logger.child('original').mark('ORIGINAL_DL', `批量解密：受理 ${jobs.length} 个，拒绝 ${failed.length} 个`, {
      fileIds: fileIds.length,
      accepted: jobs.length,
      failed: failed.slice(0, 5),
    });
    res.json({ jobs, failed });
  }),
);

/**
 * 批量下载：把已经解密好的临时文件打成一个 tar（一个连接）。
 * 全部写完后按单文件同样的规则**立刻删除临时文件**；中断则保留，交给 1 小时超时清理。
 */
originalRouter.get(
  '/bulk/download',
  asyncHandler(async (req, res) => {
    const key = sessionKeyOf(req);
    if (!isUnlocked(key)) throw forbidden('请先输入下载密码', 'ORIGINAL_LOCKED');
    const ids = String(req.query.jobs ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) throw badRequest('缺少 jobs（解密任务 id 列表）', 'MISSING_JOBS');

    const picked: { job: ReturnType<typeof getJob> & object; size: number }[] = [];
    const notReady: string[] = [];
    for (const id of ids) {
      const job = getJob(id);
      if (!job || !job.startedBy || job.startedBy !== key) {
        notReady.push(id);
        continue;
      }
      if (job.state !== 'ready' || !fs.existsSync(job.tempPath)) {
        notReady.push(id);
        continue;
      }
      picked.push({ job, size: fs.statSync(job.tempPath).size });
    }
    if (!picked.length) throw badRequest('没有已就绪的文件（可能还在解密，或已被清理）', 'NOT_READY');

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const total = picked.reduce((sum, p) => sum + p.size, 0);
    logger.child('original').mark('ORIGINAL_DL', `批量下载原始文件：${picked.length} 个（${(total / 1024 ** 2).toFixed(1)} MiB）`, {
      jobs: picked.map((p) => p.job.id),
      skipped: notReady.length,
    });
    res.setHeader('Content-Type', 'application/x-tar');
    res.setHeader('Content-Disposition', `attachment; filename="original-${stamp}.tar"`);
    res.setHeader('Content-Length', String(picked.reduce((sum, p) => sum + 512 + p.size + tarPadding(p.size), 0) + 1024));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Bulk-Files', String(picked.length));
    if (notReady.length) res.setHeader('X-Bulk-Skipped', String(notReady.length));

    for (const p of picked) p.job.streaming += 1;
    let done = false;
    res.once('close', () => {
      if (done) return;
      for (const p of picked) {
        p.job.streaming = Math.max(0, p.job.streaming - 1);
        // 中断 → 保留临时文件，交给 1 小时超时清理（和单文件下载同一条规矩）
        p.job.readyAt = p.job.readyAt ?? Date.now();
      }
      logger.child('original').warn('批量下载原始文件被中断（临时文件保留，1 小时内可重试）');
    });

    try {
      for (const p of picked) {
        const name = p.job.originalName || `file-${p.job.fileId}`;
        res.write(tarHeader(name, p.size));
        await new Promise<void>((resolve, reject) => {
          const src = fs.createReadStream(p.job.tempPath, { highWaterMark: 1 << 20 });
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
            const pad = tarPadding(p.size);
            if (pad) res.write(Buffer.alloc(pad));
            resolve();
          });
        });
      }
      done = true;
      res.end(tarEnd());
      // 写完了 → 判定"下载完成" → 立刻删临时文件（用户要求的规矩）
      for (const p of picked) {
        p.job.streaming = Math.max(0, p.job.streaming - 1);
        if (p.job.streaming === 0) dropJob(p.job.id, '批量下载完成');
      }
    } catch (e) {
      logger.child('original').warn(`批量打包下载中断：${(e as Error).message}`);
      res.destroy();
    }
  }),
);

/** 当前会话的任务列表（页面刷新后也要能看到"还在解密"） */
originalRouter.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const key = sessionKeyOf(req);
    res.json({ jobs: listJobs(key).map(publicJob) });
  }),
);

originalRouter.get(
  '/jobs/:id',
  asyncHandler(async (req, res) => {
    const job = getJob(String(req.params.id));
    if (!job) throw notFound('任务不存在（可能已完成并清理，或已过期）');
    res.json({ job: publicJob(job) });
  }),
);

/** 取消并立刻删掉临时文件 */
originalRouter.delete(
  '/jobs/:id',
  asyncHandler(async (req, res) => {
    const ok = cancelJob(String(req.params.id));
    res.json({ ok });
  }),
);

/**
 * 真正下载解密出来的原始文件。
 *
 * 文件名处理是这个接口的重点：原始文件名里可能有空格、#、?、%、中文、emoji……
 * 所以按 RFC 6266 / RFC 5987 同时给两个头：
 *   filename="…"            —— 纯 ASCII 兜底（老客户端）
 *   filename*=UTF-8''…      —— 百分号转义的真名（现代浏览器用这个）
 * 注意 encodeURIComponent 不会转义 ' ( ) * ，而 RFC 5987 的 attr-char 里没有它们，必须补转。
 */
originalRouter.get(
  '/jobs/:id/download',
  asyncHandler(async (req, res) => {
    const job = getJob(String(req.params.id));
    if (!job) throw notFound('任务不存在（可能已完成并清理，或已过期）');
    if (job.state !== 'ready') throw badRequest(`文件还没准备好（当前状态：${job.state}）`, 'NOT_READY');
    if (!fs.existsSync(job.tempPath)) throw notFound('临时文件已被清理，请重新解密');

    const name = job.originalName || 'original';
    const asciiFallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

    logger.child('original').mark('ORIGINAL_DL', `下载原始文件 #${job.fileId}：${name}`, {
      sizeBytes: job.contentBytes,
    });

    res.setHeader('Content-Type', 'application/octet-stream');
    // 两个都给：老客户端读 filename，现代浏览器优先 filename*
    res.setHeader('Content-Disposition', `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`);
    res.setHeader('Content-Length', String(fs.statSync(job.tempPath).size));
    // 让前端也能拿到真名（有些浏览器对 Content-Disposition 处理不一）
    res.setHeader('X-Original-Filename', encoded);
    res.setHeader('Cache-Control', 'no-store');

    job.streaming += 1;
    let settled = false;
    /**
     * 用户要求的两条清理规则，这里是分界线：
     *   · 响应**写完**（res.writableFinished）→ 判定"下载完成" → **立刻**删临时文件。
     *   · 只是连接关闭/客户端中断 → **无法确认下完** → 不删，交给后台 1 小时超时清理
     *     （这样用户还能重试下载，而不会白解密一次）。
     */
    const settle = (reason: string): void => {
      if (settled) return;
      settled = true;
      job.streaming = Math.max(0, job.streaming - 1);
      const completed = res.writableFinished === true;
      logger.child('original').mark('ORIGINAL_DL', `下载原始文件${completed ? '完成' : '中断'}（${reason}）`, {
        fileId: job.fileId,
        bytesSent: completed ? job.contentBytes : undefined,
      });
      if (completed && job.streaming === 0) {
        cancelAndDrop(job.id);      // 完成 → 立即清理
      } else {
        // 中断 → 保留，等 1 小时超时清理（或用户重新下载）
        job.readyAt = job.readyAt ?? Date.now();
      }
    };
    res.once('finish', () => settle('响应已完成'));
    res.once('close', () => settle('连接关闭'));
    streamFileTo(res, job.tempPath);
  }),
);

/** 下载结束后清掉临时文件与任务记录 */
function cancelAndDrop(id: string): void {
  const job = getJob(id);
  if (!job) return;
  try {
    fs.rmSync(job.tempPath, { force: true });
  } catch {
    /* ignore */
  }
  cancelJob(id);
}

/** 给命令行/诊断用：当前密码与剩余有效期（不对外暴露成接口） */
export function codeInfo(): { enabled: boolean; code: string; validSec: number; windowMin: number } {
  return {
    enabled: originalDownloadEnabled(),
    code: originalDownloadEnabled() ? currentCode() : '',
    validSec: originalDownloadEnabled() ? secondsLeftInWindow() : 0,
    windowMin: Math.round(CODE_WINDOW_MS / 60000),
  };
}
