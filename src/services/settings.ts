import { config } from '../core/config';
import { settingsRepo } from '../core/db';
import type { Settings } from '../types';

const KEY = 'app_settings';

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
    cached = {
      ...base,
      ...parsed,
      moduleConcurrency: { ...base.moduleConcurrency, ...(parsed.moduleConcurrency ?? {}) },
      aria2Rpc: { ...base.aria2Rpc, ...(parsed.aria2Rpc ?? {}) },
      transmissionRpc: { ...base.transmissionRpc, ...(parsed.transmissionRpc ?? {}) },
      btEvict: { ...base.btEvict, ...(parsed.btEvict ?? {}) },
    };
  } catch {
    cached = base;
  }
  return cached;
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
