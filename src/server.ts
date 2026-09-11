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
  logger.info('==============================================');
  logger.info(`ttdownload-web v${config.version} 启动中...`);
  logger.info(`下载根目录: ${config.dirs.root}`);
  logger.info(`保留空间: ${(config.reserveFreeBytes / 1024 ** 3).toFixed(1)} GiB；全局并发: ${config.maxConcurrent}`);
  logger.info(`安卓接口: ${config.androidToken ? '已启用' : '未配置 ANDROID_TOKEN（已关闭）'}`);
  logger.info('==============================================');

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
    logger.info(`收到 ${signal}，正在优雅退出...`);
    stopScheduler();
    stopPipeline();
    stopBtEvictWorker();
    server.close(() => {
      logger.info('已退出');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  logger.error(`启动失败: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
