import http from 'node:http';
import fs from 'node:fs';
import { createApp } from './app';
import { config, ensureDirs } from './core/config';
import { logger } from './core/logger';
import { initNamePrefix } from './services/crypto';
import { recoverTasks, startScheduler, stopScheduler, kickScheduler } from './core/scheduler';
import { startPipeline, stopPipeline } from './services/pipeline';
import { startBtEvictWorker, stopBtEvictWorker } from './services/btEvict';
import { applyNoLimitPolicy } from './modules/transmission';
import { startBtHarvestWorker, stopBtHarvestWorker } from './services/btHarvest';
import { ensureAria2Daemon } from './modules/aria2Client';
import { logAuthBootState } from './services/auth';
import { startUsbWorker, stopUsbWorker } from './services/usbMount';
import {
  cookieBootReport,
  startCookieKeepFreshWorker,
  stopCookieKeepFreshWorker,
} from './services/cookieHarvest';
import { startOriginalDownloadWorker, stopOriginalDownloadWorker } from './services/originalDownload';
import { startUpdateWorker, stopUpdateWorker } from './services/updater';

/**
 * 开机自检：用户上传的 cookies.txt 还能不能用（不联网，只看结构与关键字段/过期时间）。
 * 为什么要它：YouTube 的登录 cookies 一过期，下载就"各种报错又不会自愈"——
 * 与其等用户去下东西才发现，不如开机就告诉他哪里过期了。
 */
async function checkUserCookies(): Promise<void> {
  try {
    const { getSettings } = await import('./services/settings');
    const { cookiesPathOf, inspectCookiesFile } = await import('./modules/webvideo');
    const file = cookiesPathOf(getSettings());
    if (!file || !fs.existsSync(file)) return;
    const r = inspectCookiesFile(file);
    if (r.warnings.length) {
      logger.mark('BOOT', `上传的 cookies 有问题：${r.warnings.join('；')}`);
    } else {
      logger.mark('BOOT', `上传的 cookies 检查通过（共 ${r.stats.total} 条，已过期 ${r.stats.expiredCount} 条）`);
    }
  } catch (e) {
    logger.child('boot').warn(`[MARK:COOKIE_HARVEST] cookies 开机自检失败：${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  ensureDirs();
  initNamePrefix();
  logAuthBootState();
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
  // aria2 守护进程（url 直链模块依赖）：启动时后台拉起，避免第一个任务才现拉、也便于自检如实显示
  void ensureAria2Daemon()
    .then((r) => logger.mark('BOOT', `aria2 RPC 自检：${r.message}`))
    .catch((e) => logger.child('aria2').warn(`[MARK:ARIA2_DAEMON] 启动时拉起 aria2 失败：${(e as Error).message}`));
  // 「绝不限速」：开机就把 transmission 的速率限制/队列/缓存闸门全部打开（用户要求带宽拉满）
  void applyNoLimitPolicy().catch(() => undefined);
  startPipeline();
  startScheduler();
  startBtEvictWorker();
  startBtHarvestWorker();
  startUsbWorker();
  // cookies 保鲜：开机预热（HTTP 途径的站点每次重启都换一份新的）+ 运行期定期换新
  cookieBootReport();
  startCookieKeepFreshWorker();
  // 「下载原始文件」：开机清空临时目录 + 起超时清理线程
  startOriginalDownloadWorker();
  void checkUserCookies();
  kickScheduler();

  const app = createApp();
  const server = http.createServer(app);
  server.listen(config.port, config.host, () => {
    logger.info(`服务已启动: http://${config.host}:${config.port}  (前端: / , API: /api/health)`);
    // ⚠️ 自动更新**必须**在服务已经能对外提供服务之后再启动：
    //    开机拉取最新代码是我们的需求，但"拉不到就完蛋"不行 —— 网络没通/远端挂了
    //    也必须能用本地老代码启动（用户明确要求）。检查与升级都是后台异步做的。
    startUpdateWorker();
  });

  const shutdown = (signal: string): void => {
    logger.mark('BOOT', `收到 ${signal}，正在优雅退出...`);
    stopScheduler();
    stopPipeline();
    stopBtEvictWorker();
    stopBtHarvestWorker();
    stopUsbWorker();
    stopCookieKeepFreshWorker();
    stopOriginalDownloadWorker();
    stopUpdateWorker();
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
