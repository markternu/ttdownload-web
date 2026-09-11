# API 契约（前后端 + 安卓共同遵守）

- Base URL：`http://<host>:<PORT>`（默认 8080）
- 所有接口前缀：`/api`
- 请求/响应：`application/json; charset=utf-8`（文件下载/上传除外）
- 时间：ISO8601 字符串；字节数：number；速率：bytes/s
- 错误统一：

```json
{ "error": { "code": "TASK_NOT_FOUND", "message": "任务不存在" } }
```

HTTP 状态码：400 参数错误 / 401 鉴权失败 / 404 不存在 / 409 状态冲突 / 500 服务端错误。

---

## 0. 类型定义（前端 TS 直接照抄）

```ts
type ModuleId = 'transmission' | 'aria2' | 'webvideo';

type TaskStatus =
  | 'waiting'      // 已入统一等待队列（受 10G 门控/并发限制）
  | 'parsing'      // 解析元数据中（webvideo/种子）
  | 'downloading'
  | 'paused'
  | 'archiving'    // 归档（打包/命名/VLT 标记）
  | 'encrypting'   // 加密发布
  | 'completed'    // 已发布到消费者目录
  | 'failed'
  | 'cancelled';

interface FormatOption {
  id: string;            // yt-dlp format id
  ext: string;           // mp4 / mkv / webm ...
  resolution: string;    // 1080p / 720p / audio ...
  label: string;         // 展示文案，如 "1080P · MP4 · 235 MB"
  filesize?: number | null;
  vcodec?: string | null;
  acodec?: string | null;
}

interface Task {
  id: number;
  module: ModuleId;
  title: string;
  platform?: string | null;      // YouTube / Bilibili / BT / URL ...
  url?: string | null;
  status: TaskStatus;
  progress: number;              // 0-100
  speedBps: number;
  etaSec: number | null;
  totalBytes: number;            // 0 = 未知
  downloadedBytes: number;
  expectBytes: number;           // 入队时预估大小（用于空间门控）
  outputPath?: string | null;    // 模块内下载路径
  publishedName?: string | null; // 发布后的文件名（如 oqq12）
  error?: string | null;         // 面向用户的中文失败原因
  meta?: {
    thumbnail?: string | null;
    durationSec?: number | null;
    author?: string | null;
    resolution?: string | null;
    format?: string | null;
    formats?: FormatOption[];
    files?: string[];            // 种子内被选中的文件
  } | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

interface PublishedFile {
  id: number;
  name: string;                  // 发布文件名（无后缀密文，如 oqq12）
  title: string;                 // 人类可读标题
  module: ModuleId;
  sizeBytes: number;
  createdAt: string;
  downloadUrl: string;           // /api/android/download/<id>
  downloaded: boolean;           // 是否已被安卓上报下载完成
  downloadedAt?: string | null;
}

interface Settings {
  maxConcurrent: number;                 // 1/2/3/5/10，默认 3
  defaultQuality: string;                // 默认 1080p
  defaultFormat: string;                 // 默认 mp4
  downloadRoot: string;                  // 默认 /ttdownload（改后需重启）
  reserveFreeBytes: number;              // 默认 10 GiB
  maxSpeedBps: number;                   // 0=不限速
  requestTimeoutSec: number;             // 默认 30
  autoRetry: number;                     // 默认 2
  theme: 'light' | 'dark' | 'system';
  encryptPassword: string;               // GET 时返回掩码 '******'；PUT 传新值才修改
  moduleConcurrency: { transmission: number; aria2: number; webvideo: number };
  aria2Rpc: { host: string; port: number; secret: string };
  transmissionRpc: { host: string; port: number; user: string; password: string };
  ytdlpPath: string;                     // 默认 yt-dlp
  ffmpegPath: string;                    // 默认 ffmpeg
  transcodeQuality: string;              // 预留
  autoDeleteAfterReport: boolean;        // 安卓上报后是否删除（默认 true）
}

interface Stats {
  todayTasks: number;
  todayCompleted: number;
  downloading: number;
  waiting: number;
  failed: number;
  totalDownloadedBytes: number;
  totalTasks: number;
  successRate: number;                   // 0-1
  perPlatform: { platform: string; count: number }[];
  daily: { date: string; count: number; bytes: number }[];
  recentTasks: Task[];
}
```

---

## 1. 系统

| 方法 | 路径 | 说明 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/health` | 存活探针 | `{ ok: true, version, uptimeSec }` |
| GET | `/api/system` | 系统状态（设置页用） | `{ disk: {path,totalBytes,freeBytes,usedBytes,reserveBytes,usableBytes}, db: {path,sizeBytes,ok}, dirs: Record<string,string>, tools: { aria2:{ok,version}, transmission:{ok,version}, ytdlp:{ok,version}, ffmpeg:{ok,version}, openssl:{ok,version} }, version, node }` |
| GET | `/api/stats` | Dashboard 统计 | `Stats` |
| GET | `/api/events` | SSE 实时事件 | `event: task` / `event: file` / `event: stats` / `event: log`，`data:` 为对应 JSON |

---

## 2. 任务（统一队列，所有模块共用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tasks?module=&status=&q=&sort=created_desc&page=1&pageSize=20` | 分页查询，`status` 可逗号分隔多个；`q` 搜索标题/URL |
| GET | `/api/tasks/:id` | 单个任务 |
| POST | `/api/tasks/:id/actions` | `{ action: 'pause'\|'resume'\|'cancel'\|'retry'\|'delete' }`；`delete` 默认仅删记录，`{deleteFile:true}` 连文件一起删 |

返回：`{ items: Task[], total: number, page, pageSize }`。

---

## 3. aria2 模块

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/aria2/urls` | `{ urls: string[] }`（一行一个，后端也会再次按行拆分）；返回 `{ created: number, tasks: Task[] }` |
| GET | `/api/aria2/status` | `{ running: boolean, rpc: {host,port}, version?, pending: number }` |

校验：非法 URL（非 http/https）→ 400 `INVALID_URL`，逐条给出 `skipped: [{url, reason}]`。

---

## 4. transmission（BT 种子）模块

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/bt/upload` | `multipart/form-data`，字段名 `file`（zip）；响应 `{ zipName, extracted: number, seeds: SeedItem[] }` |
| GET | `/api/bt/seeds` | `{ items: SeedItem[] }` |
| POST | `/api/bt/seeds/actions` | `{ ids: number[], action: 'enqueue' \| 'delete' \| 'refresh' }` |
| GET | `/api/bt/status` | `{ running:boolean, rpc:{host,port}, version? }` |

```ts
interface SeedItem {
  id: number;
  name: string;               // 种子文件名
  path: string;               // btzhongzi_nodownd 下的路径
  status: 'pending' | 'queued' | 'downloading' | 'done' | 'failed';
  sizeBytes: number;          // 视频+图片总大小（0=未解析）
  fileCount: number;          // 选中的文件数
  taskId?: number | null;
  error?: string | null;
}
```

---

## 5. 公开视频 URL（webvideo）模块

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/webvideo/parse` | `{ url: string }` → `{ platform, title, thumbnail, durationSec, author, formats: FormatOption[], defaultFormatId, expectedBytes }` |
| POST | `/api/webvideo/tasks` | `{ url, formatId?, quality?, title? }` → `{ task: Task }` |
| GET | `/api/webvideo/platforms` | 支持的平台清单（首页提示用） |
| GET | `/api/webvideo/cookies` | cookies 状态 `{ cookiesFile, defaultPath, exists, sizeBytes, updatedAt, fromBrowser }` |
| POST | `/api/webvideo/cookies` | 上传 cookies.txt：`multipart/form-data` 字段 `file`，或 JSON `{ text }` → 同上状态；写入 600 权限 |
| DELETE | `/api/webvideo/cookies` | 删除 cookies 文件 → 状态 |
| GET | `/api/webvideo/attempts?url=&formatId=` | 「尽力下载」会依次尝试的方式名列表（排障用） |

**`/api/webvideo/parse` 的降级行为**：解析失败（会员专享 / 需登录 / 年龄限制 / 网络超时…）**不再返回 400**，
而是 `200` + `{ degraded: true, parseError: "<中文原因>", title: url, formats: [], defaultFormatId: null, expectedBytes: 0 }`，
前端据此展示「解析受限（仍可下载）」，用户仍可入队；真正能不能下交给下载时的策略阶梯。

失败时 `error.message` 必须是可读中文，并给出**下一步动作**，例如：
`该平台不支持解析该链接`、`视频不可访问（可能已删除、地区限制或需要登录）`、
`该视频是「频道会员专享」…请上传 cookies.txt 后重试`、`该视频受 DRM 保护（任何下载工具都无法直接下载）`。

**下载策略阶梯**（`src/modules/webvideo.ts` 的 `buildDownloadAttempts`）：一次任务会按顺序自动尝试
指定格式 → 登录态(+cookies) → 最佳画质 → 多客户端回退 → 长重试/放宽校验 → 浏览器指纹 →
内嵌播放器 → 单文件直下 → 仅视频流 → 仅音频保底；全部失败才报错，错误里会列出试过的方式数。
会员/登录/私有类错误**不属于永久错误**，会走满 `autoRetry` 次自动重试；
仅 `URL 格式错误 / 不支持该链 / DRM / 未安装 yt-dlp` 等才立即判失败。

---

## 6. 已发布文件（消费者目录）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/files?q=&page=&pageSize=` | `{ items: PublishedFile[], total, totalBytes }` |
| DELETE | `/api/files/:id?withFile=1` | 删除记录 / 同时删除磁盘文件（默认只删记录） |
| GET | `/api/files/:id/download` | 管理端下载（不鉴权，便于排障；安卓用 android 接口） |

---

## 7. 设置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/settings` | 返回 `Settings`（`encryptPassword` 掩码） |
| PUT | `/api/settings` | 局部更新；返回更新后的 `Settings` |
| POST | `/api/settings/test-connection` | `{ tool: 'aria2'\|'transmission'\|'ytdlp' }` → `{ ok, message }` |

---

## 8. 安卓通信 API（消费者）

鉴权：请求头 `X-Auth-Token: <ANDROID_TOKEN>`；也接受 `?token=<ANDROID_TOKEN>`（供 aria2 直链下载）。
未配置 `ANDROID_TOKEN` 时，接口默认关闭（返回 401）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/android/files` | `{ items: [{ id, name, title, module, sizeBytes, url, createdAt }], total, totalBytes }`；只返回**尚未被上报删除**的文件 |
| GET | `/api/android/download/:id` | 文件流下载，支持 `Range`（断点续传）；`?token=` 可用 |
| POST | `/api/android/done` | `{ ids: number[] }` → `{ deleted: number, freedBytes: number, skipped: number, errors: [] }` |
| GET | `/api/android/status` | `{ ok:true, freeBytes, reserveBytes, publishedCount, publishedBytes, waitingTasks, downloadingTasks, version }` |

安卓端约定：
1. 轮询 `/api/android/files` 得到待下载清单（URL 为 `downloadUrl`，可直接交给 aria2）；
2. 下载完成后调用 `/api/android/done` 上报 id；
3. 失败重试、去重（已创建清单）、SD 卡搬移等由 App 本地负责。

---

## 9. SSE 事件格式

```
event: task
data: {"id":12,"status":"downloading","progress":42.5,...}

event: stats
data: {...Stats}

event: file
data: {"action":"published","file":{...PublishedFile}}

event: log
data: {"level":"info","message":"...","at":"..."}
```

前端应在 `EventSource('/api/events')` 断线时自动重连（浏览器原生已支持）。
