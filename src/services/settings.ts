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
    btSelect: { ...config.btSelect },
    btPolicy: { ...config.btPolicy },
    aria2Rpc: { ...config.aria2Rpc },
    transmissionRpc: { ...config.transmissionRpc },
    ytdlpPath: config.bins.ytdlp,
    ffmpegPath: config.bins.ffmpeg,
    transcodeQuality: '',
    webvideoCookiesFile: '',
    webvideoCookiesFromBrowser: config.webvideo.cookiesFromBrowser,
    webvideoExtraArgs: config.webvideo.extraArgs,
    autoDeleteAfterReport: true,
    cookieHarvestEnabled: config.cookieHarvestEnabled,
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
      btPolicy: { ...base.btPolicy, ...(parsed.btPolicy ?? {}) },
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

/**
 * 返回给前端 / 诊断包的设置（密钥类一律掩码）。
 *
 * ⚠️ 血案：这里以前只掩 `encryptPassword`，于是 aria2 的 secret 与 transmission 的
 * RPC 密码**明文**出现在「设置」接口和要发给开发者的诊断包里。
 */
export const MASK = '******';

export function getSettingsPublic(): Settings {
  const s = getSettings();
  return {
    ...s,
    encryptPassword: s.encryptPassword ? MASK : '',
    aria2Rpc: { ...s.aria2Rpc, secret: s.aria2Rpc.secret ? MASK : '' },
    transmissionRpc: { ...s.transmissionRpc, password: s.transmissionRpc.password ? MASK : '' },
  };
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
    btPolicy: { ...current.btPolicy, ...(patch.btPolicy ?? {}) },
  };
  // 掩码回传时保持原值（前端拿到的就是掩码，原样提交回来不能把密码清成 "******"）
  if (patch.encryptPassword === MASK) next.encryptPassword = current.encryptPassword;
  if (patch.transmissionRpc?.password === MASK) next.transmissionRpc.password = current.transmissionRpc.password;
  if (patch.aria2Rpc?.secret === MASK) next.aria2Rpc.secret = current.aria2Rpc.secret;
  cached = next;
  settingsRepo.setMany({ [KEY]: JSON.stringify(next) });
  return next;
}

/**
 * **真正生效**的 transmission RPC 连接信息：设置页（DB）优先，为空/未填时回落到 `.env`。
 *
 * ⚠️ 血案：BT 模块以前直接用 `config.transmissionRpc`（= 只读 `.env`），于是用户在
 * 网页「设置 → 网络设置 → transmission RPC」里填的用户名/密码**完全不起作用** ——
 * 而部署脚本和网络自检的提示都叫用户去那里填，结果怎么填都还是 HTTP 401。
 */
export function transmissionRpc(): { host: string; port: number; user: string; password: string } {
  let s: Partial<Settings['transmissionRpc']> = {};
  try {
    s = getSettings().transmissionRpc ?? {};
  } catch {
    /* 设置还没就绪（极少见）→ 回落 env */
  }
  const env = config.transmissionRpc;
  return {
    host: String(s.host ?? '') || env.host,
    port: Number(s.port) > 0 ? Number(s.port) : env.port,
    user: String(s.user ?? '') || env.user,
    password: String(s.password ?? '') || env.password,
  };
}

/** 真正生效的 aria2 RPC 连接信息（同上：设置页优先，回落 .env） */
export function aria2Rpc(): { host: string; port: number; secret: string } {
  let s: Partial<Settings['aria2Rpc']> = {};
  try {
    s = getSettings().aria2Rpc ?? {};
  } catch {
    /* ignore */
  }
  const env = config.aria2Rpc;
  return {
    host: String(s.host ?? '') || env.host,
    port: Number(s.port) > 0 ? Number(s.port) : env.port,
    secret: String(s.secret ?? '') || env.secret,
  };
}

/** 加密密码（真实值） */
export function encryptPassword(): string {
  return getSettings().encryptPassword || config.encryptPassword;
}
