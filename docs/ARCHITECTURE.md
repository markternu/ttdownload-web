# 架构设计（ttdownload-web）

> 本文是**唯一权威设计文档**：目录布局、三大下载模块、统一等待队列、磁盘空间门控、
> 归档/加密/发布流水线、Android 通信协议、部署方式。
> 老脚本（`video_auto.sh` / `all1.sh`）的业务语义在本文中全部保留并做工程化改造。

---

## 1. 背景与改造目标

老方案：`video_auto.sh` 单脚本完成「扫描目录 → V-L-T 标记 → 随机前缀命名 → AES 加密 →
去后缀 → 丢到 nginx html → 生成 dowlist → 安卓 App 读 dowlist 下载 → App 上报
`/autodl/done?file=...` → 脚本删文件」。

新方案（`下载web应用设计.md`）：改造成一个**前后端 Web 应用**，不再依赖 nginx 静态目录，
服务端直接提供 API 与安卓通信。三大下载模块 + 统一等待队列 + 磁盘空间门控 + 归档加密发布。

保留的兼容点（PC 端解密/还原工具仍可用）：

| 兼容点 | 规则 |
| --- | --- |
| V-L-T 尾部标记 | `[原始文件名][4字节大端长度][100字节 "FKY996"+NUL 填充]` |
| 加密算法 | `openssl enc -aes-256-cbc -K sha256(pass) -iv md5(pass)` |
| 加密后 | 追加 `.data` 后**去掉后缀**，最终发布文件无后缀 |
| 命名 | 随机 3 小写字母前缀 + 递增序号（如 `oqq1`），`fom` 前缀禁用 |
| 解密端 | 用同一密码解密后，文件尾仍是 `FKY996`，可还原原始文件名 |

---

## 2. 目录布局（默认根 `/ttdownload`，可用 `DOWNLOAD_ROOT` 覆盖）

```text
/ttdownload/
├── transmission/
│   ├── btzhongzi_zip/            # 用户上传的种子 zip（生产入口）
│   ├── btzhongzi_nodownd/        # 已解压、待下载的种子
│   └── btzhongzi_yijingdownding/ # 已纳入 transmission 下载的种子（归档留痕）
├── downd_aria2_path/             # aria2 模块下载目录
├── downd_web_tools/              # 公开视频URL模块根目录
│   └── downdok/                  # 该模块下载完成的成品
├── downd_ok_p2/                  # 三个模块"下载完成"后的统一归档区
├── downd_ok_p2_jiami_tmp/        # 加密临时区（加密完成即清）
├── xiaofeizhe_downd/             # 消费者(安卓)下载目录：最终加密成品
└── state/                        # 应用状态
    ├── app.db                    # SQLite（任务/文件/设置/日志统计）
    └── indexFXY                  # 命名序号（兼容老脚本）
```

> 三个模块的“完成区”统一汇入 `downd_ok_p2`，再由发布流水线加密进 `xiaofeizhe_downd`。

---

## 3. 三大下载模块（生产者）

### 3.1 transmission（BT 种子）

1. **上传入口**：Web 上传 zip 到 `btzhongzi_zip`（也支持直接往该目录扔文件）。
2. **解压**：定时扫描 zip → 解压出 `*.torrent` → 放到 `btzhongzi_nodownd` → 删除 zip。
3. **入队**：扫描 `btzhongzi_nodownd` 的种子文件，读取种子元数据（transmission RPC
   `torrent-add` + `torrent-get` 获取文件清单），**只保留视频/图片文件**，
   计算这些文件的总大小 `btzhongdaxiao`。
4. **磁盘门控**（见 §4）：`free - btzhongdaxiao >= 10G` 才允许下载。
5. **下载**：调用 transmission 添加任务并只勾选视频/图片文件；成功后把种子文件从
   `btzhongzi_nodownd` 移到 `btzhongzi_yijingdownding`。
6. **完成**：transmission 报告完成 → 把对应下载目录内容移交归档区：
   - 多文件 → 打 zip（名含 `zip`）；单文件 → 直接用该文件；统一按下文命名规则重命名；
   - 然后 **删除 transmission 任务 + 删除其下载目录文件**。

### 3.2 aria2（URL 直链下载）

1. Web 输入框支持**多行 URL**（一行一个）。
2. 下载到 `downd_aria2_path`。
3. 磁盘门控同 §4（能拿到 `Content-Length` 就精确判断，拿不到按 0 处理并在下载过程中监控，
   一旦 `free < 10G` 立即暂停任务）。
4. 完成判定：任务状态 `complete` **且**同目录下没有对应 `*.aria2` 控制文件
   （兼容老脚本语义）。每个任务都是单文件，无需打包。
5. 完成后移交归档区 `downd_ok_p2`。

### 3.3 公开视频 URL（webvideo）

详细交互需求见 `newxuqiu/视频下载工具.md`（首页/解析卡片/质量选择/任务控制/历史/Dashboard/
设置/响应式/错误提示）。实现要点：

- 后端以 **yt-dlp** 为核心：
  - 解析：`yt-dlp -J --no-warnings <url>` → 标题/作者/时长/缩略图/各格式与大小；
  - 下载：`yt-dlp -f <formatId> --newline --progress-template ...` 实时进度、速度、ETA；
  - 平台识别：YouTube / Bilibili / Vimeo / X / TikTok / Instagram / 抖音 等；
  - 不实现 DRM 破解、不绕过付费墙/登录限制；平台限制时给出清晰中文错误。
- 下载到 `downd_web_tools`，完成的成品放 `downd_web_tools/downdok`，再移交归档区。
- 单文件，无需打包。

---

## 4. 统一等待下载队列 + 磁盘空间门控（解决“抢空间”Bug）

三个模块**不各自**判断空间后直接创建任务，而是统一入 `download_tasks` 表（统一队列），
由**唯一的调度器**按下面规则放行：

```
free        = 当前 /ttdownload 所在分区可用字节
reserved    = Σ(所有 running 任务的预期大小，未知按 0 计)
usable      = free - reserved - RESERVE_FREE_BYTES(默认 10GiB)

按 priority DESC, id ASC 取 waiting 任务：
  need  = 任务预期大小（未知时为 0）
  if usable - need >= 0 且 running < maxConcurrent:
        启动该任务；reserved += need
  else:
        跳过（等待下一轮）
```

- 任务完成/失败立即释放 reserved，调度器下一轮自动放行后续任务；
- 下载过程中每 5 秒复查磁盘：`free - RESERVE < 0` 时**暂停**正在下载的任务
  （aria2 `pause` / transmission `stop` / yt-dlp 进程挂起），空间恢复后自动继续；
- 这就是设计文档里要求的「统一等待下载队列」：谁都不许绕过它抢空间。

---

## 5. 归档 → 加密 → 发布流水线（消费者）

1. **归档**：模块完成后文件移交 `downd_ok_p2`：
   - 多文件 → `<目录名>_zip.zip`；单文件原样；
   - 统一重命名为 `<3字母前缀><序号>`（V-L-T 标记写入原始文件名，保证 PC 端可还原）。
2. **加密**：`downd_ok_p2/*` → `downd_ok_p2_jiami_tmp/*`：
   - 仅加密“非 `.data` 且带 FKY996 标记”的明文（防二次加密，崩溃可自愈）；
   - `openssl enc -aes-256-cbc -K <sha256(pwd)hex> -iv <md5(pwd)hex>` → `xxx.data`；
3. **去后缀 + 发布**：`xxx.data` → `xxx`，移入 `xiaofeizhe_downd/`，写入 `published_files` 表。
4. **通知消费者**：不做推送，安卓端**定时轮询** `GET /api/android/files`（设计文档允许
   “客户端定期来访问”）。

---

## 5.5 BT 出清机制（长时间无资源 / 停滞 / 极慢）

BT 下载经常遇到"永远下不完"的任务，必须主动出清，否则长期占用磁盘与下载队列：

| 情况 | 判定条件（满足其一即出清） |
| --- | --- |
| ① 完全无资源 | 速率为 0、无 peer，且进度停滞 ≥ `stallMinutes`（默认 30 分钟） |
| ② 中途停滞 | 曾经有进度，之后速率 0 且进度停滞 ≥ `stallMinutes` |
| ③ 还有资源但极慢 | 速率 > 0 但 < `slowKbps`（默认 20KB/s），且预计剩余 > `slowEtaHours`（默认 72 小时） |

**安全前提（硬门槛）**：只有**实际下载尝试时间 ≥ `minAgeHours`（默认 10 小时）**的任务才参与判断。
"实际尝试时间"按活跃下载状态累计（`payload.btActiveMs`），**因磁盘空间不足被自动暂停的时间不计入**，
手动暂停的任务也不参与判断；服务重启不会清零，单次最多累计一个检查周期（防停机后一次跳满）。

**≥79% 的特殊处理（可播放视为完整）**：进度 ≥ `salvagePercent`（默认 79%）且存在视频文件时**不删除**，
而是停止任务 → 把已存在的视频/图片（下载目录或 transmission incomplete 目录里都能找到）交给
**归档 → 加密 → 发布**流水线；发布完成后再清理残留目录（含 incomplete 目录里的分片）。

**删除动作**：
1. `torrent-remove`（`delete-local-data=true`）删除 transmission 任务与数据；
2. 删除我们自己的下载目录 `transmission/downloads/<种子名>`；
3. 删除 transmission incomplete 目录（默认 `/var/lib/transmission/incomplete`）下对应任务的文件夹；
4. 任务状态置为 `failed` 并写明原因（"已出清（无资源/停滞无资源/资源过慢）：…"），种子记录同步标记；
5. **广播"空间已腾挪"**（见 §6.1）。

安全边界：只允许删除白名单根目录（`transmission/downloads`、`transmissionIncompleteDir`、`btPending`）
内的普通目录，拒绝根目录、符号链接、隐藏目录与路径穿越。

手动操作：`GET /api/bt/stale`（dry-run 预览）、`POST /api/bt/evict`（立即执行）；
Web 端在「BT 种子」页有「出清预览 / 立即出清」按钮，在「设置」页可调全部阈值。

---

## 6.1 空间腾挪广播（space-freed）

只要有空间被释放，服务端就广播一次 `space-freed` 事件（SSE `event: space`），
调度器收到后**立即重新评估等待队列**（不必等下一个 3 秒 tick）：

| 触发点 | reason |
| --- | --- |
| 安卓上报下载完成、服务端删除文件 | `android-reported-done` |
| BT 出清删除任务与目录 | `bt-evict` |
| BT "可播放文件"归档发布后的残留目录清理 | `bt-salvage-cleanup` |
| 手动取消 BT 任务并清理目录 | `bt-cancel` |

事件载荷：`{ bytes, reason, at, detail }`；无论释放多少字节都会通知。

---

## 6. 清理（消费者下载完成后删除）

安卓下载完成 → `POST /api/android/done {ids:[...]}` → 服务端：
- 校验 id 与路径安全（仅允许 `xiaofeizhe_downd` 内普通文件，拒绝 `..`/符号链接）；
- 删除文件、标记 DB、记录审计日志、释放空间；
- 调度器下一轮立即把等待队列里的任务放行（空间腾挪自动生效，不需要广播）。

---

## 7. 服务端组件

| 组件 | 说明 |
| --- | --- |
| `src/core/config.ts` | 环境变量/默认配置（目录、端口、密码、并发、10G 阈值、RPC 地址、token） |
| `src/core/db.ts` | SQLite 初始化 + 迁移（tasks / published_files / seed_files / settings / event_logs） |
| `src/core/logger.ts` | 控制台 + 文件日志（`state/app.log`，按大小滚动） |
| `src/core/disk.ts` | 分区可用空间、目录大小、10G 门控计算 |
| `src/core/scheduler.ts` | 唯一调度器：并发限制 + 空间预留 + 暂停/恢复 |
| `src/modules/*` | transmission / aria2 / webvideo 三个生产者 + 完成检测 |
| `src/services/archive.ts` | 归档（打包/命名/VLT 标记） |
| `src/services/crypto.ts` | AES-256-CBC 加密、去后缀、发布 |
| `src/services/cleanup.ts` | 安卓上报删除 + 安全校验 |
| `src/services/pipeline.ts` | 归档→加密→发布 定时worker |
| `src/routes/*` | REST API + SSE + Android API |
| `web/` | React + TS + Vite + Tailwind 管理界面（构建产物由后端静态托管） |

---

## 8. 运行时依赖的外部工具

| 工具 | 用途 | 缺失时行为 |
| --- | --- | --- |
| `aria2c` | aria2 模块下载 | 该模块任务失败并提示安装 |
| `transmission-daemon`/`transmission-remote` | BT 模块 | 同上 |
| `yt-dlp` | 公开视频模块 | 同上 |
| `ffmpeg` | 视频合并（可选） | 降级，部分格式失败提示 |
| `openssl` | 加密（必须有） | 服务启动即报错退出 |
| `zip`/`unzip` | 归档打包/解压 | 该任务失败并提示 |

---

## 9. 部署形态

- **一键脚本**：`sudo ./deploy.sh`（在全新 Ubuntu 上：装依赖 → 建目录 → 装 Node →
  `npm ci && npm run build` → 生成 `.env` → 注册 systemd 服务 → 启动 → 自检）。
- **Docker**：`docker compose up -d`（含 Node 应用；宿主目录挂载 `${DOWNLOAD_ROOT}`）。
- 端口默认 `8080`（可改），不再需要 nginx；若用 nginx 反代，仅作 TLS/域名入口。

---

## 10. 与安卓的通信（摘要，完整见 docs/API.md）

| 方向 | 接口 |
| --- | --- |
| 拉取可下载清单 | `GET /api/android/files`（token） |
| 下载文件 | `GET /api/android/download/:id`（支持 Range，token） |
| 上报下载完成 | `POST /api/android/done {ids:[...]}`（token） |
| 状态自检 | `GET /api/android/status`（token） |

鉴权：请求头 `X-Auth-Token: <ANDROID_TOKEN>`（或 query `?token=`，便于 aria2 直接下载）。
