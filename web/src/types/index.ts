/**
 * 与后端契约严格一致的类型定义。
 * 来源：ttdownload-web/docs/API.md（唯一权威契约），字段名不允许自行改动。
 */

export type ModuleId = 'transmission' | 'aria2' | 'webvideo'

export type TaskStatus =
  | 'waiting' // 已入统一等待队列（受 10G 门控/并发限制）
  | 'parsing' // 解析元数据中（webvideo/种子）
  | 'downloading'
  | 'paused'
  | 'archiving' // 归档（打包/命名/VLT 标记）
  | 'encrypting' // 加密发布
  | 'completed' // 已发布到消费者目录
  | 'failed'
  | 'cancelled'

export interface FormatOption {
  id: string // yt-dlp format id
  ext: string // mp4 / mkv / webm ...
  resolution: string // 1080p / 720p / audio ...
  label: string // 展示文案，如 "1080P · MP4 · 235 MB"
  filesize?: number | null
  vcodec?: string | null
  acodec?: string | null
}

export interface TaskMeta {
  thumbnail?: string | null
  durationSec?: number | null
  author?: string | null
  resolution?: string | null
  format?: string | null
  formats?: FormatOption[]
  files?: string[] // 种子内被选中的文件
}

export interface Task {
  id: number
  module: ModuleId
  title: string
  platform?: string | null // YouTube / Bilibili / BT / URL ...
  url?: string | null
  status: TaskStatus
  progress: number // 0-100
  speedBps: number
  etaSec: number | null
  totalBytes: number // 0 = 未知
  downloadedBytes: number
  expectBytes: number // 入队时预估大小（用于空间门控）
  outputPath?: string | null // 模块内下载路径
  publishedName?: string | null // 发布后的文件名（如 oqq12）
  error?: string | null // 面向用户的中文失败原因
  meta?: TaskMeta | null
  createdAt: string
  updatedAt: string
  startedAt?: string | null
  finishedAt?: string | null
}

export interface PublishedFile {
  id: number
  name: string // 发布文件名（无后缀密文，如 oqq12）
  title: string // 人类可读标题
  module: ModuleId
  sizeBytes: number
  createdAt: string
  downloadUrl: string // /api/android/download/<id>
  downloaded: boolean // 是否已被安卓上报下载完成
  downloadedAt?: string | null
}

export interface Settings {
  maxConcurrent: number // 1/2/3/5/10，默认 3
  defaultQuality: string // 默认 1080p
  defaultFormat: string // 默认 mp4
  downloadRoot: string // 默认 /ttdownload（改后需重启）
  reserveFreeBytes: number // 默认 10 GiB
  maxSpeedBps: number // 0=不限速
  requestTimeoutSec: number // 默认 30
  autoRetry: number // 默认 2
  theme: 'light' | 'dark' | 'system'
  encryptPassword: string // GET 时返回掩码 '******'；PUT 传新值才修改
  moduleConcurrency: { transmission: number; aria2: number; webvideo: number }
  aria2Rpc: { host: string; port: number; secret: string }
  transmissionRpc: { host: string; port: number; user: string; password: string }
  ytdlpPath: string // 默认 yt-dlp
  ffmpegPath: string // 默认 ffmpeg
  webvideoCookiesFile: string // 服务器上 cookies.txt 路径，''=未设置（会员/登录视频需要）
  webvideoCookiesFromBrowser: string // '' | 'chrome' | 'chromium' | 'edge' | 'firefox' | 'brave' | 'opera' | 'vivaldi' | 'safari'
  webvideoExtraArgs: string // 追加给 yt-dlp 的额外参数（空格分隔），''=无
  transcodeQuality: string // 预留
  autoDeleteAfterReport: boolean // 安卓上报后是否删除（默认 true）
  /** BT 出清机制（长时间无资源/停滞/极慢 -> 清理任务与 incomplete 目录） */
  btEvict: {
    enabled: boolean
    minAgeHours: number // 硬门槛：实际下载尝试满这么多小时才参与判断（默认 10）
    salvagePercent: number // 进度达到该百分比且是视频 -> 按“可播放视为完整”处理（默认 79）
    stallMinutes: number // 速率 0 且停滞超过这么多分钟 -> 判定无资源（默认 30）
    slowKbps: number // 速率低于该值(KB/s) 且预计剩余超过 slowEtaHours -> 判定过慢（默认 20）
    slowEtaHours: number // 预计剩余时间阈值（小时，默认 72）
    checkIntervalMin: number // 检查周期（分钟，默认 5）
  }
}

/** yt-dlp cookies 状态（GET/POST/DELETE /api/webvideo/cookies） */
export interface CookiesStatus {
  cookiesFile: string // 当前生效的 cookies 文件绝对路径（可能来自设置或默认路径）
  defaultPath: string // 服务器默认路径（DOWNLOAD_ROOT/state/cookies.txt）
  exists: boolean
  sizeBytes: number
  updatedAt: string | null // ISO 时间
  fromBrowser: string // 设置里的“从浏览器读取”，''=未启用
}

/** BT 出清检查结果（/api/bt/stale 预览、/api/bt/evict 执行） */
export interface BtStaleCandidate {
  taskId: number
  torrentId: number | null
  title: string
  ageHours: number
  percent: number
  rateBps: number
  etaSec: number
  peers: number
  decision: 'evict' | 'salvage' | 'keep'
  reason: string
  detail: string
}

/** SSE event: space（空间已腾挪广播） */
export interface SpaceFreedEvent {
  bytes: number
  reason: string
  at?: string
  detail?: unknown
}

export interface BtEvictSummary {
  checked: number
  evicted: number
  salvaged: number
  kept: number
  freedBytes: number
  candidates: BtStaleCandidate[]
}

export interface Stats {
  todayTasks: number
  todayCompleted: number
  downloading: number
  waiting: number
  failed: number
  totalDownloadedBytes: number
  totalTasks: number
  successRate: number // 0-1
  perPlatform: { platform: string; count: number }[]
  daily: { date: string; count: number; bytes: number }[]
  recentTasks: Task[]
}

export interface SeedItem {
  id: number
  name: string // 种子文件名
  path: string // btzhongzi_nodownd 下的路径
  status: 'pending' | 'queued' | 'downloading' | 'done' | 'failed'
  sizeBytes: number // 视频+图片总大小（0=未解析）
  fileCount: number // 选中的文件数
  taskId?: number | null
  error?: string | null
}

export interface SystemDisk {
  path: string
  totalBytes: number
  freeBytes: number
  usedBytes: number
  reserveBytes: number
  usableBytes: number
}

export interface ToolStatus {
  ok: boolean
  version?: string | null
}

export interface SystemStatus {
  disk: SystemDisk
  db: { path: string; sizeBytes: number; ok: boolean }
  dirs: Record<string, string>
  tools: {
    aria2: ToolStatus
    transmission: ToolStatus
    ytdlp: ToolStatus
    ffmpeg: ToolStatus
    openssl: ToolStatus
  }
  version: string
  node: string
}

export interface HealthStatus {
  ok: boolean
  version?: string
  uptimeSec?: number
}

/** 错误统一格式（docs/API.md §0） */
export interface ApiErrorBody {
  error: { code: string; message: string }
}

export interface TaskListResponse {
  items: Task[]
  total: number
  page: number
  pageSize: number
}

export interface FileListResponse {
  items: PublishedFile[]
  total: number
  totalBytes: number
}

export interface ParseResult {
  platform: string
  title: string
  thumbnail: string | null
  durationSec: number | null
  author: string | null
  formats: FormatOption[]
  defaultFormatId: string
  expectedBytes: number
  /** 解析受限于登录/会员/年龄等原因时为 true（仍可强行加入队列，下载时会自动多方式尝试） */
  degraded?: boolean
  /** degraded 时的具体原因 */
  parseError?: string
}

export interface Aria2SubmitResponse {
  created: number
  tasks: Task[]
  skipped?: { url: string; reason: string }[]
}

export interface Aria2Status {
  running: boolean
  rpc: { host: string; port: number }
  version?: string
  pending: number
}

export interface BtUploadResponse {
  zipName: string
  extracted: number
  seeds: SeedItem[]
}

export interface BtStatus {
  running: boolean
  rpc: { host: string; port: number }
  version?: string
}

export interface SeedListResponse {
  items: SeedItem[]
}

export interface PlatformListResponse {
  platforms?: string[]
  items?: string[]
}

export type TaskAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'delete'
export type SeedAction = 'enqueue' | 'delete' | 'refresh'
export type TestTool = 'aria2' | 'transmission' | 'ytdlp'
export type ThemeMode = 'light' | 'dark' | 'system'

/* ------------------------------ SSE 事件 ------------------------------ */

export interface SseTaskEvent extends Partial<Task> {
  id: number
}

export interface SseFileEvent {
  action: string
  file?: PublishedFile
  id?: number
}

export interface SseLogEvent {
  level: string
  message: string
  at: string
}

export interface TaskQuery {
  module?: ModuleId | ''
  status?: string
  q?: string
  sort?: string
  page?: number
  pageSize?: number
}
