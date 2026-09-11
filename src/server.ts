import http from 'node:http';
import { createApp } from './app';
import { config, ensureDirs } from './core/config';
import { logger } from './core/logger';
import { initNamePrefix } from './services/crypto';
import { recoverTasks, startScheduler, stopScheduler, kickScheduler } from './core/scheduler';
import { startPipeline, stopPipeline } from './services/pipeline';
import { startBtEvictWorker, stopBtEvictWorker } from './services/btEvict';

async function main(): Promise<void> {
  ensureDirs();
  initNamePrefix();
  logger.mark('BOOT', '==============================================');
  logger.mark('BOOT', `ttdownload-web v${config.version} 启动中...`);
  logger.mark('CONFIG', '运行配置', {
    downloadRoot: config.dirs.root,
    host: config.host,
    port: config.port,
    reserveFreeBytes: config.reserveFreeBytes,
    maxConcurrent: config.maxConcurrent,
    moduleConcurrency: config.moduleConcurrency,
    autoRetry: config.autoRetry,
    dbPath: config.dbPath,
    logPath: config.logPath,
    logLevel: logger.getLevel(),
    transmissionIncompleteDir: config.transmissionIncompleteDir,
    bins: config.bins,
    webvideo: config.webvideo,
  });
  logger.mark('BOOT', `下载根目录: ${config.dirs.root}`);
  logger.mark('BOOT', `保留空间: ${(config.reserveFreeBytes / 1024 ** 3).toFixed(1)} GiB；全局并发: ${config.maxConcurrent}`);
  logger.mark('BOOT', `安卓接口: ${config.androidToken ? '已启用' : '未配置 ANDROID_TOKEN（已关闭）'}`);
  logger.mark('BOOT', `运行环境: node ${process.version} / ${process.platform} ${process.arch} / pid ${process.pid}`);
  logger.mark('BOOT', `日志级别: ${logger.getLevel()}（调试期建议 debug；改 .env 的 LOG_LEVEL）`);
  logger.mark('BOOT', '==============================================');

  // 兜底：任何未捕获异常都要进日志文件，方便用户直接把日志发过来
  process.on('uncaughtException', (e) => {
    logger.child('process').error(`[MARK:ERROR] 未捕获异常: ${e?.stack ?? e}`);
  });
  process.on('unhandledRejection', (reason) => {
    const r = reason as Error;
    logger.child('process').error(`[MARK:ERROR] 未处理的 Promise 拒绝: ${r?.stack ?? String(reason)}`);
  });

  await recoverTasks();
  startPipeline();
  startScheduler();
  startBtEvictWorker();
  kickScheduler();

  const app = createApp();
  const server = http.createServer(app);
  server.listen(config.port, config.host, () => {
    logger.info(`服务已启动: http://${config.host}:${config.port}  (前端: / , API: /api/health)`);
  });

  const shutdown = (signal: string): void => {
    logger.mark('BOOT', `收到 ${signal}，正在优雅退出...`);
    stopScheduler();
    stopPipeline();
    stopBtEvictWorker();
    server.close(() => {
      logger.mark('BOOT', '已退出');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  logger.child('boot').error(`[MARK:ERROR] 启动失败: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
