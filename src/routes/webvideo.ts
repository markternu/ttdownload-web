import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../core/config';
import { tasksRepo } from '../core/db';
import { kickScheduler } from '../core/scheduler';
import { logger } from '../core/logger';
import {
  COOKIE_MARKER,
  cookiesForUrl,
  harvestNow,
  harvestStatus,
} from '../services/cookieHarvest';
import type { ParseOptions } from '../modules/webvideo';
import {
  buildDownloadAttempts,
  cookiesPathOf,
  cookiesStatus,
  detectPlatform,
  parseOptionsFromSettings,
  parseVideo,
  resolveCookiesFile,
  supportedPlatforms,
} from '../modules/webvideo';
import { asyncHandler, badRequest } from '../utils/http';

export const webvideoRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

webvideoRouter.get('/platforms', (_req, res) => {
  res.json({ platforms: supportedPlatforms() });
});

/** 网络自检：网页首页「网络自检」面板用（DNS/HTTPS/yt-dlp/YouTube/CDN/RPC） */
webvideoRouter.get(
  '/network',
  asyncHandler(async (req, res) => {
    const { networkReport } = await import('../services/netCheck');
    const force = String(req.query.refresh ?? '') === '1' || String(req.query.refresh ?? '') === 'true';
    res.json(await networkReport(force));
  }),
);

/* ---------------- cookies（会员 / 登录 / 年龄限制视频） ---------------- */

/** cookies 状态 + 上一份备份信息（上传会覆盖，保留 .bak 便于回退） */
async function cookiesStatusWithBackup(): Promise<Record<string, unknown>> {
  const status = await cookiesStatus();
  const backupPath = `${status.cookiesFile}.bak`;
  let backup: { exists: boolean; sizeBytes: number; updatedAt: string | null } = {
    exists: false,
    sizeBytes: 0,
    updatedAt: null,
  };
  try {
    const st = fs.statSync(backupPath);
    backup = { exists: true, sizeBytes: st.size, updatedAt: st.mtime.toISOString() };
  } catch {
    /* 没有备份 */
  }
  return { ...status, backup };
}

webvideoRouter.get(
  '/cookies',
  asyncHandler(async (_req, res) => {
    res.json(await cookiesStatusWithBackup());
  }),
);

/* ---------------- 自动获取访客 cookies（无头浏览器） ---------------- */

/**
 * 各站 cookies 状态：哪些站点能自动获取、是否已抓过、多久之前抓的。
 * 用户最常问的就是「难道要天天人工导出 cookies 吗」——这里给出自动化的实际状态。
 */
webvideoRouter.get(
  '/cookies/harvest',
  asyncHandler(async (_req, res) => {
    const status = harvestStatus();
    const { getSettings } = await import('../services/settings');
    const enabled = (getSettings() as { cookieHarvestEnabled?: boolean }).cookieHarvestEnabled !== false;
    res.json({
      ...status,
      enabled,
      hint:
        status.chromium === null
          ? '服务器上没有 chromium，无法自动获取 cookies：sudo apt install -y chromium（Debian/Ubuntu/树莓派）'
          : enabled
            ? '已开启：需要新鲜访客 cookies 的站点（如抖音）会由服务器上的无头浏览器自动获取并定期续期，不需要人工导出'
            : '已关闭自动获取（设置里可打开）',
    });
  }),
);

/** 手动刷新某个站点的 cookies（设置页「立即刷新」按钮） */
webvideoRouter.post(
  '/cookies/harvest',
  asyncHandler(async (req, res) => {
    const site = String(req.body?.site ?? '').trim();
    if (!site) throw badRequest('请指定要刷新的站点（site）', 'MISSING_SITE');
    try {
      const meta = await harvestNow(site);
      res.json({ ok: true, meta, status: harvestStatus() });
    } catch (e) {
      const err = e as { status?: number; message: string };
      throw badRequest(err.message, 'HARVEST_FAILED');
    }
  }),
);

/** 上传 cookies.txt：支持 multipart(file) 或 JSON/文本体（text 字段） */
webvideoRouter.post(
  '/cookies',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { text?: string };
    const content = req.file?.buffer?.toString('utf8') ?? (typeof body.text === 'string' ? body.text : '');
    if (!content.trim()) throw badRequest('cookies 内容为空：请上传 Netscape 格式的 cookies.txt', 'EMPTY_COOKIES');
    const { getSettings } = await import('../services/settings');
    const target = cookiesPathOf(getSettings());
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 上传前先备份上一份：如果新导出是"没登录"的残缺文件，还能把好的换回来
    try {
      if (fs.existsSync(target) && fs.statSync(target).size > 0) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backup = `${target}.bak`;
        fs.copyFileSync(target, backup);
        fs.writeFileSync(`${target}.bak.info`, `备份时间：${new Date().toISOString()}\n`, { mode: 0o600 });
        logger.child('webvideo').mark('SETTINGS', `上传新 cookies 前已备份旧文件到 ${backup}（${stamp}）`);
      }
    } catch {
      /* 备份失败不阻断上传 */
    }
    fs.writeFileSync(target, content, { mode: 0o600 });
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      /* ignore */
    }
    logger.info(`已保存公开视频 cookies：${target}（${content.length} 字节）`);
    res.json(await cookiesStatusWithBackup());
  }),
);

webvideoRouter.delete(
  '/cookies',
  asyncHandler(async (_req, res) => {
    const { getSettings } = await import('../services/settings');
    const target = cookiesPathOf(getSettings());
    try {
      fs.unlinkSync(target);
      logger.info(`已删除公开视频 cookies：${target}`);
    } catch {
      /* 本来就不存在 */
    }
    res.json(await cookiesStatusWithBackup());
  }),
);

/** 预览本次任务会按什么顺序去尝试（便于排查） */
webvideoRouter.get('/attempts', (req, res) => {
  const url = String(req.query.url ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  res.json({
    attempts: buildDownloadAttempts({
      formatId: String(req.query.formatId ?? ''),
      cookiesFile: resolveCookiesFile(),
      cookiesFromBrowser: '',
      isYouTube: detectPlatform(url) === 'YouTube',
    }).map((a) => a.label),
  });
});

webvideoRouter.post(
  '/parse',
  asyncHandler(async (req, res) => {
    const url = String(req.body?.url ?? '').trim();
    if (!url) throw badRequest('请输入视频链接', 'MISSING_URL');
    if (!/^https?:\/\//i.test(url)) throw badRequest('URL 格式错误（仅支持 http/https）', 'INVALID_URL');
    try {
      const { getSettings } = await import('../services/settings');
      const settings = getSettings();
      // 解析同样要带「站点需要的 cookies」：抖音这类站点没有新鲜访客 cookies 连元数据都拿不到
      const base = parseOptionsFromSettings(settings);
      const siteCookies = await cookiesForUrl(url, resolveCookiesFile(settings));
      const opts: ParseOptions = {
        cookiesFile: siteCookies.cookiesFile,
        cookiesFromBrowser: siteCookies.cookiesFile ? '' : base.cookiesFromBrowser,
        extraArgs: [...(base.extraArgs ?? []), ...siteCookies.extraArgs],
      };
      if (siteCookies.harvested) {
        logger.info(`[MARK:${COOKIE_MARKER}] 解析使用自动获取的 cookies（${siteCookies.note}）`);
      }
      const result = await parseVideo(url, config.bins.ytdlp, 60000, opts);
      logger.info(`解析成功: ${result.platform} - ${result.title}`);
      res.json(result);
    } catch (e) {
      // 解析失败不阻断用户：返回 degraded 结果（前端可以“仍然下载”），
      // 真正能不能下交给下载时的多重策略去试。
      const message = (e as Error).message;
      logger.warn(`解析失败 ${url}: ${message}`);
      res.json({
        degraded: true,
        parseError: message,
        platform: detectPlatform(url),
        title: url,
        thumbnail: null,
        durationSec: null,
        author: null,
        formats: [],
        defaultFormatId: null,
        expectedBytes: 0,
      });
    }
  }),
);

webvideoRouter.post(
  '/tasks',
  asyncHandler(async (req, res) => {
    const url = String(req.body?.url ?? '').trim();
    if (!url || !/^https?:\/\//i.test(url)) throw badRequest('URL 格式错误（仅支持 http/https）', 'INVALID_URL');
    const formatId = req.body?.formatId ? String(req.body.formatId) : '';
    const quality = req.body?.quality ? String(req.body.quality) : '';
    const title = req.body?.title ? String(req.body.title) : url;

    const dup = tasksRepo
      .list({ modules: ['webvideo'], statuses: ['waiting', 'parsing', 'downloading', 'paused', 'archiving', 'encrypting'], pageSize: 200 })
      .items.find((t) => t.url === url && (!formatId || String((t as { payload?: Record<string, unknown> }).payload?.formatId ?? '') === formatId));
    if (dup) {
      res.json({ task: dup, duplicated: true });
      return;
    }

    const task = tasksRepo.create({
      module: 'webvideo',
      title,
      platform: detectPlatform(url),
      url,
      status: 'waiting',
      payload: { formatId, quality },
      meta: { format: null, resolution: quality || null },
    });
    kickScheduler();
    logger.child('webvideo').mark('TASK_CREATE', `公开视频任务已入队 #${task.id}`, {
      url,
      formatId: formatId || '(默认)',
      quality: quality || undefined,
      title,
    });
    res.json({ task, duplicated: false });
  }),
);

webvideoRouter.get('/tasks', (_req, res) => {
  const { items, total } = tasksRepo.list({ modules: ['webvideo'], pageSize: 100 });
  res.json({ items, total });
});
