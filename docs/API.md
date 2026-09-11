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

## 6.5 日志 / 调试 / 诊断（调试期）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/system/logs?lines=300&level=all&q=&marker=&limit=200` | 返回 `{ file, dir, files[], debugMode, logLevel, markers[], usedMarkers[], lines[], items[] }`；`lines` 为文件尾部原文（最新在最后），`items` 为数据库结构化事件（兼容旧前端） |
| GET | `/api/system/logs/download?file=app.log` | 下载日志文件（`text/plain` 附件；`file` 取自 `files[].name`） |
| DELETE | `/api/system/logs` | 清空所有日志文件 → `{ ok, cleared, bytes }` |
| GET | `/api/system/debug` | 调试状态：`{ file, dir, files, debugMode, logLevel, markers, usedMarkers }` |
| POST | `/api/system/debug` | `{ debugMode?: boolean, logLevel?: 'error'|'warn'|'info'|'debug'|'trace' }`，运行时生效，无需重启 |
| GET | `/api/system/diagnostics` | **一键诊断包**（JSON 附件）：app/env/config/settings/disk/tools/tasks/events/network/markers/logs，密钥自动脱敏 |

以上端点同时挂在 `/api/...` 与 `/api/system/...` 两个前缀下。

日志行格式：`ISO时间 [LEVEL] [MARK:XXX] [scope] 消息 :: {结构化细节}`；标记清单见 `src/core/logger.ts` 的 `MARKERS`
（[`排查手册.md`](./排查手册.md) 有完整对照表）。脱敏覆盖 `token/password/secret/authorization/api_key/Bearer`。

## 6.6 问题反馈 / 报告下载（网页「问题反馈」页用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/system/report` | **一键诊断报告**：优先 `application/zip`（README + diagnostics/system/tasks/network/markers JSON + errors.log + app.log(含轮转) + deploy.log），系统无 `zip` 时退化为单个 JSON；报告存在 `${state}/reports/`（保留最近 5 份） |
| GET | `/api/system/report/list` | 页面清单：`{ generatedAt, zipAvailable, zipHint, logLevel, debugMode, reports[], items[], tasksSummary }`，`items[]` 每项含 `id/title/name/description/sizeBytes/updatedAt/url/recommended/kind` |
| GET | `/api/system/report/file?name=` | 重新下载历史报告（仅允许 `ttdownload-report-*.zip|json`，防目录穿越） |
| GET | `/api/system/logs/export?level=warn&lines=5000&marker=&q=` | 导出过滤后的日志（`level=warn` 即只含 WARN/ERROR 与失败相关标记），`text/plain` 附件 |
| GET | `/api/system/deploy-log` | 下载 `deploy.sh` 的部署日志（不存在时 404 并说明原因） |
| GET | `/api/system/report/tasks?format=json|csv` | 任务清单 + 失败明细（CSV 带 BOM，Excel 可直接打开） |
| GET | `/api/system/report/network` | 网络自检报告（强制重测后下载 JSON） |

以上端点同样同时挂在 `/api/...` 与 `/api/system/...` 下（如 `/api/report`、`/api/report/list`）。

## 6.7 网络自检

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/webvideo/network?refresh=1` | 逐项实测并返回报告；默认缓存 60 秒，`refresh=1` 强制重测 |

```ts
interface NetworkReport {
  checkedAt: string; cached: boolean; overall: 'ok' | 'partial' | 'fail'; summary: string;
  proxy: { env: Record<string, string>; extraArgs: string };
  checks: {
    id: string; label: string; status: 'ok' | 'fail' | 'skip' | 'running';
    latencyMs: number | null; detail: string; hint?: string; group: 'net' | 'ytdlp' | 'local';
  }[];
}
```

检查项：`proxy`、`dns`（youtube/googlevideo/github）、`https-google`、`https-youtube`、`https-github`、
`ytdlp-version`、`ytdlp-youtube-meta`（真去解析公开测试视频）、`youtube-cdn`（拿到直链后读 1 字节）、
`aria2-rpc`、`transmission-rpc`。失败项都带中文 `hint` 修复建议。

## 6.8 修复脚本上传/执行（环境问题远程修复通道）

> ⚠️ 这是「上传即以服务身份执行」，默认关闭；写操作需要维护令牌
> （`MAINTENANCE_TOKEN`，未设置时回退 `ANDROID_TOKEN`；两者都为空则不校验，页面会警告）。
> 令牌通过请求头 `X-Maint-Token` 或 `?token=` 传递。功能未开启时返回 400 `SCRIPT_DISABLED`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/system/scripts` | 概览：`{ enabled, tokenRequired, timeoutSec, allowlistHint, items: ScriptItem[] }` |
| POST | `/api/system/scripts/toggle` | `{ enabled: boolean }` → 概览（开启需令牌） |
| POST | `/api/system/scripts` | 上传：`multipart/form-data` 字段 `file`，或 JSON `{ name, content }` → `{ item, overview }` |
| GET | `/api/system/scripts/:id?lines=300` | `{ item, preview, log, logLines, enabled, tokenRequired, timeoutSec }`；运行中会顺带刷新状态 |
| POST | `/api/system/scripts/:id/run` | 执行（分离运行，脚本重启本服务也不中断）→ `{ item, via: 'systemd-run'\|'setsid' }` |
| GET | `/api/system/scripts/:id/file` | 下载脚本原文 |
| GET | `/api/system/scripts/:id/log` | 下载执行日志（含 `bash -x` 轨迹与 `__EXIT_CODE=N`） |
| DELETE | `/api/system/scripts/:id` | 删除（运行中拒绝） |

错误码：`SCRIPT_DISABLED`（功能未开启）、`SCRIPT_TOKEN`（维护令牌缺失/错误）、`SCRIPT_SAVE`（上传内容不合规）、
`SCRIPT_RUN`（启动失败或上一次仍在运行）、`SCRIPT_NOT_FOUND`、`SCRIPT_LOG_NOT_FOUND`（还没运行过、无日志）、`SCRIPT_DELETE`（删除失败）。

```ts
interface ScriptItem {
  id: string; name: string; sizeBytes: number; sha256: string; uploadedAt: string; runCount: number;
  running: boolean; statusUrl: string; logsUrl: string; fileUrl: string;
  lastRun?: { startedAt: string; finishedAt: string | null; exitCode: number | null;
              timedOut: boolean; logPath: string; pid: number | null; via: 'systemd-run' | 'setsid' };
}
```

实现约束：只接受文本 shell 脚本（`.sh/.bash` 或带 `#!/bin/bash`），≤1MB，落盘 `state/scripts/`（0700/0600）；
执行用 `systemd-run` 瞬时单元（无 systemd 时退回 `setsid` 分离进程）；超时默认 600 秒（`SCRIPT_RUN_TIMEOUT_SEC`），
超时退出码 124；保留最近 20 份；全过程打 `[MARK:SCRIPT_UPLOAD]` / `[MARK:SCRIPT_RUN]` 日志。

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
