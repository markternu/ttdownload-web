/**
 * 鉴权接口：登录 / 退出 / 当前登录状态
 */
import { Router } from 'express';
import {
  authEnabled,
  authStatusLoggedIn,
  authStatusOf,
  checkCredentials,
  clearSessionCookie,
  logAuthBootState,
  loginBlocked,
  noteLoginFailure,
  noteLoginSuccess,
  setSessionCookie,
} from '../services/auth';
import { logger } from '../core/logger';
import { asyncHandler, badRequest } from '../utils/http';

export const authRouter = Router();

/** 当前登录状态（前端启动时调用；未登录返回 authenticated:false） */
authRouter.get('/me', (req, res) => {
  res.json(authStatusOf(req));
});

/** 登录：正确则种下 HttpOnly 会话 Cookie */
authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    if (!authEnabled()) {
      logAuthBootState();
      throw badRequest('服务端未配置账号密码（.env 的 WEB_AUTH_USER / WEB_AUTH_PASSWORD），当前无需登录', 'AUTH_DISABLED');
    }
    if (loginBlocked(req)) {
      logger.child('auth').warn('[MARK:AUTH] 登录尝试过于频繁，已临时拒绝', { ip: req.socket.remoteAddress });
      res.status(429).json({ error: { code: 'TOO_MANY_ATTEMPTS', message: '失败次数过多，请 1 分钟后再试' } });
      return;
    }
    const body = (req.body ?? {}) as { username?: string; password?: string; user?: string };
    const username = String(body.username ?? body.user ?? '').trim();
    const password = String(body.password ?? '');
    if (!username || !password) throw badRequest('请输入账号和密码', 'MISSING_CREDENTIALS');

    if (!checkCredentials(username, password)) {
      noteLoginFailure(req);
      logger.child('auth').warn(`[MARK:AUTH] 登录失败：账号或密码错误（user=${username}）`, {
        ip: String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '-'),
        ua: req.headers['user-agent'],
      });
      res.status(401).json({ error: { code: 'BAD_CREDENTIALS', message: '账号或密码错误' } });
      return;
    }

    noteLoginSuccess(req);
    setSessionCookie(req, res, username);
    const status = authStatusLoggedIn(username);
    logger.child('auth').mark('AUTH', `登录成功：${username}`, {
      ip: String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '-'),
      sessionHours: status.sessionHours,
    });
    res.json(status);
  }),
);

/** 退出：清除会话 Cookie */
authRouter.post('/logout', (req, res) => {
  clearSessionCookie(res);
  logger.child('auth').mark('AUTH', '已退出登录', {
    ip: String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '-'),
  });
  res.json({ ok: true, enabled: authEnabled(), authenticated: !authEnabled(), username: null });
});
