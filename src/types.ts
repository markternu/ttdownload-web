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
