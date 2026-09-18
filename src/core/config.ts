import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import type { DirLayout } from '../types';

dotenv.config({ path: process.env.ENV_FILE || path.resolve(process.cwd(), '.env') });

const num = (v: string | undefined, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

const str = (v: string | undefined, def = ''): string => (v === undefined || v === null ? def : String(v));

/** 下载根目录（可被环境变量覆盖；测试时指向临时目录） */
export const DOWNLOAD_ROOT = path.resolve(str(process.env.DOWNLOAD_ROOT, '/ttdownload'));

function buidDirs(): DirLayout {
  const root = DOWNLOAD_ROOT;
  const p = (...s: string[]) => path.join(root, ...s);
  return {
    root,
    btZip: p('transmission', 'btzhongzi_zip'),
    btPending: p('transmission', 'btzhongzi_nodownd'),
    btQueued: p('transmission', 'btzhongzi_yijingdownding'),
    // ⚠️ 生产上用 **transmission 自己的完成目录**（部署脚本会写进 .env）：
    //    我们以前把它改成 /ttdownload/...（root 所有），而 transmission 以 debian-transmission
    //    运行 —— 下完从 incomplete 搬过来时 "Permission denied (13)"，每个完成的种子都失败、
    //    文件永远进不了 downloads。
    //    没配置时退回下载根目录下的 transmission/downloads（本地开发/测试用）。
    btDownload: str(process.env.BT_DOWNLOAD_DIR, p('transmission', 'downloads')),
    aria2: p('downd_aria2_path'),
    webTools: p('downd_web_tools'),
    webToolsDone: p('downd_web_tools', 'downdok'),
    archiveReady: p('downd_ok_p2'),
    encryptTmp: p('downd_ok_p2_jiami_tmp'),
    consumer: p('xiaofeizhe_downd'),
    state: p('state'),
  };
}

export const DIRS: DirLayout = buidDirs();

export function ensureDirs(): void {
  // 注意：btDownload / transmission 的 incomplete 目录**不属于我们**（属主 debian-transmission），
  // 不去创建它们 —— 没权限会直接 EACCES，而且那是 transmission 的地盘。
  const skip = new Set<string>([path.resolve(DIRS.btDownload), path.resolve(config.transmissionIncompleteDir)]);
  for (const dir of Object.values(DIRS)) {
    const abs = path.resolve(dir);
    if (skip.has(abs)) continue;
    fs.mkdirSync(abs, { recursive: true });
  }
}

export const config = {
  host: str(process.env.HOST, '0.0.0.0'),
  port: num(process.env.PORT, 8080),
  version: '1.0.0',

  dirs: DIRS,
  dbPath: str(process.env.DB_PATH, path.join(DIRS.state, 'app.db')),
  logPath: str(process.env.LOG_PATH, path.join(DIRS.state, 'app.log')),

  reserveFreeBytes: num(process.env.RESERVE_FREE_BYTES, 10 * 1024 ** 3),
  // ⚠️ 这里**默认不限并发**（0 = 不限）。
  // 真正的准入条件只有一个：**磁盘空间**。调度器按先进先出依次尝试启动等待任务：
  //     usable = 实际可用 - 预留 - 已在跑任务的预留
  //     usable - 这个任务预计要占的空间 >= 0  → 启动它，usable 相应扣掉，继续下一个
  //     装不下 → 跳过它，让后面装得下的先跑（不浪费空间）；等回血后再轮到它
  //              （回血 = 任务完成 + 被安卓取走 + 服务端删除，会广播事件立刻重算）
  // 以前写死过 1 / 3，结果是"磁盘还空着 18G，却只跑一个任务，其余白等" —— 那是错的。
  // 想要限制（比如小机器怕卡）再自己调大/调小，0 就是不管。
  maxConcurrent: num(process.env.MAX_CONCURRENT, 0),
  moduleConcurrency: {
    transmission: num(process.env.CONCURRENCY_TRANSMISSION, 0),
    aria2: num(process.env.CONCURRENCY_ARIA2, 0),
    webvideo: num(process.env.CONCURRENCY_WEBVIDEO, 0),
  },
  autoRetry: num(process.env.AUTO_RETRY, 2),

  // BT：只挑视频文件（按扩展名，大小写不敏感），别的什么都不做。
  // 不做关键词/广告识别 —— 那套判断不准，会把正片当广告排除（用户明确要求删掉）。
  btSelect: {
    /** 单个文件小于它：多个小文件合成一个 zip；大于等于它：一个一个单独走 */
    smallFileMaxBytes: num(process.env.BT_SMALL_FILE_MAX, 300 * 1024 ** 2),
    // 多个视频时"挑同类"：独树一帜下最大，相差无几一起下
    /** 体积相差多少倍就算"异类" */
    bigRatio: num(process.env.BT_BIG_RATIO, 5),
    /** 情况3：最大的不到这个字节数时，"一堆小文件"优先（默认 200MB） */
    smallCeilingBytes: num(process.env.BT_SMALL_CEILING, 200 * 1024 ** 2),
    /** 情况3：小文件至少几个（默认 3） */
    manySmallCount: num(process.env.BT_MANY_SMALL_COUNT, 3),
  },
  // BT 种子超时策略：扔给 transmission 后只读进度，12 小时内不干涉
  btPolicy: {
    /** 交给 transmission 多少小时后第一次判断 */
    checkAfterHours: num(process.env.BT_CHECK_AFTER_HOURS, 12),
    /** 到点时进度 ≤ 该百分比 -> 直接清理（连残留一起删） */
    minProgressPercent: num(process.env.BT_MIN_PROGRESS_PERCENT, 60),
    /** 进度 > 该值时再给这么多小时宽限，到点还没完也清理 */
    graceHours: num(process.env.BT_GRACE_HOURS, 6),
  },
  /** 修复脚本上传/执行：默认关闭（危险功能，需在网页显式开启） */
  scriptUploadEnabled: str(process.env.SCRIPT_UPLOAD_ENABLED, '0') === '1',
  scriptRunTimeoutSec: num(process.env.SCRIPT_RUN_TIMEOUT_SEC, 600),
  requestTimeoutSec: num(process.env.REQUEST_TIMEOUT_SEC, 30),
  maxSpeedBps: num(process.env.MAX_SPEED_BPS, 0),

  encryptPassword: str(process.env.ENCRYPT_PASSWORD, 'ec3e458fcde2582e079f19368abc780f'),
  androidToken: str(process.env.ANDROID_TOKEN, ''),

  aria2Rpc: {
    host: str(process.env.ARIA2_RPC_HOST, '127.0.0.1'),
    port: num(process.env.ARIA2_RPC_PORT, 6800),
    secret: str(process.env.ARIA2_RPC_SECRET, ''),
  },
  transmissionRpc: {
    host: str(process.env.TRANSMISSION_RPC_HOST, '127.0.0.1'),
    port: num(process.env.TRANSMISSION_RPC_PORT, 9091),
    user: str(process.env.TRANSMISSION_RPC_USER, ''),
    password: str(process.env.TRANSMISSION_RPC_PASSWORD, ''),
  },
  /** transmission 的 incomplete 目录（出清时需要一并删除里面的任务文件夹） */
  transmissionIncompleteDir: str(process.env.TRANSMISSION_INCOMPLETE_DIR, '/var/lib/transmission/incomplete'),

  /** 自动获取访客 cookies（无头浏览器；抖音这类站点必需，默认开启） */
  cookieHarvestEnabled: str(process.env.COOKIE_HARVEST_ENABLED, '1') !== '0',

  /** BT 出清机制默认值（可在 Web 设置页修改） */
  btEvict: {
    enabled: str(process.env.BT_EVICT_ENABLED, '1') !== '0',
    minAgeHours: num(process.env.BT_EVICT_MIN_AGE_HOURS, 10),
    salvagePercent: num(process.env.BT_EVICT_SALVAGE_PERCENT, 79),
    stallMinutes: num(process.env.BT_EVICT_STALL_MINUTES, 30),
    slowKbps: num(process.env.BT_EVICT_SLOW_KBPS, 20),
    slowEtaHours: num(process.env.BT_EVICT_SLOW_ETA_HOURS, 72),
    checkIntervalMin: num(process.env.BT_EVICT_CHECK_INTERVAL_MIN, 5),
  },

  bins: {
    aria2: str(process.env.ARIA2_BIN, 'aria2c'),
    transmission: str(process.env.TRANSMISSION_REMOTE_BIN, 'transmission-remote'),
    ytdlp: str(process.env.YTDLP_BIN, 'yt-dlp'),
    ffmpeg: str(process.env.FFMPEG_BIN, 'ffmpeg'),
    openssl: str(process.env.OPENSSL_BIN, 'openssl'),
    zip: str(process.env.ZIP_BIN, 'zip'),
    unzip: str(process.env.UNZIP_BIN, 'unzip'),
  },

  /** 全站鉴权（账号密码由部署脚本生成并写入 .env；为空表示未开启鉴权） */
  webAuth: {
    user: str(process.env.WEB_AUTH_USER, ''),
    password: str(process.env.WEB_AUTH_PASSWORD, ''),
    /** 会话有效期（小时） */
    sessionHours: num(process.env.WEB_SESSION_HOURS, 168),
    /** 会话签名密钥（留空则由账号密码派生，重启后仍有效） */
    sessionSecret: str(process.env.WEB_SESSION_SECRET, ''),
  },

  /** 公开视频（yt-dlp）：cookies 与额外参数，用于会员/登录/年龄限制视频 */
  webvideo: {
    /** cookies.txt 默认路径（会员/登录/年龄限制视频必需，可在 Web 设置页里上传或改路径） */
    defaultCookiesFile: str(process.env.YTDLP_COOKIES_FILE, path.join(DIRS.state, 'cookies.txt')),
    /** 从浏览器读取 cookies：chrome/chromium/edge/firefox/... （服务器上得真有该浏览器配置） */
    cookiesFromBrowser: str(process.env.YTDLP_COOKIES_FROM_BROWSER, ''),
    /** 追加到所有 yt-dlp 调用上的额外参数（空格分隔，如 --proxy socks5://127.0.0.1:1080） */
    extraArgs: str(process.env.YTDLP_EXTRA_ARGS, ''),
  },

  /** 调度器/流水线节拍（毫秒，测试可调小） */
  schedulerIntervalMs: num(process.env.SCHEDULER_INTERVAL_MS, 3000),
  pipelineIntervalMs: num(process.env.PIPELINE_INTERVAL_MS, 5000),
  pollIntervalMs: num(process.env.POLL_INTERVAL_MS, 1500),

  /** 只处理这些扩展名的 BT 内容（与老脚本一致：仅视频 + 图片） */
  videoExts: str(
    process.env.VIDEO_EXTS,
    'mp4 avi wmv mov mkv flv webm m4v 3gp 3g2 mpg mpeg m2v m4p divx xvid asf rm rmvb vob ts mts m2ts f4v f4p f4a f4b ogv ogg dv amv m2p ps qt yuv viv nsr nsv nut',
  )
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((e) => e.toLowerCase()),
  imageExts: str(process.env.IMAGE_EXTS, 'jpg jpeg png gif bmp webp tif tiff jfif')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((e) => e.toLowerCase()),
};

export type AppConfig = typeof config;
