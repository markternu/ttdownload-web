/**
 * 全站鉴权
 *
 * 目标：**不管是通过 8080 直连还是走 nginx 反向代理，都必须先登录才能进系统**。
 *  - 网页/界面类接口：需要登录会话（HttpOnly Cookie，HMAC 签名，无状态、重启不掉线）
 *  - 安卓端接口（/api/android/*）：保持原有的 Token 鉴权（手机端没法做网页登录）
 *  - /api/health：公开（部署脚本健康检查用，不泄露敏感信息）
 *  - 程序化访问：也接受 HTTP Basic（账号密码同网页）或安卓 Token（方便 curl / aria2）
 *
 * 账号密码由部署脚本生成并写入 .env（WEB_AUTH_USER / WEB_AUTH_PASSWORD），
 * 未配置时视为"未开启鉴权"（仅用于本地开发/测试），但会在启动日志里显著告警。
 */
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../core/config';
import { logger } from '../core/logger';

const COOKIE_NAME = 'ttd_session';
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILS = 10;

export interface AuthStatus {
  enabled: boolean;
  /** 当前请求是否已通过鉴权 */
  authenticated: boolean;
  username: string | null;
  /** 会话有效期（小时） */
  sessionHours: number;
}

/* ------------------------------------------------------------------ */
/* 账号 / 密码 / 会话密钥                                              */
/* ------------------------------------------------------------------ */

export function authEnabled(): boolean {
  return Boolean(config.webAuth.user && config.webAuth.password);
}

function sessionSecret(): string {
  // 显式配置优先；否则用账号+密码派生（保证重启后会话仍有效，且不依赖额外配置）
  if (config.webAuth.sessionSecret) return config.webAuth.sessionSecret;
  return crypto.createHash('sha256').update(`${config.webAuth.user}|${config.webAuth.password}|ttdownload`).digest('hex');
}

function timingEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // 长度不同也要消耗一次比较，避免明显的长度侧信道
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/** 校验账号密码 */
export function checkCredentials(user: string, password: string): boolean {
  if (!authEnabled()) return true; // 未开启鉴权时视为通过（调用方仍会走 authEnabled 分支）
  return timingEqual(user, config.webAuth.user) && timingEqual(password, config.webAuth.password);
}

/* ------------------------------------------------------------------ */
/* 会话（无状态签名 Cookie）                                            */
/* ------------------------------------------------------------------ */

const b64url = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function signSession(user: string, ttlMs = config.webAuth.sessionHours * 3600_000): string {
  const exp = Date.now() + ttlMs;
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = `${user}|${exp}|${nonce}`;
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest();
  return `${b64url(Buffer.from(payload))}.${b64url(sig)}`;
}

export interface SessionInfo {
  valid: boolean;
  user: string | null;
  expiresAt: number | null;
}

export function verifySession(token: string | undefined): SessionInfo {
  if (!token || !token.includes('.')) return { valid: false, user: null, expiresAt: null };
  const [payloadPart, sigPart] = token.split('.');
  let payload: string;
  try {
    payload = fromB64url(payloadPart).toString('utf8');
  } catch {
    return { valid: false, user: null, expiresAt: null };
  }
  const expect = crypto.createHmac('sha256', sessionSecret()).update(payload).digest();
  let given: Buffer;
  try {
    given = fromB64url(sigPart ?? '');
  } catch {
    return { valid: false, user: null, expiresAt: null };
  }
  if (given.length !== expect.length || !crypto.timingSafeEqual(given, expect)) {
    return { valid: false, user: null, expiresAt: null };
  }
  const [user, expRaw] = payload.split('|');
  const exp = Number(expRaw);
  if (!user || !Number.isFinite(exp) || exp < Date.now()) return { valid: false, user: null, expiresAt: exp || null };
  if (!timingEqual(user, config.webAuth.user)) return { valid: false, user: null, expiresAt: exp };
  return { valid: true, user, expiresAt: exp };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function sessionFromRequest(req: Request): SessionInfo {
  const cookies = parseCookies(req.headers.cookie);
  const fromCookie = verifySession(cookies[COOKIE_NAME]);
  if (fromCookie.valid) return fromCookie;
  // 便于程序化调用：Authorization: Bearer <session>
  const auth = String(req.headers.authorization ?? '');
  if (/^Bearer\s+/i.test(auth)) return verifySession(auth.replace(/^Bearer\s+/i, '').trim());
  return { valid: false, user: null, expiresAt: null };
}

/** 程序化访问：HTTP Basic（账号密码同网页）或安卓 Token */
function programmaticOk(req: Request): boolean {
  const auth = String(req.headers.authorization ?? '');
  if (/^Basic\s+/i.test(auth)) {
    try {
      const [u, p] = Buffer.from(auth.replace(/^Basic\s+/i, '').trim(), 'base64').toString('utf8').split(':');
      if (checkCredentials(u ?? '', p ?? '')) return true;
    } catch {
      /* 忽略，继续尝试其它方式 */
    }
  }
  const token = String(req.headers['x-auth-token'] ?? req.query.token ?? '');
  if (token && config.androidToken && timingEqual(token, config.androidToken)) return true;
  return false;
}

export function setSessionCookie(req: Request, res: Response, user: string): void {
  const token = signSession(user);
  const secure = req.secure || String(req.headers['x-forwarded-proto'] ?? '').includes('https');
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.round(config.webAuth.sessionHours * 3600)}`,
  ];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/* ------------------------------------------------------------------ */
/* 登录失败限流（内存计数，防暴力破解）                                  */
/* ------------------------------------------------------------------ */

const failures = new Map<string, { count: number; first: number }>();

function clientIp(req: Request): string {
  return String((req.headers['x-forwarded-for'] as string) ?? req.socket.remoteAddress ?? '-').split(',')[0].trim();
}

export function loginBlocked(req: Request): boolean {
  const rec = failures.get(clientIp(req));
  if (!rec) return false;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) {
    failures.delete(clientIp(req));
    return false;
  }
  return rec.count >= LOGIN_MAX_FAILS;
}

export function noteLoginFailure(req: Request): void {
  const ip = clientIp(req);
  const rec = failures.get(ip);
  if (!rec || Date.now() - rec.first > LOGIN_WINDOW_MS) failures.set(ip, { count: 1, first: Date.now() });
  else rec.count += 1;
}

export function noteLoginSuccess(req: Request): void {
  failures.delete(clientIp(req));
}

/* ------------------------------------------------------------------ */
/* 中间件                                                             */
/* ------------------------------------------------------------------ */

/** 无需登录即可访问的 API（安卓端自己用 Token 鉴权；health 供部署脚本探活） */
function isPublicApi(path: string): boolean {
  if (path === '/api/health') return true;
  if (path === '/api/auth/login' || path === '/api/auth/me' || path === '/api/auth/logout') return true;
  if (path.startsWith('/api/android/')) return true;
  return false;
}

/** 全站鉴权中间件：挂在静态资源之后、业务路由之前 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!authEnabled()) {
    // 未配置账号密码 → 不拦截，但启动时已告警
    next();
    return;
  }
  // 中间件挂在 /api 下，req.path 只有 '/health' 等，这里拼回完整路径再判断白名单
  const fullPath = `${req.baseUrl ?? ''}${req.path ?? ''}`;
  if (isPublicApi(fullPath.split('?')[0])) {
    next();
    return;
  }
  const session = sessionFromRequest(req);
  if (session.valid || programmaticOk(req)) {
    next();
    return;
  }
  logger.child('auth').warn(`[MARK:AUTH] 未授权访问被拒绝: ${req.method} ${req.originalUrl}`, { ip: clientIp(req) });
  res.status(401).json({
    error: {
      code: 'UNAUTHORIZED',
      message: '需要登录：请先在本页面登录（账号密码见部署时输出的「网页登录账号」）',
    },
  });
}

/** /api/auth/me 用 */
export function authStatusOf(req: Request): AuthStatus {
  const session = sessionFromRequest(req);
  const ok = !authEnabled() || session.valid || programmaticOk(req);
  return {
    enabled: authEnabled(),
    authenticated: ok,
    username: session.user ?? (ok && authEnabled() ? 'programmatic' : null),
    sessionHours: config.webAuth.sessionHours,
  };
}

/** 刚登录成功时的状态：**不能**用 authStatusOf(req)（那时请求里还没有 Cookie） */
export function authStatusLoggedIn(user: string): AuthStatus {
  return { enabled: authEnabled(), authenticated: true, username: user, sessionHours: config.webAuth.sessionHours };
}

/** 启动时打印鉴权状态（让日志里能一眼看到有没有开鉴权） */
export function logAuthBootState(): void {
  if (authEnabled()) {
    logger.mark('BOOT', `网页鉴权：已开启（账号 ${config.webAuth.user}，会话 ${config.webAuth.sessionHours} 小时；密码见 .env 的 WEB_AUTH_PASSWORD）`);
  } else {
    logger.child('auth').warn('[MARK:AUTH] ⚠️ 未配置 WEB_AUTH_USER / WEB_AUTH_PASSWORD：**当前任何人都能直接访问系统**！');
    logger.child('auth').warn('   修复：在 .env 里设置 WEB_AUTH_USER=admin 与 WEB_AUTH_PASSWORD=<强密码> 后重启；或在部署脚本里重新生成');
  }
}
