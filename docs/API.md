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

## 1.5 鉴权（全站）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/auth/me` | 当前登录状态 `{ enabled, authenticated, username, sessionHours }`（公开，前端启动时调用） |
| POST | `/api/auth/login` | `{ username, password }` → 200 + `AuthStatus`，并下发 `Set-Cookie: ttd_session=…`（HttpOnly/SameSite=Lax） |
| POST | `/api/auth/logout` | 清除会话 Cookie |

- **除下列例外，所有 `/api/*` 未登录一律 401** `{ error: { code: 'UNAUTHORIZED', message: '需要登录…' } }`
- 公开例外：`/api/health`（探活）、`/api/auth/*`、`/api/android/*`（安卓端用 `X-Auth-Token` 自行鉴权）
- 程序化访问：HTTP Basic（`-u 账号:密码`）或 `X-Auth-Token: <ANDROID_TOKEN>` 或 `?token=<ANDROID_TOKEN>`（便于 aria2 直接拉）
- 会话是 HMAC 签名的无状态 Cookie（密钥 `WEB_SESSION_SECRET`，默认由账号密码派生）→ 服务重启不掉线
- 登录失败限流：同一 IP 60 秒内失败 ≥10 次 → 429 `TOO_MANY_ATTEMPTS`
- 账号密码来自 `.env` 的 `WEB_AUTH_USER` / `WEB_AUTH_PASSWORD`；**未配置 = 不鉴权**（启动日志会显著告警）

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
| GET | `/api/bt/proxy` | transmission 反向代理状态（见 4.1） |
| POST | `/api/bt/proxy` | `{ enabled: boolean, force?: boolean, subPath?: string }` → 开启/关闭 |
| GET | `/api/bt/proxy/preview` | 只读预览：`{ config, include }`（将要写入的 nginx 配置，不改任何文件） |

```ts
interface SeedItem {
  id: number;
  name: string;               // 种子文件名
  path: string;               // btzhongzi_nodownd 下的路径
  status: 'pending' | 'queued' | 'downloading' | 'done' | 'failed';
  sizeBytes: number;          // 选中视频的总大小（0=未解析；只下视频，不选图片）
  fileCount: number;          // 选中的文件数
  taskId?: number | null;
  error?: string | null;
}
```


### 4.1 transmission 反向代理开关（远程访问 9091）

**为什么需要**：远程服务器通常只开放 22/80/443，而 transmission 的 WebUI/RPC 只在
`127.0.0.1:9091` 上 —— 外网根本没有这条路，所以「打开 BT 控制台」永远是打不开。
开启本开关后，nginx 会多出一段配置把 `http://<域名>/transmission/` 反代到
`127.0.0.1:9091`；**关闭时这段配置被真正删除**（不是靠防火墙），外界再也访问不到。

```bash
curl -u admin:密码 http://127.0.0.1:8080/api/bt/proxy              # 看状态
curl -u admin:密码 -X POST -H 'Content-Type: application/json' \
     -d '{"enabled":true}' http://127.0.0.1:8080/api/bt/proxy     # 开启
curl -u admin:密码 -X POST -H 'Content-Type: application/json' \
     -d '{"enabled":false}' http://127.0.0.1:8080/api/bt/proxy    # 关闭（彻底移除）
```

```ts
interface BtProxyStatus {
  available: boolean;         // 开关是否可用（脚本存在 + nginx 可用）
  enabled: boolean;           // 当前是否已开启
  subPath: string;            // 默认 '/transmission'（transmission WebUI 自带该前缀，不要改）
  target: string;             // 反代目标，默认 '127.0.0.1:9091'
  url: string | null;         // 给用户直接访问的地址，如 http://1.2.3.4/transmission/web/
  rpcUrl: string | null;      // RPC 地址，如 http://1.2.3.4/transmission/rpc
  snippet: string;            // 生成的 nginx 片段路径
  serverFile: string;         // 被插入 include 的 nginx 配置文件
  nginxVersion: string;       // 'nginx version: nginx/1.24.0'
  reason: string;             // 不能自动配置时的中文原因（'' = 正常）
  scriptFound: boolean;
  enabledSubPaths: string[];  // 当前所有已生效的子路径反代
  transmission: {
    reachable: boolean; version: string | null;
    rpcHost: string; rpcPort: number; rpcUser: string;   // 密码绝不返回
    authRequired: boolean | null;                        // false = 没设密码（公网暴露极危险）
    whitelistEnabled: boolean | null; peerPort: number | null;
  };
  warnings: string[];         // 已本地化的中文警告，前端原样展示
}
```

**错误码**

| 状态 | code | 场景 / 处理 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 请求体不是 `{ enabled: boolean }` |
| 400 | `BT_PROXY_NO_AUTH` | transmission 没设 RPC 密码却要暴露到公网；确要开启时带 `"force": true` |
| 500 | `BT_PROXY_FAILED` | 改配置后 `nginx -t` 失败 —— **已自动回滚**，`error.message` 里有 nginx 的原始报错 |
| 500 | `BT_PROXY_SCRIPT_MISSING` | 服务器上还没有 `deploy/scripts/nginx-proxy-toggle.sh`，先 `sudo ./deploy.sh --update` |

**安全性（这是会自动改 nginx 配置的接口）**

1. 只**新增**一个 `location` 片段（`snippets/ttdownload-proxy-<子路径>.conf`）并在监听 80 的
   `server` 块里插一行 `include`，绝不改动 80 根路径、别人的站点或其它 `location`；
2. 改动前把原文件备份到 `/etc/nginx/ttdownload-backup-<时间>/`；
3. 每次改动后执行 `nginx -t`，**失败立即回滚**并以 500 结束（不会把用户的 nginx 搞挂）；
4. 同一个 `server` 块里若已存在同名 `location`，直接拒绝并提示，不做任何改动；
5. `proxy_pass http://127.0.0.1:9091;` **结尾不带斜杠** —— transmission WebUI 内部用绝对路径，
   去掉 `/transmission` 前缀会 404；
6. 全过程打 `[MARK:NGINX_PROXY]` 日志（`grep -a 'MARK:NGINX_PROXY' /ttdownload/state/app.log`）。

命令行等价物（同一份脚本）：

```bash
sudo ./deploy.sh --bt-proxy            # 开启（默认 /transmission）
sudo ./deploy.sh --bt-proxy-status     # 看状态
sudo ./deploy.sh --bt-proxy-off        # 关闭
sudo bash deploy/scripts/nginx-proxy-toggle.sh preview --path /transmission   # 只看要写什么
```

环境变量：`BT_PROXY_SUBPATH`（默认 `/transmission`）、`BT_PROXY_TARGET`（默认 `127.0.0.1:<TRANSMISSION_RPC_PORT>`）、
`BT_PROXY_SCRIPT`（覆盖脚本路径，测试用）、`NGINX_BIN` / `NGINX_CONF_DIR` / `NGINX_SERVICE`、
`PUBLIC_BASE_URL`（`url` 字段的前缀，反代下自动用 `X-Forwarded-*` 推断）。


## 5. 公开视频 URL（webvideo）模块

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/webvideo/parse` | `{ url: string }` → `{ platform, title, thumbnail, durationSec, author, formats: FormatOption[], defaultFormatId, expectedBytes }` |
| POST | `/api/webvideo/tasks` | `{ url, formatId?, quality?, title? }` → `{ task: Task }` |
| GET | `/api/webvideo/platforms` | 支持的平台清单（首页提示用） |
| GET | `/api/webvideo/cookies` | cookies 状态 `{ cookiesFile, defaultPath, exists, sizeBytes, updatedAt, fromBrowser }` |
| GET | `/api/webvideo/cookies/harvest` | 自动获取访客 cookies 的状态（站点/新鲜度/浏览器是否可用） |
| POST | `/api/webvideo/cookies/harvest` | `{ site: "douyin" }` → 立即刷新该站访客 cookies |

### 5.1 自动获取访客 cookies（不需要人工导出）

**先分清两类 cookies**（这是最容易误解的地方）：

| 类型 | 例子 | 能不能自动化 |
| --- | --- | --- |
| **访客 cookies**（不需要登录） | 抖音/TikTok 的 `ttwid`、`__ac_signature` | ✅ 能，服务端自动获取 + 定期续期 |
| **登录 cookies**（真的要账号） | 会员专享、年龄限制、私有视频 | ❌ 需要你导出一次（或维护账号池） |

抖音实测：向 bytedance 的 `ttwid` 注册接口 POST 一次即可拿到可用 `ttwid`（~1 秒，不需要
浏览器、不需要登录）；再配合站点必需的 `--referer https://www.douyin.com/` 就能正常解析下载。
无头浏览器（服务器上的 chromium）作为兜底，用于只靠 HTTP 拿不到 cookie 的站点。

```bash
curl -u admin:密码 http://127.0.0.1:8080/api/webvideo/cookies/harvest          # 看状态
curl -u admin:密码 -X POST -H 'Content-Type: application/json' \
     -d '{"site":"douyin"}' http://127.0.0.1:8080/api/webvideo/cookies/harvest  # 立即刷新
```

```ts
interface CookieHarvestStatus {
  enabled: boolean;              // 设置项 cookieHarvestEnabled
  chromium: string | null;       // 探测到的浏览器路径（null = 没装；有 HTTP 途径的站点不受影响）
  available: boolean;
  harvestSites: string[];        // 目前启用自动获取的站点（默认 douyin,tiktok）
  hint: string;                  // 中文说明，页面原样展示
  sites: {
    id: string; name: string; auto: boolean;
    hasCookies: boolean; cookieCount: number; ageMinutes: number | null;
    url: string;
    needsBrowser: boolean;       // false = 纯 HTTP 就能拿到
    via: 'http' | 'browser' | null;
  }[];
}
```

`GET /api/webvideo/cookies` 也新增了 `sites: {domain,count,auto,note}[]`（你上传的 cookies.txt
到底覆盖了哪些站点 —— 回答「为什么我传了 Google 的 cookies，抖音还是不行」：cookies 按站点隔离）
与 `harvest` 字段。

**自愈**：下载中若站点报「cookie 失效/需要新鲜 cookies」，程序会自动重新获取一次并重跑策略阶梯
（每个任务最多一次），全程打 `[MARK:COOKIE_HARVEST]` 日志。
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
| GET | `/api/files/:id/download` | 管理端下载（不鉴权，便于排障）；**会累计网页端下载次数**并打 `[MARK:FILE_DOWNLOAD]` |
| GET | `/api/files/pending?q=&page=&pageSize=` | **待下载清单**：已下载完成并加密归档、**安卓端还没上报完成**的成品；返回 `{ items, total, totalBytes, oldestWaitingSec, generatedAt }` |

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
| GET | `/api/android/files` | `{ items: [{ id, name, title, module, sizeBytes, available, url, createdAt }], total, totalBytes }`；只返回**尚未被上报删除**的文件（所以这里 `available` 恒为 `true`） |
| GET | `/api/android/download/:id` | 文件流下载，支持 `Range`（断点续传）；`?token=` 可用 |
| POST | `/api/android/done` | `{ ids: number[] }` → `{ deleted: number, freedBytes: number, skipped: number, errors: [] }` |
| GET | `/api/android/status` | `{ ok:true, freeBytes, reserveBytes, publishedCount, publishedBytes, waitingTasks, downloadingTasks, version }` |
| GET | `/api/android/speedtest/data?mb=N` | **局域网测速用**：服务端凭空吐 N MB 伪随机数据（1~500，默认 50），**完全不读磁盘**，带 `Content-Length`。慢=网络慢，与 aria2/硬盘无关 |
| GET | `/api/android/speedtest?token=…&mb=N` | 手机浏览器直接打开的测速页：跑三轮把 MB/s 用大字显示，并按 `<8 / 8~15 / 15~40 / 40+` 给出结论 |

安卓端约定：
1. 轮询 `/api/android/files` 得到待下载清单（URL 为 `downloadUrl`，可直接交给 aria2）；
2. 下载完成后调用 `/api/android/done` 上报 id；
3. 失败重试、去重（已创建清单）、SD 卡搬移等由 App 本地负责。

> 下载速度慢时的定位顺序：先跑 `/api/android/speedtest`（浏览器打开即可）。
> 服务端自身能力参考值（树莓派 4B，千兆网口）：纯内存吐流 ≈400 MB/s，SD 卡读 ≈43 MB/s。
> 若测速页只能跑到 8~11 MB/s，说明瓶颈在 wifi（典型 2.4GHz），换 5GHz 或网线才有用。

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
