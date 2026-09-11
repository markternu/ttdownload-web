import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './core/config';
import { logger } from './core/logger';
import { HttpError } from './utils/http';
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

  // 访问日志（精简）
  app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.originalUrl}`);
    next();
  });

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

  // 统一错误处理
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/只支持上传|File too large|Unexpected field/i.test(message)) {
      res.status(400).json({ error: { code: 'UPLOAD_ERROR', message } });
      return;
    }
    logger.error(`未处理异常: ${message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } });
  });

  return app;
}
