/**
 * 全局类型定义（与 docs/API.md 完全一致；前端通过契约同步）
 */
export type ModuleId = 'transmission' | 'aria2' | 'webvideo';

export type TaskStatus =
  | 'waiting'
  | 'parsing'
  | 'downloading'
  | 'paused'
  | 'archiving'
  | 'encrypting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface FormatOption {
  id: string;
  ext: string;
  resolution: string;
  label: string;
  filesize?: number | null;
  vcodec?: string | null;
  acodec?: string | null;
}

export interface TaskMeta {
  thumbnail?: string | null;
  durationSec?: number | null;
  author?: string | null;
  resolution?: string | null;
  format?: string | null;
  formats?: FormatOption[];
  files?: string[];
  seedId?: number;
  progressText?: string | null;
  [key: string]: unknown;
}

export interface Task {
  id: number;
  module: ModuleId;
  title: string;
  platform?: string | null;
  url?: string | null;
  status: TaskStatus;
  progress: number;
  speedBps: number;
  etaSec: number | null;
  totalBytes: number;
  downloadedBytes: number;
  expectBytes: number;
  outputPath?: string | null;
  publishedName?: string | null;
  error?: string | null;
  meta?: TaskMeta | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface PublishedFile {
  /**
   * 磁盘上这个成品文件是否还在。
   * 安卓端上报下载完成后服务器会删除文件，但数据库记录保留作为历史 ——
   * 此时 available=false，前端必须把下载按钮置灰（否则点了只会 404）。
   */
  available: boolean;
  /** 安卓端下载地址（需要 X-Auth-Token；App 自己用这个） */
  androidDownloadUrl?: string;
  /** 安卓端下载次数 / 最后时间（用于"是否已被取走但未上报"） */
  androidDownloads?: number;
  lastAndroidDownloadAt?: string | null;
  /** 网页端（管理界面）下载次数 / 最后时间 */
  webDownloads?: number;
  lastWebDownloadAt?: string | null;
  /** 发布至今等待了多少秒 */
  waitingSec?: number;
  id: number;
  name: string;
  title: string;
  module: ModuleId;
  sizeBytes: number;
  createdAt: string;
  downloadUrl: string;
  downloaded: boolean;
  downloadedAt?: string | null;
}

export interface SeedItem {
  id: number;
  name: string;
  path: string;
  status: 'pending' | 'queued' | 'downloading' | 'done' | 'failed';
  sizeBytes: number;
  fileCount: number;
  taskId?: number | null;
  error?: string | null;
}

export interface Settings {
  /** 设置结构版本：用于给**已部署的机器**做一次性修正（改动历史见 services/settings.ts） */
  schemaVersion?: number;
  maxConcurrent: number;
  defaultQuality: string;
  defaultFormat: string;
  downloadRoot: string;
  reserveFreeBytes: number;
  maxSpeedBps: number;
  requestTimeoutSec: number;
  autoRetry: number;
  theme: 'light' | 'dark' | 'system';
  encryptPassword: string;
  moduleConcurrency: { transmission: number; aria2: number; webvideo: number };
  /** BT 内容甄别（挑核心内容、排广告）与成品拆分策略 */
  btSelect: {
    /** 图片怎么处理：auto=有视频就不要图片 / always=一律保留 / never=一律不要 */
    keepImages: 'auto' | 'always' | 'never';
    /** 广告关键词（文件名或所在目录命中即排除；用户可增删） */
    blockKeywords: string[];
    /** 视频体积下限（字节），0=不按体积过滤 */
    minVideoBytes: number;
    /** 单个视频 ≥ 该字节数时单独发布（不打包）；其余小文件合成一个 zip */
    publishIndividuallyMinBytes: number;
  };
  aria2Rpc: { host: string; port: number; secret: string };
  transmissionRpc: { host: string; port: number; user: string; password: string };
  ytdlpPath: string;
  ffmpegPath: string;
  transcodeQuality: string;
  /** 公开视频 cookies.txt 路径（''=用默认路径 DOWNLOAD_ROOT/state/cookies.txt） */
  webvideoCookiesFile: string;
  /** 从浏览器读取 cookies（''=不启用；chrome/chromium/edge/firefox/...） */
  webvideoCookiesFromBrowser: string;
  /** 追加到所有 yt-dlp 调用的额外参数（空格分隔，如 --proxy socks5://127.0.0.1:1080） */
  webvideoExtraArgs: string;
  autoDeleteAfterReport: boolean;
  /** 修复脚本上传/执行（环境问题远程修复通道；默认关闭） */
  scriptUploadEnabled: boolean;
  /** 自动获取访客 cookies：用无头浏览器抓「不需要登录」的站点 cookies（抖音/TikTok 必需） */
  cookieHarvestEnabled: boolean;
  /** 修复脚本执行超时（秒，默认 600） */
  scriptRunTimeoutSec: number;
  /** 问题反馈：下载诊断报告后是否清空已有日志（避免新旧日志混在一起） */
  clearLogsAfterReport: boolean;
  /** BT 出清机制（长时间无资源/停滞/极慢 -> 清理任务与 incomplete 目录） */
  btEvict: {
    enabled: boolean;
    /** 只有下载超过这么多小时的任务才参与出清判断（防误删，默认 10 小时） */
    minAgeHours: number;
    /** 进度达到该百分比且是视频文件时，按"可播放/视为完整"处理（默认 79） */
    salvagePercent: number;
    /** 速率长期为 0 且进度停滞超过这么多分钟 -> 判定无资源（默认 30） */
    stallMinutes: number;
    /** 有速率但低于该值(KB/s)且预计剩余时间超过 slowEtaHours -> 判定极慢（默认 20KB/s） */
    slowKbps: number;
    /** 极慢判定的预计剩余时间阈值（小时，默认 72） */
    slowEtaHours: number;
    /** 出清检查周期（分钟，默认 5） */
    checkIntervalMin: number;
  };
}

export interface Stats {
  todayTasks: number;
  todayCompleted: number;
  downloading: number;
  waiting: number;
  failed: number;
  totalDownloadedBytes: number;
  totalTasks: number;
  successRate: number;
  perPlatform: { platform: string; count: number }[];
  daily: { date: string; count: number; bytes: number }[];
  recentTasks: Task[];
}

export interface DirLayout {
  root: string;
  btZip: string;
  btPending: string;
  btQueued: string;
  btDownload: string;
  aria2: string;
  webTools: string;
  webToolsDone: string;
  archiveReady: string;
  encryptTmp: string;
  consumer: string;
  state: string;
}
