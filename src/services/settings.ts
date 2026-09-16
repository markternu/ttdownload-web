import { config } from '../core/config';
import { settingsRepo } from '../core/db';
import { logger } from '../core/logger';
import type { Settings } from '../types';

const KEY = 'app_settings';

/**
 * 设置结构版本。给**已经部署的机器**做一次性修正用（它们数据库里存着旧设置，
 * 改默认值对它们不生效）。加新修正时把数字 +1，并在 migrateSettings 里写清楚原因。
 *
 *   0 -> 1：moduleConcurrency.transmission 的旧默认值是 1，导致用户上传一包种子
 *          （10 多个 .torrent）时**只有 1 个在下载**，其余全部排队，而磁盘和全局
 *          并发都还空着；当时那道门还是静默跳过，界面上只显示"等待"，用户完全
 *          无从排查。
 *   1 -> 2：承上。⚠️ 真正生效的默认值其实在 .env（`CONCURRENCY_TRANSMISSION=1`，
 *          由 deploy.sh 写入）——.env 优先级高于代码默认值，所以 schema 1 那次迁移
 *          把值"改成"了 config 里的 1，等于没改（真机上验证时抓到的）。
 *   2 -> 3：**并发上限不该是限制条件**。用户要求：只要还有可用空间就按先进先出
 *          一直放行，直到下一个装不下；空间回血（完成→安卓取走→服务端删除）
 *          再继续。所以把"我们曾经写死的那些默认值"统一改成 0 = 不限
 *          （maxConcurrent 3；transmission 1/3；aria2 2；webvideo 2）。
 *          用户自己调过的其它数字不动；想限制随时能在设置页改回去。
 */
export const SETTINGS_SCHEMA = 3;

export function migrateSettings(s: Settings): { next: Settings; notes: string[] } {
  if ((s.schemaVersion ?? 0) >= SETTINGS_SCHEMA) return { next: s, notes: [] };
  const notes: string[] = [];
  const mc = { ...(s.moduleConcurrency ?? config.moduleConcurrency) };
  // 老版本写死的默认值 -> 0（不限）。准入只由磁盘空间决定，别再用并发数卡任务。
  const OLD_DEFAULTS: Record<string, number[]> = { transmission: [1, 3], aria2: [2], webvideo: [2] };
  for (const key of Object.keys(OLD_DEFAULTS) as (keyof typeof mc)[]) {
    if (OLD_DEFAULTS[key].includes(Number(mc[key]))) {
      notes.push(`${key} 并发 ${mc[key]} -> 0（不限）`);
      mc[key] = 0;
    }
  }
  const next: Settings = { ...s, moduleConcurrency: mc, schemaVersion: SETTINGS_SCHEMA };
  if (s.maxConcurrent === 3) {
    next.maxConcurrent = config.maxConcurrent; // 0 = 不限
    notes.push(`全局并发 3 -> ${next.maxConcurrent}（0=不限）`);
  }
  if (notes.length) {
    notes.unshift('并发上限不再由写死的数字决定，改为「有磁盘空间就按先进先出接着下」');
  }
  return { next, notes };
}

export function defaultSettings(): Settings {
  return {
    maxConcurrent: config.maxConcurrent,
    defaultQuality: '1080p',
    defaultFormat: 'mp4',
    downloadRoot: config.dirs.root,
    reserveFreeBytes: config.reserveFreeBytes,
    maxSpeedBps: config.maxSpeedBps,
    requestTimeoutSec: config.requestTimeoutSec,
    autoRetry: config.autoRetry,
    theme: 'system',
    encryptPassword: config.encryptPassword,
    moduleConcurrency: { ...config.moduleConcurrency },
    btSelect: { ...config.btSelect, blockKeywords: [...(config.btSelect.blockKeywords ?? [])] },
    aria2Rpc: { ...config.aria2Rpc },
    transmissionRpc: { ...config.transmissionRpc },
    ytdlpPath: config.bins.ytdlp,
    ffmpegPath: config.bins.ffmpeg,
    transcodeQuality: '',
    webvideoCookiesFile: '',
    webvideoCookiesFromBrowser: config.webvideo.cookiesFromBrowser,
    webvideoExtraArgs: config.webvideo.extraArgs,
    autoDeleteAfterReport: true,
    scriptUploadEnabled: config.scriptUploadEnabled,
    cookieHarvestEnabled: config.cookieHarvestEnabled,
    scriptRunTimeoutSec: config.scriptRunTimeoutSec,
    clearLogsAfterReport: false,
    btEvict: { ...config.btEvict },
  };
}

let cached: Settings | null = null;

export function getSettings(): Settings {
  if (cached) return cached;
  const raw = settingsRepo.getAll()[KEY];
  const base = defaultSettings();
  if (!raw) {
    cached = base;
    return cached;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const merged: Settings = {
      ...base,
      ...parsed,
      moduleConcurrency: { ...base.moduleConcurrency, ...(parsed.moduleConcurrency ?? {}) },
      aria2Rpc: { ...base.aria2Rpc, ...(parsed.aria2Rpc ?? {}) },
      transmissionRpc: { ...base.transmissionRpc, ...(parsed.transmissionRpc ?? {}) },
      btEvict: { ...base.btEvict, ...(parsed.btEvict ?? {}) },
      btSelect: { ...base.btSelect, ...(parsed.btSelect ?? {}) },
    };
    const { next, notes } = migrateSettings(merged);
    cached = next;
    if (notes.length) {
      // 落盘 + 明确告诉用户改了什么（用户没主动改过，必须让他知道）
      settingsRepo.setMany({ [KEY]: JSON.stringify(next) });
      for (const n of notes) {
        logger.child('settings').warn(
          `[MARK:SETTINGS_MIGRATE] 已自动修正一项旧配置：${n} —— 如不想这样请到「设置」里改回去`);
      }
    }
  } catch {
    cached = base;
  }
  return cached;
}

/**
 * 丢掉缓存、重新从数据库读一遍设置（迁移逻辑也会再跑一次）。
 * 平时不用调；测试验证"老部署启动时被自动修正"就走这条路径。
 */
export function reloadSettings(): Settings {
  cached = null;
  return getSettings();
}

/** 返回给前端的设置（密码掩码） */
export function getSettingsPublic(): Settings {
  const s = getSettings();
  return { ...s, encryptPassword: s.encryptPassword ? '******' : '' };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const current = getSettings();
  const next: Settings = {
    ...current,
    ...patch,
    moduleConcurrency: { ...current.moduleConcurrency, ...(patch.moduleConcurrency ?? {}) },
    aria2Rpc: { ...current.aria2Rpc, ...(patch.aria2Rpc ?? {}) },
    transmissionRpc: { ...current.transmissionRpc, ...(patch.transmissionRpc ?? {}) },
    btEvict: { ...current.btEvict, ...(patch.btEvict ?? {}) },
    btSelect: { ...current.btSelect, ...(patch.btSelect ?? {}) },
  };
  // 密码掩码回传时保持原值
  if (patch.encryptPassword === '******') next.encryptPassword = current.encryptPassword;
  cached = next;
  settingsRepo.setMany({ [KEY]: JSON.stringify(next) });
  return next;
}

/** 加密密码（真实值） */
export function encryptPassword(): string {
  return getSettings().encryptPassword || config.encryptPassword;
}
