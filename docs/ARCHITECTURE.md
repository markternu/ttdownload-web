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
│   └── btzhongzi_yijingdownding/ # （已弃用：种子交给 transmission 成功后直接删掉，不再归档留痕）
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

> ⚠️ 这一节在 BT 重构时改过：**只下视频**（不再保留图片）、加种子/选片/算大小全部提前到
> `prepare()`、下载完成后交给**扫货**（§5.6）而不是"完成即归档"。

1. **上传入口**：Web 上传 zip 到 `btzhongzi_zip`（也支持直接往该目录扔文件）。
2. **解压**：定时扫描 zip → 解压出 `*.torrent` → 放到 `btzhongzi_nodownd` → 删除 zip。
3. **入队**：扫描 `btzhongzi_nodownd` 的种子文件 → 登记 `seeds` 表 → 用户点"加入下载"或自动
   入队成统一队列任务（`transmission` 模块）。
4. **`prepare()`（放行前，关键）**：
   - `torrent-add { metainfo, paused: true }` —— **暂停加入，一个字节都不下**；
   - `torrent-get` 拿文件清单 → **只勾选视频**（扩展名白名单，大小写不敏感），其余标 unwanted；
   - 多个视频再"**挑同类**"（独树一帜下最大 / 相差无几一起下 / 最大的太小且小的成堆则下小的）；
   - 算出选中视频总字节写进 `expectBytes`（**磁盘准入就靠它**，见 §4）；
   - 确认接管成功 → **删掉那个 `.torrent` 文件**（transmission 自己已存元数据）。
   - **绝不传 `download-dir` / `incomplete-dir`**：transmission 以 `debian-transmission` 运行，
     改成我们的目录会让它下完搬文件时 `Permission denied`（真机事故，见 HANDOVER §3.1）。
5. **`start()`**：只做 `torrent-start`，并记下 `btHandedAt`（8 小时策略的起点）。
6. **`poll()`**：**只读进度**，不干涉。下完的货由**扫货**（§5.6）交进归档 → 加密 → 发布；
   超时的由**超时策略**（§5.5）清理。
7. **入队逻辑为什么这么绕**：早期加种子/选片/算大小都在 `start()` 里，准入时 `expectBytes=0`
   →"需要 0 字节"永远放行 → 十几个种子撑爆磁盘 → 触发全暂停死锁。所以现在
   **`prepare` 必须在放行前算出真实大小**，且**幂等**（已有 `torrentId` 直接复用，这个判断要放在
   "检查种子文件存在"之前 —— 种子文件 prepare 成功后就被删了）。

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
  - **尽力下载策略阶梯**：一次任务按顺序尝试多种方式（指定格式 → 登录态/cookies → 最佳画质 →
    YouTube 多客户端回退 → 长重试+放宽校验 → `--impersonate` → 内嵌客户端 → 单文件不合并 →
    仅视频流 → 仅音频保底），**任何一种成功即完成，全部失败才判失败**；错误里带「已自动尝试 N 种方式」。
  - **解析失败不阻断**：`prepare()` 对解析异常容错（记 `payload.parseError` 后继续），`/parse` 返回
    `degraded` 结果，前端显示「解析受限（仍可下载）」并允许入队。
  - **cookies 支持**：`--cookies <file>`（默认 `DOWNLOAD_ROOT/state/cookies.txt`，可在设置页上传）
    或 `--cookies-from-browser <browser>`，用于会员专享 / 需登录 / 年龄限制 / 人机校验；
    `--`额外参数（如代理）由设置页 `webvideoExtraArgs` 追加到每次调用。
  - 仅 DRM 保护等真正无解的情况才立刻失败；会员/登录/私有类错误按 `autoRetry` 自动重试。
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

## 5.5 BT 超时策略（8 小时 / 4 小时宽限）

> ⚠️ 这里在 BT 重构时被**整段替换**过。旧文档写的"无资源/停滞/极慢 + `btEvict.*` 阈值 + 10 小时门槛"
> **已经不存在了**（旧配置字段还留在 config 里，但没人读，无害）。现在只有一条规则：

| 阶段 | 规则 |
| --- | --- |
| 交给 transmission 后 8 小时内 | **只读进度**（`poll`），不暂停、不删、不改勾选 —— 有的资源这会儿没速度，过一小时才上线，干涉只会把能下完的搞坏 |
| 满 8 小时（`btPolicy.checkAfterHours`） | 进度 **≤ `minProgressPercent`（默认 60%）** → 直接清理 |
| 进度 **> 60%** | 再宽限 `graceHours`（默认 4 小时，即最晚 12 小时）→ 到点还没下完也清理 |
| 已经 100% | 不归这里管，由**扫货**（§3.1、`btHarvest`）拿走 |

**计时起点**：`payload.btHandedAt`（`start()` 真正 `torrent-start` 的那一刻）。
`prepare` 过但还在排队（等磁盘空间）的时间**不算**。

**清理动作**（`btEvict.dropTorrent` → `btCleanup.cleanupBtTaskDirs`）：

1. `torrent-remove`（`delete-local-data=true`）删掉 transmission 任务与数据；
2. 删本任务占用的目录（**独占才整目录删**；被别的活跃任务共用 → 一个字节都不动，见 §5.6）；
3. 任务状态置 `failed`，写明原因（"超时清理：已交给 transmission X 小时，进度只有 Y%"）；
4. **广播"空间已腾挪"**（见 §6.1），调度器立刻重算等待队列。

安全性：只允许删白名单根目录（`btDownload`、`transmissionIncompleteDir`、`btPending`）内的普通
文件/目录，拒绝根目录、符号链接、隐藏目录与路径穿越；**不是自己的文件不删**。

手动操作：`GET /api/bt/stale`（dry-run 预览）、`POST /api/bt/evict`（立即执行）；
Web 端「BT 种子」页有「出清预览 / 立即出清」按钮，「设置」页可调 `checkAfterHours` /
`minProgressPercent` / `graceHours`。日志标记：`BT_TIMEOUT_GRACE` / `BT_TIMEOUT_DROP`。

---

## 5.6 BT 扫货（harvest：把下好的货交给流水线）

与超时策略**完全独立**的 worker（`btHarvest`，每 2 分钟一轮），只管"目录里的好东西"：

```
扫 transmission 的两个目录：
downloads（下完了的）：
  · 1 个视频            → 单独走（直接改名加密归档）
  · 多个但全都 <阈值     → 合成一个 zip 再走
  · 有 ≥阈值(默认300MB)  → 大的各自单独，小的合成一个
  · 一个目录只建一个任务（内部带多个"成品单元"）
  发布成功后 → 删该目录 + 删 transmission 任务 + 下载任务收尾
incomplete（还在下的）：
  · 只有 1 个文件 → 跳过
  · 多个且其中有下完的 → 只把下完的交出去（按同样规则）
  · **绝不动目录、绝不动 transmission 任务**
```

为什么不在下载完成的瞬间处理：用户要求"扔给 transmission 就别管它，8 小时内不干涉"。
扫货按目录独立判断，天然不会干扰 transmission。

为什么一个目录只建一个任务：拆成多个任务时，先完成的那个收尾会删掉目录，而
`archiveTaskFiles` 的 zip 分支**不删源文件** → 正在打包的那个任务源文件就没了。

收尾时的共用判定（`btCleanup.findSharedDirs`）：还有别的非终态任务在用这个目录、
或别的任务的文件还躺在里面 → **整块跳过**（宁可晚点释放空间，也不误删别人的文件）。
日志标记：`BT_HARVEST` / `BT_CLEANUP` / `BT_CLEANUP_SHARED` / `BT_EARLY`。

---

## 6.1 空间腾挪广播（space-freed）

只要有空间被释放，服务端就广播一次 `space-freed` 事件（SSE `event: space`），
调度器收到后**立即重新评估等待队列**（不必等下一个 3 秒 tick）：

| 触发点 | reason |
| --- | --- |
| 安卓上报下载完成、服务端删除文件 | `android-reported-done` |
| BT 超时清理删除任务与目录 | `bt-timeout` |
| BT 扫货发布完成后的目录清理 | `bt-harvest` / `bt-cleanup` |
| 手动取消 BT 任务并清理目录 | `bt-cancel` |

事件载荷：`{ bytes, reason, at, detail }`；无论释放多少字节都会通知。
⚠️ `detail` 会被调度器的 `SPACE_FREED` 日志**整段打出来** → 里面不许放种子名/原始路径（见 HANDOVER §6.1）。

---

## 6.2 可观测性：标记日志 + 网络自检 + 诊断包（调试期）

项目处于实操测试阶段，设计目标是「**用户把日志发过来就能定位问题**」。

### 6.2.1 标记（MARK）日志

`src/core/logger.ts`：

- 五级：`error/warn/info/debug/trace`，运行时可切（`POST /api/system/debug` 或网页「日志」页），默认 `debug`
- 行格式：`ISO时间 [LEVEL] [MARK:XXX] [scope] msg :: {结构化 JSON}`
- `MARKERS` 常量表登记所有标记及含义（网页会展示对照表，`/api/system/logs` 也会返回）
- 作用域日志：`logger.child('ytdlp')`、`taskLog(taskId, 'ytdlp')` → `[task#12>ytdlp]`
- 自动脱敏：`token/password/secret/authorization/api_key/Bearer` → `***`
- 文件轮转：`LOG_MAX_MB`（默认 20MB）× `LOG_KEEP_FILES`（默认 5），路径 `${state}/app.log`
- 内存环形缓冲（4000 行）供网页实时查看；`debug` 及以上走 SSE 推给前端
- 进程级兜底：`uncaughtException` / `unhandledRejection` 写入 `[MARK:ERROR]` 带堆栈

埋点覆盖：HTTP 请求/响应/异常、调度每一拍与磁盘门控数值、任务创建/流转/失败/重试、
外部命令（`PROC_SPAWN`/`PROC_EXIT`：完整 argv、退出码、耗时、stdout+stderr 摘要）、
yt-dlp 解析与策略阶梯每一步、aria2/transmission RPC（含 409 协商与认证）、
流水线归档/加密/发布、BT 出清判定、安卓接口、设置更新、SSE 连接、诊断导出。

### 6.2.2 网络自检（`src/services/netCheck.ts`）

`GET /api/webvideo/network` 逐项真实出网测试（结果缓存 60 秒，`refresh=1` 强刷）：

1. `proxy`：展示 `HTTP(S)_PROXY`/`ALL_PROXY` 与 yt-dlp 额外参数（凭据打码）
2. `dns`：解析 youtube / googlevideo / github
3. `https-google` / `https-youtube` / `https-github`：三个独立 HTTPS 探测 + 耗时
4. `ytdlp-version`：工具可用性
5. `ytdlp-youtube-meta`：真跑 `yt-dlp -J`（带上用户配置的 cookies/代理）解析公开测试视频
6. `youtube-cdn`：`--get-url` 拿直链后带 `Range: bytes=0-0` 真读 1 字节 —— **能过这关才代表真的下载得动**
7. `aria2-rpc` / `transmission-rpc`：本机下载引擎

每项含 `status/latencyMs/detail/hint`，`overall` 聚合为 `ok|partial|fail`，首页「网络自检」面板展示。

### 6.2.3 诊断包

`GET /api/system/diagnostics`：一个 JSON 附件，包含 app/env/config/settings/disk/tools/tasks/events/
network/markers/logs（每个日志文件尾部 2MB）。环境变量与设置里的 token/密码按 key 名脱敏。
用途：用户遇到问题时下载后直接发给开发者。

### 6.2.4 问题反馈页与报告打包（`src/services/report.ts`）

`GET /api/system/report` 生成一份**单文件报告**（优先 zip，系统无 `zip` 时退化为 JSON），
网页「问题反馈」页（`/report`）提供一键下载按钮与单项下载清单：

| 端点 | 作用 |
| --- | --- |
| `GET /api/system/report` | 完整报告：README + diagnostics/system-info/tasks/network/markers JSON + errors.log + app.log(含轮转) + deploy.log |
| `GET /api/system/report/list` | 页面用的可下载项清单（标题/说明/文件名/大小/时间/下载地址/是否推荐） |
| `GET /api/system/report/file?name=` | 重新下载历史报告（白名单正则 + `basename`，防目录穿越） |
| `GET /api/system/logs/export?level=&marker=&q=&lines=` | 过滤导出日志（默认 warn 及以上，只带 WARN/ERROR 与失败标记相关行） |
| `GET /api/system/deploy-log` | 下载 `deploy.sh` 输出日志 |
| `GET /api/system/report/tasks?format=json\|csv` | 任务清单 + 失败原因（CSV 带 BOM） |
| `GET /api/system/report/network` | 强制重测并下载网络自检报告 |

要点：
- 报告里**必带 git 版本**（`app.git`）与 README 里的版本行，方便把日志与代码版本对应
- 环境变量与设置按 key 名脱敏；`logger.redact` 同时作用于消息体与结构化数据（含入库副本）
- 报告生成时**网络自检有 8 秒预算**（`networkReportWithBudget`），超时带说明跳过，避免按钮久等
- 报告落在 `${state}/reports/`，只保留最近 5 份
- 服务根本起不来时：`sudo ./deploy.sh --collect` 离线打包日志（不依赖服务运行）

### 6.2.4.1 transmission 反向代理开关（`src/services/btProxy.ts`）

远程服务器只开 22/80/443 时，transmission 的 `127.0.0.1:9091` 外网访问不到。这个服务把
「改 nginx 配置」这件危险的事固定成一条可审计的路径：

- **职责分离**：Node 只做参数校验、`transmission session-get` 安全预检（没设 RPC 密码就拒绝暴露到公网）、
  结果解析与 `[MARK:NGINX_PROXY]` 埋点；真正的配置改动全部交给 `deploy/scripts/nginx-proxy-toggle.sh`，
  命令行也能跑同一份脚本（`deploy.sh --bt-proxy`）。
- **只加不减**：只新增独立 snippet（`snippets/ttdownload-proxy-<子路径>.conf`）并在**监听 80 的 server 块**
  里插一行 `include`（用 `nginx -T` 全量 dump 打分定位，避开 443 与别人的站点）；关闭时删掉那行 include
  与 snippet —— 是**真的删除配置**，不是防火墙屏蔽。
- **不怕改坏**：改动前备份到 `/etc/nginx/ttdownload-backup-<时间>/`，改完 `nginx -t`，
  失败立即回滚并以 500 返回 nginx 原话；`proxy_pass` 结尾不带斜杠以保留 `/transmission` 前缀
  （transmission WebUI 内部用绝对路径）。
- **可移植**：脚本不用 `sed -i`（GNU/BSD 参数不兼容会让它静默不改文件），改配置一律 awk + 原子替换。

### 6.2.5 修复脚本通道（`src/services/scriptRunner.ts`）

代码问题走 Git + `deploy.sh --update`；**环境问题**（缺包/权限/systemd/Node 版本）由开发者生成脚本、
用户在本页上传执行。因为这是「上传即 root 执行」，实现上做了多层约束：

| 约束 | 实现 |
| --- | --- |
| 默认关闭 | 设置项 `scriptUploadEnabled`（env `SCRIPT_UPLOAD_ENABLED`，默认 0） |
| 令牌 | `tokenOk()` 常数时间比较；`MAINTENANCE_TOKEN` → 回退 `ANDROID_TOKEN`；无令牌时返回明确错误码 |
| 执行前预览 | 上传只落盘；`GET /:id` 返回 `preview` 供页面展示，执行是独立动作 |
| 输入校验 | 文本、≤1MB、拒绝二进制、仅 `.sh/.bash`（或 shebang） |
| 独立执行 | `systemd-run --unit ttdl-fix-<id> --collect` 起瞬时单元（脱离本服务 cgroup，服务重启不中断）；无 systemd 时 `setsid` 分离 |
| 超时 | 包装脚本内 `timeout <sec> bash -x <script>`（无 timeout 命令时降级并注明），超时码 124 |
| 留痕 | 脚本/包装器/日志落 `state/scripts/`（0700/0600），`[MARK:SCRIPT_UPLOAD]`/`[MARK:SCRIPT_RUN]` 记录上传、开关、启动方式、退出码、超时 |
| 保留 | 最近 20 份，运行中的不清理 |

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
| `src/core/logger.ts` | 标记日志（级别/轮转/脱敏/环形缓冲）、标记登记表 |
| `src/core/procLog.ts` | 外部命令调用日志（argv/退出码/耗时/输出摘要） |
| `src/services/netCheck.ts` | 网络自检（DNS/HTTPS/yt-dlp/CDN/RPC）|
| `src/services/report.ts` | 问题反馈报告打包（zip/JSON）、错误摘要、任务清单导出、git 版本 |
| `src/services/scriptRunner.ts` | 修复脚本上传/执行（令牌、预览、独立单元、超时、留痕） |
| `src/services/btProxy.ts` | transmission 9091 的 nginx 子路径反代开关（安全检查/状态汇总/日志埋点，实际改配置交给 `deploy/scripts/nginx-proxy-toggle.sh`） |
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
