import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './core/config';
import { logger } from './core/logger';
import { HttpError } from './utils/http';
import { authRouter } from './routes/auth';
import { authMiddleware } from './services/auth';
import { systemRouter } from './routes/system';
import { tasksRouter } from './routes/tasks';
import { aria2Router } from './routes/aria2';
import { btRouter } from './routes/bt';
import { webvideoRouter } from './routes/webvideo';
import { filesRouter } from './routes/files';
import { androidRouter } from './routes/android';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: false }));

  // 访问日志 + 耗时（调试期：请求/响应/异常都有标记，便于 grep）
  app.use((req, res, next) => {
    const startedAt = Date.now();
    const ip = (req.headers['x-forwarded-for'] as string) ?? req.socket.remoteAddress ?? '-';
    logger.child('http').mark('HTTP_REQ', `${req.method} ${req.originalUrl}`, {
      ip,
      ua: req.headers['user-agent'],
      query: Object.keys(req.query ?? {}).length ? req.query : undefined,
      contentLength: req.headers['content-length'],
    });
    res.on('finish', () => {
      const ms = Date.now() - startedAt;
      const payload = {
        status: res.statusCode,
        ms,
        bytes: res.getHeader('content-length') ?? undefined,
        ip,
      };
      if (res.statusCode >= 500) logger.child('http').error(`[MARK:HTTP_RES] ${req.method} ${req.originalUrl} -> ${res.statusCode}（${ms}ms）`, payload);
      else if (res.statusCode >= 400) logger.child('http').warn(`[MARK:HTTP_RES] ${req.method} ${req.originalUrl} -> ${res.statusCode}（${ms}ms）`, payload);
      else logger.child('http').mark('HTTP_RES', `${req.method} ${req.originalUrl} -> ${res.statusCode}（${ms}ms）`, payload);
    });
    res.on('close', () => {
      if (!res.writableFinished) {
        logger.child('http').warn(`连接提前中断 ${req.method} ${req.originalUrl}（${Date.now() - startedAt}ms）`);
      }
    });
    next();
  });

  // 鉴权：/api/auth/* 用于登录；其余 /api 一律要求已登录（安卓端接口用 Token，见 services/auth）
  app.use('/api/auth', authRouter);
  app.use('/api', authMiddleware);

  app.use('/api', systemRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/aria2', aria2Router);
  app.use('/api/bt', btRouter);
  app.use('/api/webvideo', webvideoRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/android', androidRouter);

  app.get('/api', (_req, res) => {
    res.json({
      name: 'ttdownload-web',
      version: config.version,
      endpoints: ['/api/health', '/api/stats', '/api/tasks', '/api/aria2/urls', '/api/bt/seeds', '/api/webvideo/parse', '/api/files', '/api/android/files'],
    });
  });

  // 前端静态资源（Vite 构建产物），不存在时给出提示
  const publicDir = path.resolve(__dirname, '..', 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, { index: 'index.html', maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res
        .status(200)
        .type('html')
        .send('<h1>ttdownload-web</h1><p>前端尚未构建，请执行 <code>npm run build:web</code>，或先访问 <a href="/api/health">/api/health</a> 检查后端。</p>');
    });
  }

  // 统一错误处理（所有异常都写进日志文件，含堆栈）
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const stack = err instanceof Error ? err.stack : String(err);
    if (err instanceof HttpError) {
      if (err.status >= 500) logger.child('http').error(`[MARK:HTTP_ERR] ${err.code}: ${err.message}`, { stack });
      else logger.child('http').debug(`[MARK:HTTP_ERR] ${err.code}: ${err.message}`);
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    // body-parser 的解析类错误：请求体不对属于客户端问题，不该报 500
    const parseType = (err as { type?: string } | null)?.type;
    if (parseType === 'entity.parse.failed') {
      logger.child('http').warn(`[MARK:HTTP_ERR] 请求体不是合法 JSON: ${message}`);
      res.status(400).json({ error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } });
      return;
    }
    if (parseType === 'entity.too.large') {
      logger.child('http').warn(`[MARK:HTTP_ERR] 请求体过大: ${message}`);
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大' } });
      return;
    }
    if (/只支持上传|File too large|Unexpected field/i.test(message)) {
      logger.child('http').warn(`[MARK:HTTP_ERR] 上传错误: ${message}`);
      res.status(400).json({ error: { code: 'UPLOAD_ERROR', message } });
      return;
    }
    logger.child('http').error(`[MARK:HTTP_ERR] 未处理异常: ${message}`, { stack });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } });
  });

  return app;
}
