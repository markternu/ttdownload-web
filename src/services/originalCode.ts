import crypto from 'node:crypto';
import type { Request } from 'express';

/**
 * 「下载原始文件」的 6 位轮换密码 —— 单独一个模块，**不依赖数据库/其它服务**，
 * 这样命令行（deploy.sh --orig-code）也能直接算，不用为了看一眼密码就把 DB 也打开。
 *
 * 设计：
 *   · .env 里只放**种子** `ORIGINAL_DL_SECRET`（不放进版本库、不写进日志）；
 *   · 6 位数字 = HMAC-SHA256(种子, "original-dl:<窗口序号>") 取模 100 万；
 *   · 窗口 = 15 分钟，所以数字每 15 分钟自动换一次（不需要改 .env、不需要重启）；
 *   · 校验时**容忍上一个窗口**：用户在窗口末尾看到密码、切过来输入时可能已经跨窗口。
 */

/** 密码窗口：15 分钟换一次 */
export const CODE_WINDOW_MS = 15 * 60_000;
/** 输对之后免问多久（与密码窗口同长，用户要求"15 分钟内不再询问"） */
export const UNLOCK_TTL_MS = 15 * 60_000;
/** 连续输错多少次就暂时拒绝（6 位数只有 100 万种，必须挡暴力猜） */
export const MAX_ATTEMPTS = 8;

/** .env 里的种子；不配置就说明这个功能没启用 */
export function codeSecret(): string {
  return String(process.env.ORIGINAL_DL_SECRET ?? '').trim();
}

export function originalDownloadEnabled(): boolean {
  return codeSecret().length >= 16;
}

/** 由种子 + 时间窗口算出 6 位数字（零填充） */
export function codeForWindow(secret: string, windowIndex: number): string {
  const mac = crypto.createHmac('sha256', secret).update(`original-dl:${windowIndex}`).digest();
  const n = mac.readUInt32BE(0) % 1_000_000;
  return String(n).padStart(6, '0');
}

export function windowIndexOf(now = Date.now()): number {
  return Math.floor(now / CODE_WINDOW_MS);
}

/** 当前窗口的密码 */
export function currentCode(now = Date.now()): string {
  const secret = codeSecret();
  return secret ? codeForWindow(secret, windowIndexOf(now)) : '';
}

/** 当前窗口还剩多少秒 */
export function secondsLeftInWindow(now = Date.now()): number {
  return Math.ceil((CODE_WINDOW_MS - (now % CODE_WINDOW_MS)) / 1000);
}

function timingEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 校验用户输入的 6 位密码（容忍上一个窗口） */
export function verifyCode(input: string, now = Date.now()): boolean {
  const secret = codeSecret();
  if (!secret) return false;
  const digits = String(input ?? '').trim();
  if (!/^\d{6}$/.test(digits)) return false;
  const w = windowIndexOf(now);
  return [w, w - 1].some((idx) => timingEqualStr(codeForWindow(secret, idx), digits));
}

/* ------------------------------------------------------------------ */
/*  免问状态（按"浏览器会话"记，15 分钟）                                 */
/* ------------------------------------------------------------------ */

const unlockedUntil = new Map<string, number>();
const attempts = new Map<string, { count: number; resetAt: number }>();

/** 用会话 cookie 当键；没有会话（关了鉴权）就退化成按客户端 IP */
export function sessionKeyOf(req: Request): string {
  const cookie = String(req.headers.cookie ?? '');
  const m = /(?:^|;\s*)ttd_session=([^;]+)/.exec(cookie);
  const raw = m?.[1] ? decodeURIComponent(m[1]) : String(req.headers.authorization ?? '') || String(req.ip ?? '');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export function unlockSecondsLeft(key: string, now = Date.now()): number {
  const until = unlockedUntil.get(key) ?? 0;
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}

export function isUnlocked(key: string, now = Date.now()): boolean {
  return unlockSecondsLeft(key, now) > 0;
}

export type UnlockResult =
  | { ok: true; secondsLeft: number }
  | { ok: false; reason: 'disabled' | 'bad' | 'locked'; retryAfterSec?: number };

export function tryUnlock(key: string, input: string, now = Date.now()): UnlockResult {
  if (!originalDownloadEnabled()) return { ok: false, reason: 'disabled' };

  const a = attempts.get(key);
  if (a && a.resetAt > now && a.count >= MAX_ATTEMPTS) {
    return { ok: false, reason: 'locked', retryAfterSec: Math.ceil((a.resetAt - now) / 1000) };
  }

  if (!verifyCode(input, now)) {
    attempts.set(key, a && a.resetAt > now ? { count: a.count + 1, resetAt: a.resetAt } : { count: 1, resetAt: now + CODE_WINDOW_MS });
    return { ok: false, reason: 'bad' };
  }

  attempts.delete(key);
  unlockedUntil.set(key, now + UNLOCK_TTL_MS);
  return { ok: true, secondsLeft: Math.round(UNLOCK_TTL_MS / 1000) };
}

/** 生成一个随机种子（部署脚本用） */
export function generateSecret(): string {
  return crypto.randomBytes(24).toString('hex');
}

/** 清理过期的免问记录/失败计数（内存卫生） */
export function pruneUnlockState(now = Date.now()): void {
  for (const [k, v] of unlockedUntil) if (v <= now) unlockedUntil.delete(k);
  for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
}
