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
  downloadUrl: string // 管理端下载地址：/api/files/<id>/download（不鉴权）
  androidDownloadUrl?: string // 安卓端下载地址：/api/android/download/<id>（需 X-Auth-Token，仅供参考/复制）
  downloaded: boolean // 是否已被安卓上报下载完成
  downloadedAt?: string | null
  androidDownloads?: number // 安卓端已开始下载的次数
  lastAndroidDownloadAt?: string | null // 安卓端最后一次开始下载的时间
  webDownloads?: number // 网页端（本机）下载次数
  lastWebDownloadAt?: string | null // 网页端最后一次下载的时间
  waitingSec?: number // 发布至今等待秒数（待下载清单用）
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
  clearLogsAfterReport: boolean // 下载诊断报告成功后是否清空已收集的历史日志（默认 false）
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
  valid: boolean // 结构是否可用（warnings 为空才算 true）
  warnings: string[] // 需要用户处理的问题（可直接展示；为空才算结构正常）
  notes: string[] // 提示性说明（多账号提醒、会过期等，不影响可用性）
  /** 结构统计（只在 exists=true 时有意义） */
  stats: {
    total: number // cookie 条数
    byDomain: Record<string, number> // 域名分布，例如 { 'youtube.com': 12 }
    keys: Record<string, boolean> // 关键 cookie 是否存在，例如 SID / __Secure-1PSID / LOGIN_INFO
    expiredCount: number // 已过期条数
    hasHeader: boolean // 是否有 "# Netscape HTTP Cookie File" 头
    hasGoogleDomain: boolean // 是否含 google.com 的 cookie
    hasYoutubeDomain: boolean // 是否含 youtube.com 的 cookie
  }
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

/* ------------------------------ 鉴权 ------------------------------ */

/**
 * 当前登录状态（GET /api/auth/me、POST /api/auth/login）。
 * 服务端未配置账号密码时 enabled=false，此时 authenticated 恒为 true（无需登录）。
 */
export interface AuthStatus {
  /** 服务端是否配置了账号密码 */
  enabled: boolean
  authenticated: boolean
  username: string | null
  /** 会话有效期（小时） */
  sessionHours: number
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

/** 待下载清单（GET /api/files/pending）：已完成加密归档、安卓端还没取走的成品 */
export interface PendingFilesResponse {
  items: PublishedFile[]
  total: number
  totalBytes: number
  oldestWaitingSec: number // 等待最久的文件已等待秒数（无数据时为 0）
  generatedAt: string // 清单生成时间（ISO）
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

/* ------------------------------ 日志 / 调试 ------------------------------ */

/** 日志级别（error 最严重，trace 最啰嗦） */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'

/** 日志尾部内容（GET /api/system/logs） */
export interface LogsTail {
  file: string // 当前日志文件绝对路径
  dir: string // 日志目录
  files: { name: string; sizeBytes: number; mtime: string }[] // 目录内全部日志文件（最新在前）
  debugMode: boolean // 是否开启 Debug 模式（记录外部命令 argv / 退出码 / stdout 摘要）
  logLevel: LogLevel // 当前落盘日志级别
  markers: { marker: string; description: string }[] // 全部标记及含义
  usedMarkers: string[] // 日志里已出现过的标记
  lines: string[] // 原始日志行，最新在最后
}

/** 调试开关状态（GET/POST /api/system/debug，即 LogsTail 去掉 lines） */
export interface DebugStatus {
  file: string
  dir: string
  files: { name: string; sizeBytes: number; mtime: string }[]
  debugMode: boolean
  logLevel: LogLevel
  markers: { marker: string; description: string }[]
  usedMarkers: string[]
}

/* --------------------------- 问题反馈 / 诊断报告 --------------------------- */

/** 单项可下载报告（GET /api/system/report/list → items[]） */
export interface ReportListItem {
  id: string // 稳定标识，用于列表 key
  title: string // 中文标题，例如「完整诊断报告（推荐）」
  name: string // 建议保存的文件名，例如 ttdownload-report-2026-...zip
  description: string // 里面有什么（中文，可直接展示）
  sizeBytes: number | null // 预估 / 实际大小，未知为 null
  updatedAt: string | null // 最后生成时间（ISO），未知为 null
  url: string // 直接下载用的地址（以 /api 开头的完整路径，直接 window.open / <a href> 即可）
  recommended: boolean // 是否推荐（优先下载）
  kind: 'zip' | 'json' | 'log' | 'csv' // 文件类型（用于展示 Badge）
}

/** 诊断报告清单（GET /api/system/report/list） */
export interface ReportListResponse {
  generatedAt: string // 本清单生成时间（ISO）
  zipAvailable: boolean // 服务器是否可打包 zip
  zipHint: string | null // zipAvailable=false 时的提示（例如「sudo apt install -y zip」）
  logLevel: LogLevel // 当前落盘日志级别
  debugMode: boolean // 是否开启 Debug 模式
  /** 服务端持久化设置：下载报告成功后是否清空已收集的历史日志 */
  clearLogsAfterReport: boolean
  reports: { name: string; sizeBytes: number; mtime: string }[] // 历史上已生成的报告（最近 5 份）
  items: ReportListItem[]
  tasksSummary: unknown // 统计对象（仅用于展示「N 个失败任务」之类，字段不必强类型）
}

/* ------------------------------ 网络自检 ------------------------------ */

/** 自检单项状态：ok 通过 / fail 失败 / skip 跳过 / running 进行中 */
export type CheckStatus = 'ok' | 'fail' | 'skip' | 'running'

/** 单条出网自检结果（GET /api/webvideo/network） */
export interface NetworkCheck {
  id: string // 'proxy' | 'dns' | 'https-google' | 'https-youtube' | 'https-github' | 'ytdlp-version' | 'ytdlp-youtube-meta' | 'youtube-cdn' | 'aria2-rpc' | 'transmission-rpc'
  label: string // 中文名，例如「YouTube 视频元数据（yt-dlp -J）」
  status: CheckStatus
  latencyMs: number | null // 耗时（毫秒），未执行/失败时可能为 null
  detail: string // 成功信息或失败原因（可能较长，含原始报错）
  hint?: string // 失败时的修复建议（中文）
  group: 'net' | 'ytdlp' | 'local' // 分组：基础网络 / yt-dlp / 本机下载服务
}

/** 网络自检报告（GET /api/webvideo/network?refresh=1） */
export interface NetworkReport {
  checkedAt: string // 本次检测时间（ISO）
  cached: boolean // 是否直接返回服务端 60s 缓存
  overall: 'ok' | 'partial' | 'fail' // 总体结论
  summary: string // 一句话中文结论
  proxy: { env: Record<string, string>; extraArgs: string } // 服务端实际生效的代理配置
  checks: NetworkCheck[]
}

/* --------------------------- 修复脚本（上传即 root 执行） --------------------------- */

/**
 * 一次脚本执行记录。
 * 脚本在独立单元里执行（systemd-run / setsid），因此脚本里重启本服务也不会中断执行，
 * 但页面可能短暂打不开；过几秒刷新即可看到结果。
 */
export interface ScriptRun {
  startedAt: string // 开始时间（ISO）
  finishedAt: string | null // 结束时间，仍在执行时为 null
  exitCode: number | null // 退出码，未结束 / 被信号终止时为 null
  timedOut: boolean // 是否因超时被终止
  logPath: string // 服务器上的执行日志绝对路径
  pid: number | null // 执行进程 pid
  via: 'systemd-run' | 'setsid' // 执行方式：systemd 瞬时单元 / setsid 脱离会话
}

/** 单个已上传的修复脚本（GET /api/system/scripts → items[]） */
export interface ScriptItem {
  id: string // 稳定标识，用于列表 key 与详情请求
  name: string // 脚本文件名，如 fix-ffmpeg.sh
  sizeBytes: number // 脚本大小（字节）
  sha256: string // 内容 SHA256（下载后可比对，防止传错文件）
  uploadedAt: string // 上传时间（ISO）
  runCount: number // 累计执行次数
  lastRun?: ScriptRun // 最近一次执行记录，从未执行过则无
  running: boolean // 当前是否正在执行
  statusUrl: string // 状态查询地址
  logsUrl: string // 执行日志地址
  fileUrl: string // 脚本文件下载地址
}

/** 修复脚本概览（GET /api/system/scripts） */
export interface ScriptsOverview {
  enabled: boolean // 服务端是否允许上传/执行（默认 false）
  tokenRequired: boolean // 是否需要维护令牌（.env 的 MAINTENANCE_TOKEN / ANDROID_TOKEN）
  timeoutSec: number // 执行超时（秒），超时会被强制终止
  allowlistHint: string // 一行使用范围说明，直接展示
  items: ScriptItem[]
}

/** 单个脚本详情（GET /api/system/scripts/:id?lines=300） */
export interface ScriptDetail {
  item: ScriptItem // 脚本元信息（含运行状态）
  preview: string // 脚本全文（只读预览）
  log: string // 执行输出（尾部若干行）
  logLines: number // 日志总行数
  enabled: boolean // 上传/执行开关是否开启
  tokenRequired: boolean // 是否需要维护令牌
  timeoutSec: number // 执行超时（秒）
}
