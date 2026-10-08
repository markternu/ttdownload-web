/**
 * 「更新」接口（页面 /update 用）
 *
 *   GET  /api/update/status   当前版本 / 远端版本 / 有无更新 / 上次升级结果 / 日志尾巴
 *   POST /api/update/check    立刻去远端检查（用户点「检查更新」）
 *   POST /api/update/apply    立刻升级（会先暂停下载，然后重启服务）
 *   GET  /api/update/log      升级日志（便于失败后排查）
 *
 * 鉴权：与其它 /api 一样，需要已登录（app.ts 里统一挂了 authMiddleware）。
 */
import { Router } from 'express';
import fs from 'node:fs';
import { asyncHandler, badRequest } from '../utils/http';
import { logger } from '../core/logger';
import { getSettings, updateSettings } from '../services/settings';
import {
  applyUpdate,
  canApply,
  checkForUpdate,
  getUpdateStatus,
  LOG_FILE,
  RESULT_FILE,
} from '../services/updater';

export const updateRouter = Router();

updateRouter.get('/update/status', (_req, res) => {
  res.json(getUpdateStatus());
});

updateRouter.post(
  '/update/check',
  asyncHandler(async (_req, res) => {
    const st = await checkForUpdate({ manual: true });
    res.json(st);
  }),
);

updateRouter.post(
  '/update/apply',
  asyncHandler(async (req, res) => {
    const manual = req.body?.manual !== false; // 页面点的默认就是"手动"
    const force = req.body?.force === true; // 用户明确知道版本号没变、也要装最新提交
    const st = getUpdateStatus();
    const decision = canApply(st, { manual: force ? true : manual });
    if (!decision.ok) throw badRequest(decision.reason ?? '当前不能升级');

    logger.child('update').mark('UPDATE_APPLY', `用户从页面发起升级：${st.currentVersion} → ${st.latestVersion ?? st.latestCommit ?? '最新提交'}`);
    const r = await applyUpdate({ manual: force ? true : manual });
    if (!r.ok) throw badRequest(r.reason ?? '升级启动失败');
    res.json({
      ok: true,
      message: `升级已开始：${st.currentVersion} → ${st.latestVersion ?? st.latestCommit}。正在暂停下载并重建，服务会在 1~3 分钟后自动重启（页面会短暂断开，刷新即可）。`,
      status: getUpdateStatus(),
    });
  }),
);

updateRouter.get(
  '/update/log',
  asyncHandler(async (_req, res) => {
    const read = (p: string, n = 200): string => {
      try {
        if (!fs.existsSync(p)) return '';
        return fs.readFileSync(p, 'utf8').split('\n').slice(-n).join('\n');
      } catch (e) {
        return `读取失败：${(e as Error).message}`;
      }
    };
    res.json({ log: read(LOG_FILE()), result: read(RESULT_FILE(), 50) });
  }),
);

/** 自动更新开关/间隔（页面上的设置项） */
updateRouter.post(
  '/update/settings',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { enabled?: unknown; intervalMin?: unknown; bootDelaySec?: unknown };
    const patch: { enabled?: boolean; intervalMin?: number; bootDelaySec?: number } = {};
    if (body.enabled !== undefined) patch.enabled = body.enabled === true || body.enabled === 'true';
    if (body.intervalMin !== undefined) {
      const n = Number(body.intervalMin);
      if (!Number.isFinite(n) || n < 1 || n > 24 * 60) throw badRequest('检查间隔要在 1 ~ 1440 分钟之间');
      patch.intervalMin = Math.round(n);
    }
    if (body.bootDelaySec !== undefined) {
      const n = Number(body.bootDelaySec);
      if (!Number.isFinite(n) || n < 0 || n > 3600) throw badRequest('开机延迟要在 0 ~ 3600 秒之间');
      patch.bootDelaySec = Math.round(n);
    }
    const next = updateSettings({ update: { ...getSettings().update, ...patch } });
    logger.child('update').info(`更新设置已保存：${JSON.stringify(next.update)}`);
    res.json({ ok: true, update: next.update });
  }),
);
