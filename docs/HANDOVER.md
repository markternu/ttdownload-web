# 接手指南（新对话 / 新接手的人，先读这一份）

> 目的：**你读完这一份，就知道这个工程是什么、现在什么状态、哪些规矩不能破、怎么改怎么测怎么部署。**
> 最后更新：BT 模块大重构之后（见 HISTORY 小节）。配套：[`ARCHITECTURE.md`](ARCHITECTURE.md)｜[`排查手册.md`](排查手册.md)｜[`API.md`](API.md)

---

## 0. 三十秒了解

`ttdownload-web` 是这套东西的**服务端**：Node + TypeScript + Express + better-sqlite3。
它管三件事：

1. **统一下载队列**（三种任务：在线视频 webvideo / 直链 aria2 / BT 种子 transmission），
   队列准入**只看磁盘空间**（见第 4 节）。
2. **流水线**：下载完成 → 归档（多文件打 zip）→ 加密（AES + 去掉后缀）→ 放进「消费者目录」，
   等着安卓 App 来取（取走并上报后，服务端删成品、腾空间）。
3. **Web 管理界面**（`web/`，React + Vite），以及给安卓 App 用的 `/api/android/*` 接口。

**同一套东西还有另外两个工程**（都在 `/Users/wt/Desktop/androidapp/` 下）：

| 工程 | 路径 | 仓库 | 说明 |
| --- | --- | --- | --- |
| 服务端（本工程） | `github/ttdownload-web` | `markternu/ttdownload-web` | Node 服务端 + 网页 |
| 安卓 App | `github/AriaNgGUI_AutoDL_Android` | `markternu/AriaNgGUI_AutoDL_Android` | 二次开发版：自动下载列表、SD 卡搬移、aria2 调优 |
| 安卓解密 App | `github/VltRestore` | `markternu/VltRestore` | 纯 Java、零依赖，把服务端加密的 `.data` 还原 |

---

## 1. 一分钟跑起来（本地）

```bash
npm install
npm run build          # tsc -> dist/
npm run build:web      # 前端 -> public/
npm run dev            # 开发模式（或 node dist/server.js）
npm run test:only      # 后端测试（当前 221 项）
npm run test:browser   # 真浏览器冒烟（需本机 Chrome + playwright，23 项）
```

外网/生产部署（Ubuntu/Debian/树莓派）：

```bash
git pull && sudo ./deploy.sh --update      # 拉代码 + 重建 + 重启（最常用）
sudo ./deploy.sh --logs 200                # 看日志
sudo ./deploy.sh --check-deps              # 只读：依赖体检
sudo ./deploy.sh --collect                 # 服务起不来时离线打包日志
```

---

## 2. 当前状态

- 后端 **231 项测试**、浏览器 **23 项**全绿；已在树莓派（Debian + transmission 4.x）实机部署验证。
- 安卓端 v1.4.1 已对接本服务端的 `/api/android/*`（多台服务器、自动扫描、下载后上报、SD 搬移）。
- **本窗口刚做完的大改动：BT 模块整体重构**（第 3 节）、磁盘准入、
  **BT 日志脱敏的全链路补齐**（§6.1），以及**部署前代码审查抓到的一批真 bug**（§8.1，都有回归测试）。

---

## 3. BT 模块（最近重构，务必先看懂这一节）

### 3.1 数据在哪 —— 绝不覆盖 transmission 的目录

transmission 以 **`debian-transmission`** 用户运行，它的两个目录：

```
/var/lib/transmission/downloads     ← 下完了的
/var/lib/transmission/incomplete    ← 正在下的
```

**我们绝不传 `download-dir`**（`.env` 里 `BT_DOWNLOAD_DIR` / `TRANSMISSION_INCOMPLETE_DIR` 指向它们）。

> 血案：以前给每个种子传 `download-dir=/ttdownload/transmission/downloads/<名字>`（root 所有），
> transmission 下完从 incomplete 搬过来时 `Permission denied (13)`，**每个完成的种子都失败**、
> 文件永远进不了 downloads、扫不到货、发布列表永远是空的。

### 3.2 完整流程

```
① 上传 zip / .torrent → 解压到 transmission/btzhongzi_nodownd → 登记 seeds 表 → 入队成任务
② prepare（调度器放行前）：
     · torrent-add { metainfo, paused: true }   ← 暂停加入，一个字节都不下
     · 只勾选视频（扩展名白名单，大小写不敏感），其余标 unwanted
     · 多个视频再"挑同类"（独树一帜下最大 / 相差无几一起下，见 3.3）
     · 算出选中视频总字节 → 写进 expectBytes（**排队就靠它**）
     · 确认接管成功后：**删掉那个 .torrent 文件**
③ start：只做 torrent-start（真正开下）
④ 8 小时内：poll **只读进度**，不暂停、不删、不改勾选
⑤ 超时策略（btEvict，每 10 分钟）：满 8h 进度 ≤60% → 清理；>60% → 再宽限 4h，到点没完也清理
⑥ 扫货（btHarvest，每 2 分钟，与 ⑤ 完全独立）：
     扫那两个目录 → 下好的视频交给流水线（归档→加密→发布）
     downloads：1 个→单独；都 <300MB→合成一个 zip；有 ≥300MB→大的各自单独 + 小的合成一个
                **一个目录只建一个任务**（带多个成品单元），发布成功后删目录 + 删 transmission 任务
     incomplete：只有 1 个文件→跳过；多个且有下完的→只把下完的按同样规则交出去（不动目录/任务）
```

### 3.3 选片规则（两条，配置在设置页「BT 下载规则」）

1. **只下视频**：扩展名属于 `config.videoExts`（mp4/avi/wmv/mkv/flv/webm/mov/ts/m2ts/rmvb…，大小写不敏感）。
   **不做任何"广告识别"** —— 用户明确要求删掉了（关键词/图片策略/体积下限那套会把正片误杀）。
2. **多个视频挑同类**（`pickDominantVideos`，"独树一帜，下最大；相差无几，一起下"）：
   - 最大的 ≥ 第二大的 `bigRatio`(默认 5) 倍 → 只下最大的
   - **例外**：最大的本身不到 `smallCeilingBytes`(默认 200MB) 且后面有 ≥ `manySmallCount`(默认 3) 个小文件
     → 那个"大"其实是片头/预告，改下那堆小文件
   - 否则：取与最大者相差不超过 `bigRatio` 倍的那一组（同类），其余排除

### 3.4 BT 相关的关键文件

| 文件 | 干什么 |
| --- | --- |
| `src/modules/transmission.ts` | prepare/start/poll、只挑视频、挑同类、删种子文件 |
| `src/services/btSelect.ts` | 纯函数：视频筛选 + `pickDominantVideos` + `buildPublishUnits` |
| `src/services/btHarvest.ts` | **扫货**（独立 worker，每 2 分钟） |
| `src/services/btEvict.ts` | **超时策略**（8h/4h，独立 worker，每 10 分钟） |
| `src/services/btCleanup.ts` | 目录清理（独占才整删 / 共用只删自己的 / 非空目录绝不动） |
| `src/services/btAnon.ts` | **日志脱敏**（见第 6 节） |
| `src/services/pipeline.ts` | 归档→加密→发布；支持一个任务多个成品单元 |

---

## 4. 磁盘与队列准入（唯一闸门是空间，不是并发数）

```
可用于下载 = 系统可用 − 预留(reserveFreeBytes, 默认 10G) − 正在跑任务的预留
按先进先出依次看等待队列：
   装得下 → 放行，usable 扣掉，继续下一个
   装不下 → **跳过它**，让后面装得下的先跑（不浪费空间）
回血（任务完成 → 安卓取走 → 服务端删成品）后自动继续
```

- **并发数不是限制**：`maxConcurrent` / `moduleConcurrency` 默认全 **0 = 不限**。
  （血案：这里曾经写死 1/3，导致"磁盘还空着 18G 却只跑一个任务"。而且真正生效的默认值在
  `.env` 的 `MAX_CONCURRENT`/`CONCURRENCY_*`，改代码对已部署机器无效 —— deploy.sh 里有自愈。）
- **预留 10G 是给「归档/加密/发布」周转的操作空间**（加密完成后才删源文件，所以这块一直留着）。
  ⚠️ **红线：未经用户明确同意，绝不改动 `RESERVE_FREE_BYTES`（或任何用户配置值）。** 用户已明确：
  没有这 10G，空间被下载吃满时加密/归档直接没法操作。前端所有磁盘文案必须统一这个口径 ——
  显示的数字是**「（项目）可用于下载的空间」**，并且必须写明**操作系统实际可用 = 该数字 + 预留**。
  所以前端显示的一律是「**可用于下载**」，不是 `df` 看到的那个数。
- 空间压力保护：只在 `usable < 0` 时暂停**多余的**任务，**至少留一个在跑**
  —— 否则暂停的永远下不完、空间永远回不来（**永久死锁**，真出过事）。

---

## 5. 不能破的规矩（每条都是真事故换来的）

1. **绝不覆盖 transmission 的 `download-dir`**（第 3.1）。
2. **`prepare` 必须在放行前算出真实大小**。以前加种子/算大小都在 `start` 里，
   准入时 `expectBytes=0` → "需要 0 字节"永远放行 → 十几个种子撑爆磁盘 → 触发全暂停死锁。
3. **`prepare` 幂等**：已有 `torrentId` 就直接复用，且**这个判断要放在"检查种子文件存在"之前**
   （prepare 成功后 .torrent 就被删了，再查会误判"种子不存在"而永久失败）。
4. **一个扫货目录只建一个发布任务**（内部带多个成品单元）。拆成多个任务时，
   先完成的那个收尾会删掉目录，正在 zip 的那个源文件就没了
   （因为 `archiveTaskFiles` 的 zip 分支**不删源文件**）。
5. **清理目录**：独占才整目录删；被别的任务共用（或别的任务的文件还躺在里面）→ 只删自己的、非空一律保留。
6. **BT 日志脱敏**（第 6 节）。
7. 改 `aria2.conf` 性能参数要三思（安卓端那套是拿真机日志算出来的，`test/autodl.test.js` 有回归）。
8. `.env` 优先级高于代码默认值 —— 改默认值必须同时改 `deploy.sh` 的模板 + 自愈逻辑。
9. 全仓库 shell 脚本里 **`$VAR` 后面不能紧跟全角字符**（bash 在 C locale 下会把它当成变量名的一部分 →
   `unbound variable`）。已经全仓库扫过一遍。
10. **装 Node 时 `nodejs` 和 `npm` 绝不能写进同一条 apt 命令**。NodeSource 的 `nodejs` 包
    **自带 npm**，且与发行版的 `npm` 互斥（发行版 npm 依赖发行版 nodejs）→ 两个一起点名，
    apt 直接甩 `E: Unable to correct problems, you have held broken packages.`，
    全新 Ubuntu 上部署就卡死在 Node 这步（**真机事故，见 §8.1 第 12 条**）。
    只有**发行版仓库**（NodeSource 的源已摘掉）里，`nodejs` + `npm` 才是配套的、才能一起装。
    回归测试：`test/deploy-script.test.mjs` 的【血案回归】两条（用假 apt 复现了这个冲突）。

---

## 6. 日志与排障

### 6.1 BT 日志脱敏（硬要求，别破）

**BT 相关日志里绝不出现种子名、内容文件名、以及带这些名字的完整路径**（用户要求）。
数据库/网页界面里的真实标题照旧（用户自己要看到），**只脱敏日志**。

实现都在 `src/services/btAnon.ts`：

| 函数 | 用途 |
| --- | --- |
| `HIDDEN_NAME` | 统一占位「（名称已隐藏）」 |
| `anonFile(i)` | 第 i 个文件的匿名标签（文件1/文件2…），同一任务内稳定 |
| `hideName(x)` | 任何名字 → 统一占位 |
| `hidePath(x)` | 只留目录、砍掉最后一段（用于"目录名才是种子名"的情形） |
| `hidePathDeep(x)` | **文件级路径用这个**：`…/transmission/downloads/<种子名>/<文件名>.mp4` 里有两段名字，只砍最后一段不够；认得出 transmission 目录就只留到该目录，否则只留前两段 |
| `hideText(x)` | 文本兜底：把 `/xxx` 形式的路径片段全换成占位（用于 `e.message`、`errorString`、RPC `result`） |

几条**踩过才知道**的规则，改 BT 代码时必须守：

1. **子进程调用的 argv 也是日志**。`runCommand(zip, [...源文件绝对路径])` 会让 `PROC_SPAWN` 把
   所有内容文件名打出来；`unzip` 的输出可能回显包内 `.torrent` 名。所以这类调用必须传
   `{ hideArgs: true, hideOutput: true, label: '…' }`（见 `archive.ts`）。
2. **绝不打印 transmission 的响应体**。`torrent-get` 的响应含种子名 + 全部文件名；
   失败时只记 `result` 与 http 状态（`TR_RPC`）。
3. **space-freed 广播的 `detail` 会被调度器整个打进 `SPACE_FREED` 日志**，
   所以那里不能带 `torrentName` / 原始路径（`btCleanup.ts`、`btEvict.ts` 都踩过）。
4. **任务失败信息也要脱敏**：文件系统报错形如 `EACCES: … open '/…/名字.mp4'`，调度器
   落日志前对 BT 过一遍 `hideText`（任务表里的 `error` 字段保留原文，界面要看）。
5. **诊断报告（要发给开发者的那份）**：`report.ts` 的 `taskForExport()` 会把 BT 任务的
   标题、`payload` 里的种子名/路径一并隐藏 —— 报告是分享物，不脱敏等于泄露内容。

回归测试：**`test/bt-log-redaction.test.mjs`**（6 个阶段：上传/解压/选片/开下 → 扫货/归档/
加密/发布/清理 → 超时清理 → RPC 失败 → 任务失败消息 → 诊断报告）。它跑完后翻**整个 app.log
+ 日志表**，任何隐藏名字不得出现，同时反过来断言"数据库里真实标题照旧"。
改 BT 日志相关代码后必跑；可以故意把某处改回直接打名字来确认它真的会红。

### 6.2 常用标记

`grep -aE 'MARK:(BT_|DISK_GATE|TASK_)' /ttdownload/state/app.log`：

| 标记 | 含义 |
| --- | --- |
| `BT_SELECT` | 只挑视频的结果（数量/大小） |
| `BT_PICK` | 多视频挑同类（哪条规则、下几个） |
| `BT_PREPARE` | 已备好（种子暂停中，等空间准入）+ 要下多少 |
| `BT_SEED_DELETED` | transmission 已接管，种子文件已删 |
| `BT_EARLY` | 大文件提前交付（先进入归档/加密/发布） |
| `BT_HARVEST` | 扫货：扫到什么、交了什么、清理了什么 |
| `BT_TIMEOUT_GRACE` / `BT_TIMEOUT_DROP` | 超时宽限中 / 已清理 |
| `BT_CLEANUP` / `BT_CLEANUP_SHARED` | 目录清理 / 因为共用而跳过 |
| `DISK_GATE` | 空间准入：谁被放行、谁被跳过、可用多少 |
| `MODULE_GATE` | 模块并发满（默认 0=不限，一般不会出现） |
| `SPACE_FREED` | 空间回血，立刻重算等待队列 |
| `SETTINGS_MIGRATE` | 旧配置被自动修正（会写清改了哪一项） |

这张表登记在 `src/core/logger.ts` 的 `MARKERS`，会出现在网页「日志」页的筛选下拉与诊断包的
`markers.json` 里。**新增埋点时顺手登记**，否则用户按标记排查时查不到含义。
`report.ts` 的 `errorsLog()` 也会把上面这些 BT 节点的 INFO 行收进 `errors.log`。

排障手册（`docs/排查手册.md`）按现象分类，含 4.95「一堆任务全停住+磁盘满+零成品」那次的完整复盘。

### 6.3 自动获取访客 cookies（开机预热 + 定期刷新）

**背景（2026-10-03 用户反馈"cookies 老是到期、开机就失败、又无法自我修复"）**：原来
`ensureHarvested()` 只在**下单那一刻**被懒调用，于是 ① 服务刚启动、cookies 还没有 → 第一单必然先失败一次；
② 跑着跑着过期了程序不知道 → 等用户去下东西才报错。

**现在的机制**（`src/services/cookieHarvest.ts`）：

| 环节 | 行为 |
| --- | --- |
| 开机预热 | 启动 3 秒后自动抓一次；**HTTP 途径的站点（抖音/TikTok/B站）即使没到期也换新的**（一次请求、1 秒、不招风控）；需浏览器的站点只在过期时抓，不白开 chromium |
| 定期刷新 | 默认每 30 分钟检查；HTTP 途径站点按此间隔换新，浏览器站点按 `COOKIE_HARVEST_TTL_HOURS`（默认 6h） |
| 串行互斥 | **所有**抓取（含下单懒抓）都过同一个串行队列 —— 浏览器 profile 是共享的，并发必撞 `ProcessSingleton` 锁 |
| 开机自检 | 如实打印每个站点的 cookies 条数/年龄/来源；用户上传的 cookies.txt 会做结构+过期检查 |

开关（都有代码内默认值，**不改用户 .env**）：`COOKIE_HARVEST_WARMUP`（默认 1）、
`COOKIE_HARVEST_REFRESH_MIN`（默认 30，0=关闭定时）、`COOKIE_HARVEST_WARMUP_DELAY_MS`（默认 3000）、
`COOKIE_HARVEST_TTL_HOURS`（默认 6）。

> ⚠️ **YouTube 不做自动抓取**：它的 `Sign in to confirm you're not a bot` 是**出口 IP 信誉**触发的，
> 实测无头浏览器抓的 26 条匿名 cookies 喂给 yt-dlp 后**依旧失败** —— 只有「登录态 cookies」或换出口 IP 有用。
> 所以开机日志会直接说明这一点，而不是假装自愈（见 §8.1 第 20 条）。

### 6.4 「下载原始文件」（临时解密 + 6 位轮换密码）

文件页每行除了「下载」（下**加密归档本身**）还有「下载原始文件」：服务端**临时**解密成原样再下载。

| 关注的 | 事实 |
| --- | --- |
| 密码 | 6 位数字，**每 15 分钟自动换一次**；输对后 **15 分钟内不再问**。不是固定值，由 `.env` 的 `ORIGINAL_DL_SECRET` 当种子推出来（`HMAC-SHA256(种子, 15分钟窗口) mod 1e6`）。查看当前密码：`sudo ./deploy.sh --orig-code` |
| 校验失败 | 一律返回 **403**（不是 401！）—— 前端把"非登录接口的 401"当成会话过期会跳回登录页（联调时踩到，已修） |
| 临时文件 | 放在 `state/original-tmp/`。**下载完成立刻删**；中断/无法确认的最多留 **1 小时**（每分钟扫描）；**开机把整个临时目录清空**（断电重启后内存任务全丢，只能靠清目录） |
| 进度 | 解密跑在后台（openssl 子进程），进度看临时文件长到多大；前端悬浮面板 1 秒轮询 |
| 不挡路 | 面板挂在 `AppLayout` 的全局 Context 上 → **切到 BT / 问题反馈 / 设置页都不中断**（用户明确要求） |
| 文件名 | 原始名可能有空格/`#`/`%`/中文/`'()*` → 同时给 `filename=`（ASCII 兜底）与 `filename*=UTF-8''`（RFC 5987 百分号转义，且补转 `'()*`，它们不在 attr-char 里） |
| 同一文件重复点 | 复用已有任务，不重复解密 |

关键文件：`src/services/originalCode.ts`（密码/免问，**不依赖 DB**，命令行也能算）、
`src/services/originalDownload.ts`（任务 + 临时文件生命周期）、`src/routes/original.ts`（HTTP）、
`web/src/context/OriginalDownloadContext.tsx`（全局面板 + 密码弹窗）。

---

## 7. 测试与部署

```bash
npm run test:only      # 后端（改动逻辑必跑）
npm run test:browser   # 真浏览器（改前端必跑）
npm run test:all       # 两个都跑
```

- BT 相关测试：`test/transmission-module.test.mjs`、`test/bt-harvest.test.mjs`、
  `test/bt-select.test.mjs`、`test/bt-evict.test.mjs`、`test/bt-cleanup.test.mjs`
- BT 日志脱敏（全链路）：`test/bt-log-redaction.test.mjs`
- BT 流程安全（审查抓到的真 bug）：`test/bt-safety.test.mjs`
- 队列/磁盘：`test/scheduler-space.test.mjs`、`test/disk-driven-admission.test.mjs`
- 测试脚手架 `test/helpers.mjs`：`setupRuntime()` 会把 `DOWNLOAD_ROOT` 指到临时目录；
  **它的并发默认是 3（不是生产默认）**，要测"不限并发"得显式传 env。

部署到真机后**必须**确认的三件事：

```bash
grep -E '^(BT_DOWNLOAD_DIR|TRANSMISSION_INCOMPLETE_DIR|MAX_CONCURRENT|CONCURRENCY_)' .env
ls -ld /var/lib/transmission/downloads /var/lib/transmission/incomplete
grep -aE 'BT 扫货已启动|BT 超时策略已启动' /ttdownload/state/app.log | tail -2
```

全新机器（尤其是**机器上已经有 transmission-daemon**、脚本因此跳过 `ubuntutr.sh` 的机器）
再补这五条 —— BT / 公开视频最容易"装好了但静默不工作"：

```bash
# ① 四个后台 worker 都起来了吗
grep -aE '流水线已启动|调度器已启动|BT 超时策略已启动|BT 扫货已启动' /ttdownload/state/app.log | tail -4
# ② transmission RPC 真通吗（**带凭据** 409 = 正常；不带凭据 401 也是正常的"要鉴权"，
#    别把 401 误判成故障 —— 2026-09-23 实测确认）
curl -s -u "$(grep -E '^TRANSMISSION_RPC_USER=' .env | cut -d= -f2-):$(grep -E '^TRANSMISSION_RPC_PASSWORD=' .env | cut -d= -f2-)" \
  -o /dev/null -w 'tr rpc http=%{http_code}\n' http://127.0.0.1:9091/transmission/rpc
# ③ transmission 实际用的下载目录 = .env 里的 BT_DOWNLOAD_DIR 吗（不一致就永远扫不到货）
grep -h '"download-dir"' /etc/transmission-daemon/settings.json \
  /var/lib/transmission/.config/transmission-daemon/settings.json 2>/dev/null
# ④ 磁盘：/ttdownload 可用空间必须 > 预留（默认 10G），否则所有任务永远"空间不足"
df -h /ttdownload 2>/dev/null || df -h /
# ⑤ 公开视频的 JS 运行时**真的在 PATH 里**（2026-09-23 血案：部署日志说"✅ 齐全"、实际是断链）
command -v deno && deno --version
yt-dlp -v --simulate --no-warnings https://www.youtube.com/watch?v=jNQXAC9IVRw 2>&1 | grep -i 'jsc\]'
#   期望：JS Challenge Providers: bun (unavailable), deno, node (unavailable), ...
#   若出现 deno (unavailable) → 看 /usr/bin/deno 是不是指向不存在的 /usr/local/bin/deno（断链）
```

**如果 Node 那一步报 `E: Unable to correct problems, you have held broken packages.`**
（老版本脚本的 `nodejs npm` 一起装导致的，见 §8.1 第 12 条），在服务器上按这个顺序恢复：

```bash
# ① 看清楚冲突是谁跟谁
apt-cache policy nodejs npm | head -20
# ② 只装 NodeSource 的 nodejs —— 它**自带 npm**，不要点名 npm
sudo apt-get install -y nodejs
node -v && npm -v          # 期望 v20.x / 10.x
# ③ 若 ② 仍失败：把发行版的 nodejs/npm 让位（NodeSource 自带 npm，不需要发行版那个）
sudo apt-get remove -y npm nodejs
sudo apt-get install -y nodejs
# ④ 拉最新代码重跑（Node 已就绪会被跳过）
cd <项目目录> && sudo ./deploy.sh --update
#    也可以用仓库自带的 Node 升级脚本：sudo bash deploy/scripts/fix-node20.sh
```

---

## 7.5 真机测试（局域网树莓派）—— 改完先在这儿验，再推 main

局域网里有一台树莓派 `mypi@192.168.2.163`（Debian 13 / aarch64 / 4 核 / 20G 可用），
已经部署着本项目，**用它做"真机验证"**（本机 macOS 绿 ≠ 真机绿，这轮就抓出一堆环境差异）。

```bash
ssh mypi@192.168.2.163            # 已配免密（本机 ~/.ssh/id_ed25519 已加入它的 authorized_keys）
cd ~/ttdownload-web

# ① 拿待验证的代码（推荐先推临时分支，别直接动 main）
git fetch origin -q && git checkout -q <分支> && git pull -q origin <分支>

# ② 部署（重建前后端 + 重启 + 健康检查；约 1~2 分钟）
sudo ./deploy.sh --update

# ③ 跑测试：**必须给 TTDL_TEST_ROOT**（树莓派的 /tmp 是 1.9G 的 tmpfs，
#    而磁盘准入用例要摆布 6G 空间；不给就只跑单元、空间类用例会自动跳过）
TTDL_TEST_ROOT=$HOME/.ttdl-test node --test $(ls test/*.test.mjs \
  | grep -vE 'logging-diagnostics|webvideo-module|webvideo-formats')
```

> 排除的那 3 个文件是**真连外网/需要 YouTube CDN** 的用例，在真机上会因网络环境红/卡，
> 属既有情况（本机也这样）。

**推荐流程：临时分支验证 → 通过才推 main**

```bash
git push origin HEAD:refs/heads/pi-verify      # ① 推临时分支（main 不动）
# ② 树莓派上 checkout pi-verify → deploy → 跑测试
git push origin HEAD:main                      # ③ 绿了才推 main
git push origin --delete pi-verify             # ④ 删临时分支
```

**这轮为了"能在真机上跑"修掉的测试环境假设**（都不是产品 bug，但都会让真机一片红）：
`setupRuntime()` 会让测试读到**部署机的生产 `.env`**（→ 全量 401 / bt 目录 EACCES）、
部署测试的假 PATH 里含 `/usr/bin`（真机上有真 aria2c/transmission-daemon/node → "未安装"模拟失效）、
`/tmp` 是 tmpfs、缺 `xxd`、真机装了 chromium 导致"没有浏览器"的前提不成立。

---

## 8. 已知/未完成

### 8.1 本窗口修掉的（都配了会红的回归测试，别再退回去）

一次"部署前代码审查"抓到的**会真出事**的行为，已修 + 有测试锁住：

| # | 原来会怎样 | 修在哪 | 测试 |
| --- | --- | --- | --- |
| 1 | **incomplete（还在下的种子）交出去的文件发布完成后，收尾阶段把 transmission 任务删了、目录也清了** —— 种子还在下，删掉等于把没下完的部分永久干掉 | `btHarvest` 给 incomplete 来源的任务打 `keepTorrent`，③ 只记账不清理 | `bt-safety.test.mjs` 用例 1 |
| 2 | "共用目录只删自己的"把**别的任务正在归档的源文件**删了（BT 下载任务的 `meta.files` 恰好就是那些文件）→ 打包失败/内容丢失 | `btCleanup.otherTasksFilePaths()`：共用目录里别的活跃任务点了名的路径一律不删 | `bt-safety.test.mjs` 用例 2 |
| 3 | incomplete 重复发布：发布任务 completed 后不在 in-flight，找不到下载任务时每个 tick 重发一遍 | `btHarvest.filesAlreadyHandedOff()`：按 `payload.harvest.files` 做文件级账本 | `bt-safety.test.mjs` 用例 1 |
| 4 | 空间回血时 `usable` 在循环里不递减 → 一次性放行所有暂停任务（合计远超可用空间）→ 抖动/撑爆磁盘 | `scheduler.resumeSpacePaused()` 放行一个就扣一个 | `bt-safety.test.mjs` 用例 3 |
| 5 | incomplete 交接前不标 unwanted → 归档搬走后 transmission 重新下载（重复占空间+下次扫货又发一遍） | `btHarvest.markFilesUnwanted()` | `bt-safety.test.mjs` 用例 1 |
| 6 | 同名视频（`CD1/movie.mp4` + `CD2/movie.mp4`）打 zip 直接 `cannot repeat names` 永久失败 → 每 2 分钟重建任务再失败 | `archive.stageForZip()`：只在真重名时硬链接暂存 + 改名 `_2` | `bt-safety.test.mjs` 用例 4 |
| 7 | 种子记录永远停在 `downloading`（`'done'` 从没被写过）→ 界面永远"下载中"、按钮永久禁用 | `btHarvest` ③ 收尾时 `seedsRepo.update(seedId,{status:'done'})` | 随用例 1 |
| 8 | `harvestDone` 无条件置位 → 清理被跳过/失败时目录永久残留且不再重试 | 只有目录真的没了才置位；目录还被别的任务占用时整块推迟 | 随用例 1 |
| 9 | BT 日志里仍有多处会带出种子名/内容名（zip 的 argv、扫货日志、`removed` 列表、space-freed 的 detail、任务失败消息…） | 见 §6.1；`bt-log-redaction.test.mjs` 6 个阶段全链路锁住 | `bt-log-redaction.test.mjs` |
| 10 | 全新机器上 transmission 的两个目录可能根本不存在（只有 `--update` 或 `ubuntutr.sh` 才建）→ BT 下完了永远扫不到货，界面看不出原因 | `deploy.sh` 新增 `ensure_transmission_dirs()`，首部署也执行，并核对 transmission 实际 `download-dir` 与 `.env` 是否一致 | 手工（见 §7 三条确认） |
| 11 | 首次部署若 NodeSource 失败，发行版 `nodejs` 包**不带 npm** → 走到 `die 缺少必要命令: npm`；以及 root 建目录 + sudo 部署时 `npm ci` 写不进去 | `deploy.sh` 装 `nodejs npm`、补 npm 自愈；`REPO_OWNER` 加可写性判断 | `deploy-script.test.mjs` |
| 12 | **全新 Ubuntu 上部署直接卡死在 Node 这一步**：`apt-get install -y nodejs npm` → `E: Unable to correct problems, you have held broken packages.`（第 11 条那次"顺手补 npm"引入的回归 —— NodeSource 的 nodejs 自带 npm 且与发行版 npm 互斥） | `deploy.sh` 抽出 `ensure_node()`：NodeSource 那步**只装 nodejs**；真要回退发行版仓库时**先摘掉 NodeSource 的源**再 `nodejs npm` 一起装。`deploy/scripts/fix-node20.sh` 同一处隐患一并修掉 | `deploy-script.test.mjs` 两条【血案回归】（假 apt 复现冲突：写回错误版本会 2 项报红） |

| 13 | **前端两段式路由会白屏**：index.html 用相对资源路径（Vite `base: './'`，为兼容子路径部署），像 `/tasks/waiting` 这种两段式 URL 会把 `./assets/*.js` 解析成 `/tasks/assets/*.js` → SPA 回退返回 index.html → "Expected a JavaScript module but got text/html" → **直接刷新/收藏该页就是白屏**（只有两段以上路径会中招） | 路由一律**单段**（`/tasks-waiting`、`/tasks-publish`、`/tasks-other`、`/network`），并同步登记进 `web/src/lib/basePath.ts` 的 `APP_ROUTES` | `test/basepath.test.mjs` 的守卫用例（断言所有前端路由单段 + 必须登记）+ 浏览器用例硬打开新页 |
| 14 | 任务页把「种子下载任务」和「扫货归档发布子任务」混在一起数/排（14 个种子显示成 23 个任务、总量虚高、侧边栏与页面数字不一致） | 统计口径全部拆分（`db.ts` 的 `summary`/`computeStats` + `/api/tasks?kind=`），界面按口径分开展示；任务区拆成一级页 + 三个独立列表页 | `test/task-count.test.mjs` + 浏览器用例 |
| 15 | 任务一旦报「无法读取种子信息」就永久失败。这句话的真实含义是 **transmission 里查不到这个 torrent id**（被 8h 超时/扫货策略清掉、手动删除、或 transmission 重装过），不是"本地 .torrent 被删"；但旧逻辑下任务里留着过期的 `torrentId`，只会一遍遍撞同一堵墙 | `prepare()`（`src/modules/transmission.ts`）**只对这种「transmission 无此种子」**做自愈：丢掉过期 `torrentId`、记 `reAddedAt`，用 `btQueued` 里留档的 `.torrent` 重新 `torrent-add`（路径回落 seeds 表）；**其它 RPC 错误原样抛出**，绝不把真实故障伪装成"种子文件不存在" | `test/bt-readd.test.mjs`（`bt-log-redaction` 阶段 5 锁住"错误原文不被替换"） |
| 16 | 用户看到「网页显示还有 7.08G 可用，却有个 1.6G 的任务在排队」，以为判定写错了 | 网页顶栏显示的是 `usableBytes`（系统可用 − 保留），而调度器放行时还要再减掉**正在下载任务已按 `expectBytes` 预扣的空间**。真机实测：系统可用 18.34G − 保留 10G − 运行中预扣 5.72G = **1.36G < 任务需要的 1.44G** → 判定是对的，是账没显示全。`/api/system` 本就返回 `admittableBytes`，改为顶栏直接显示它、tooltip 摊开三笔账；等空间的任务原因也从一句「磁盘空间不足，等待中」改成带完整算式 | `test/transmission-module.test.mjs`（等空间那一步断言原因里有完整算式；顺手把该用例改成「可用量由测试钉死」以便在真机上也确定性通过） |
| 17 | **线上**：页面显示「可用于下载 5.28G」，却有一个 1.6G 的任务在排队（用户："这么个简单的算法怎么老是改不明白"） | 两个真 bug：① 调度器按 `expectBytes` **全额预扣一整场下载** —— 一个下到 91% 的任务仍占着整整 2.48G，实际只差 0.17G，跑着的 6 个任务虚占 5.72G（真实只需要 2.57G）；② `/api/system` 读的是 `expect_bytes`，而 `tasksRepo` 返回驼峰 `expectBytes` → `reservedBytes` **恒为 0**，接口把"可用于下载"直接当成"还能再放行"，**用户看到的数和判定用的数不是一回事** | 新增 `src/core/space.ts`：`remainingBytesOf()` = `max(expectBytes, totalBytes) − downloadedBytes`（只算还差多少，总量取传输器报的真实值），`reservedByRunningTasks()` 供**调度器与接口共用**；调度器第 2 道闸门改为用**当下**的 free/reserved 重算并排除任务自己；等待原因与前端文案统一为「**可立即开始** = 可用于下载 − 运行中任务还差」 | `test/disk-gate-reservation.test.mjs`(3 条，含"接口预扣不得恒为 0") + `test/transmission-module.test.mjs` 第 9 条 （91% 的任务不许挡住新任务；旧逻辑下必红） |
| 18 | **线上**：`df` 明明有空闲，任务却全停在「磁盘空间不足，已自动暂停」；且出现 100% 进度仍「下载中」、目录永远删不掉、`freedBytes:0` 的死循环 | ① `resumeSpacePaused()` 和 `tick()` 里各有一份**漏改**的「按 `expectBytes` 全额预扣」——6 个运行中任务虚占 6.21G（真实只差 3.38G），把可用 6.75G 挤成 0.54G，所以永远恢复不了；② 两个种子落进同一目录时，A 100% 收尾被"仍下载中"的 B 挡住删不了目录，`alreadyHarvesting()` 又因 A 的 `harvestDone=false` 挡住 B 被扫货 → 互锁死循环 | ① `resumeSpacePaused`/`tick` 改用共享的 `reservedByRunningTasks()`（只算还差多少）；② `btHarvest` 收尾时区分"删失败"与"被其它种子共用、安全起见没删"：后者直接置 `harvestDone=true`（剩余由对方清理），不再无限重试 | `test/transmission-module.test.mjs` 第 10 条（空间恢复应自动继续，旧口径下必红） |
| 18 | **网页上的「修复脚本」通道风险过高**：任何能打开该页面的人都能上传 `.sh`，并以服务身份（root）在这台机器上执行任意命令（早期设计靠"默认关闭 + 维护令牌 + 上传前预览"兜底，但开关一旦打开就等于把 root shell 挂到 Web 上） | **整体移除**（业主决策）：删 `src/services/scriptRunner.ts`、`/api/scripts` 与 `/api/system/scripts*` 全部端点、`scriptUploadEnabled`/`scriptRunTimeoutSec` 设置与 env、`[MARK:SCRIPT_UPLOAD]`/`[MARK:SCRIPT_RUN]` 标记、前端页面与侧边栏入口；环境问题改为 SSH 执行 `deploy/scripts/*.sh`。**DB 未做破坏性迁移**（settings 表里遗留的旧键被忽略） | 新增 `test/no-script-module.test.mjs`（端点 404 + 设置/config 无 `script*` 字段；删除前 4/4 红） |

| 19 | **全新机器部署后 YouTube 永远下不了**，而部署日志还打印"✅ YouTube 下载依赖齐全"：`deploy.sh` 把 deno 安装写成了 `DENO_INSTALL=/usr/local curl … \| sh -s -- -y` —— 变量只作用于**管道左边的 curl**，右边的 `sh` 收不到 → deno 装进 `$HOME/.deno`（sudo 下 `/root/.deno`），`ln -sf /usr/local/bin/deno` 只造出**断链**；yt-dlp 因此打出 `deno (unavailable)`。同时"如实汇报"那行用 `{ deno…; } \|\| … \|\| { node -v; }` 回落链，deno 断了就落到 node 20 打成非空 → 谎报"齐全"（而 `js_runtime_available()` 要求 node>=22） | `deploy.sh`：① 改写为 `curl … \| DENO_INSTALL="$DENO_DIR" sh -s -- -y`，并且**装完必须 `js_runtime_available` 才算成功**（可覆盖的 `DENO_INSTALL_DIR`/`DENO_LINK_DIR`）；② 新增 `js_runtime_version()`，「判定」与「打印」共用 `js_runtime_available` 口径。同类点一并修：`deploy/scripts/fix-ytdlp.sh` 装完也验证可执行、`使用教程.md` 里那条手工命令就是错写法 | `test/deploy-script.test.mjs` 新增 5 条（假 curl 模拟官方安装器只认 sh 侧变量、装完不可执行不许报成功、node<22 不算运行时、报告必须走 `js_runtime_available`、全仓库禁 `DENO_INSTALL=… curl`）。**未修复代码上 4 条必红**（已实测） |

| 20 | **自动获取的 cookies 只在"下单那一刻"才懒抓** → ① 服务刚启动、cookies 还没有时，用户下的第一单必然先失败一次；② 跑着跑着 cookie 过期了程序不知道，等用户去下东西才报错，且"开机就失败、又不会自愈"，体验极差（用户原话）。此外浏览器用的是**同一个持久化 profile**，跨站点并发抓取会撞 `ProcessSingleton` 锁 | `src/services/cookieHarvest.ts` 新增：① `startCookieKeepFreshWorker()` —— 开机预热（3 秒后）+ 定期刷新（默认 30 分钟）；② HTTP 途径的站点（抖音/TikTok/B站）**开机强制换新**、浏览器站点按 TTL 换新（不白开 chromium）；③ 把串行互斥**放进 `ensureHarvested()` 内部**，让「定时刷新」和「下单懒抓」两条入口共用同一个队列；④ `cookieBootReport()` 开机如实打印各站点 cookies 条数/年龄/来源；⑤ `server.ts` 增加用户上传 cookies 的**结构+过期自检**。YouTube 明确**不做**自动抓取（见 §6.3 的实测结论） | `test/cookie-harvest.test.mjs` 新增 7 条（开关默认/非法值回落、刷新口径按途径分档、开机强制换新、串行互斥（两条入口并发）、worker 自动预热且幂等、关闭时不动手）。**拆掉互斥 → 串行用例必红；忽略 forceCheap → 两条预热用例必红**（已实测） |

| 21 | 「已入队种子」列表只能一个个删，不能全选批量删（用户要求补上）；「危险操作要多步确认」的弹窗原本只写在文件页里，第二处要用就得复制一份 | 抽出共用组件 `web/src/components/ui/DangerConfirmModal.tsx`（①核对范围 → ②确认影响 → ③输入确认词才启用最终按钮），文件页改用它（文案不变），`BtQueuedPage` 新增勾选列 + 全选当前页 + 全部删除。批量删复用既有 `POST /api/bt/seeds/actions`（**本来就支持数组**且逐条回报，后端未改）。⚠️ 同时纠正该页**与事实不符的文案**：入队时 `.torrent` 已被 `moveSeedToQueued()` **移动**到 `btzhongzi_yijingdownding/` 并更新了 `seeds.path`，而 delete 只在路径仍属**待入队目录**时才 `rm` —— 所以这个页面上删除**实际只删数据库记录**（留档 .torrent 还在、不释放空间、不动 transmission 任务），旧文案说反了 | `test/api.test.mjs` 新增 2 条（批量删多条 + 逐条回报 + 不存在的 id 不影响其它；空 ids 必须 400。打断"空 ids 必须 400"→ 用例变红，已实测）；`test/browser.smoke.mjs` 新增 1 条（全选→三步确认→输入确认词才可点，并断言第二步如实写"不会删留档 .torrent"） |
| 22 | **鉴权用例 1/16 概率假红**（预先存在，与功能改动无关）：`cookie.replace(/.$/, 'x')` 想篡改会话，但签名是 base64url，末位只承载 4 个有效比特、索引必为 4 的倍数，而 base64 解码**丢弃末位那 2 个填充比特** —— 末位原本是 `w`(48) 时改成 `x`(49) 解码出来是**同一个字节**，签名照旧通过 → 随机变红，把人骗去看鉴权代码 | 改成篡改**参与 HMAC 的 payload 段**（必然对不上签名）+ 再单独篡改**签名中段**（避开末位填充比特），两条都断言 401 | `test/auth.test.mjs`。根因一行可证：`Buffer.from('w','base64').equals(Buffer.from('x','base64')) === true`。**修复前实测 40 次红 2 次、60 次红 2 次；修复后连跑 60 次全绿** |

| 23 | **文件页只能下"加密归档"本身**，想直接拿原始视频只能绕道手机端的解密 App；而临时解密出来的文件如果不管，会一直占着磁盘；几 GB 的解密又要几十秒到几分钟，做成同步请求会把页面卡住 | 新增「下载原始文件」：`src/services/originalCode.ts`（6 位轮换密码：种子存 `.env`，15 分钟窗口，输对后 15 分钟免问）、`src/services/originalDownload.ts`（后台解密任务 + 进度 + 临时目录，**下载完立刻删 / 超 1 小时删 / 开机清空**）、`src/routes/original.ts`（`/api/original/*`；失败一律 **403**，避免被前端的"401=会话过期"逻辑踢回登录页）、前端全局 `OriginalDownloadContext`（悬浮面板，**切页不中断**）+ 密码弹窗 + 行内按钮。deploy.sh 生成/补齐 `ORIGINAL_DL_SECRET` 并提供 `--orig-code` | `test/api.test.mjs` 新增 5 条（未解锁 403、错误密码 403、密码窗口语义、端到端字节一致 + `filename*` 转义 + **下载完临时文件立刻消失**、1 小时超时与开机清空两条兜底、重复点复用任务）。**打断"下载完立刻删"→ 红；打断文件名转义 → 红**（已实测）。`test/browser.smoke.mjs` 新增 1 条（要密码 → 输错有报错 → 输对后**切到 BT 页进度面板仍在**） |

| 24 | **抖音任务偶发失败**（报「需要新鲜 cookies」），而且**解析成功的那条反而失败**、解析失败的却下成功了；旧逻辑还会白抓 cookies、把整条 10 档跑完、最后让人去"传 cookies.txt" | 真机排查（2026-10-03）：同一条链接、**同一份 cookies** 连打 10 次**成功 9 次** → 这个报错是抖音接口**间歇性抽风**（~10%），跟 cookies 无关，重试就好；另外 07:34~07:5x 有过一段"全部被拒"的临时限流窗口（约 20 分钟后自愈）。⚠️ **别把它归因成"境外机房 IP"**：抖音看到的出口是**湖南联通家宽**（`myip.ipip.net`/`ip.3322.net` 可验证），只有海外站（如 ipinfo.io）才走伦敦代理，OpenWrt 分流是对的。修：① 遇此错**先用同一份 cookies 原地重试**（2 次）② 仍连续失败才重抓 cookies ③ 累计失败 5 次才早停（不是跑完 10 档 ×3 次）④ 手动「重试」重置自动重试预算（否则被限流用光预算后点重试只会跑一次就永久失败）⑤ 错误文案改为"出口 IP 疑似被临时限流 + 已延后 10 分钟重试 + 别连打" ⑥ 没装 curl_cffi 时不再排「模拟浏览器指纹」那一档，并把它原本被误译成"视频不可访问"的报错翻译成真原因 | `test/webvideo-module.test.mjs`：间歇性抽风（前 1 次失败后恢复 → 必须成功、不得重抓 cookies、不得换方式）、换过 cookies 仍被拒时的早停与结论。**去掉原地重试 → 红**（已实测）。真机复验：两条失败任务重试后均 100% 完成 |

| 25 | **抖音任务反复失败**，而且"等 10 分钟再试"也不管用；用户质问「线上产品会叫用户等 10 分钟吗」 | 真因是**我们自己把出口 IP 捶到被风控**：并发设置是 `maxConcurrent=0/moduleConcurrency=0`（不限），一次入队 5 条抖音 → 5 条任务同时各跑一条 10 档阶梯 → 日志实测 **一分钟 26~31 次 yt-dlp 请求**打向同一 IP。掐表实测成功率随时间窗口起伏（刚抓完 0/3 → +131s 3/3 → +324s 0/3），**不是 cookies 过期**（4 种 cookie 组合全 0/4），被限后需静默约 2 分钟。修：新 `src/services/siteGate.ts` **同站点启动闸门**（同站点启动排队 + 相邻 ≥20s，`YTDLP_SITE_GAP_MS` 可调，其它站点 0 直通；只限启动间隔、不限并行下载）+ 「需要新鲜 cookies」改**分级退避** 15s/30s 重试 + 早停改「累计被拒 6 次」（温和试 ~2 分钟覆盖限流窗口，之后才走延后重试兜底，用户全程不用管）+ 节流等待写进日志（`SITE_GATE`） | `test/site-gate.test.mjs` 5 条：间隔 0 直通、相邻启动必须拉开、**并发 5 次申请必须被排队拉开**（真机血案场景）、只有风控严格的平台才节流、间隔可用环境变量调。**把闸门改成直接放行 → 2 条红**（已实测）。测试环境须把间隔置 0（`test/helpers.mjs`）。真机复验：一次性重试全部失败任务 → **3 分钟内全自动完成，22 条任务 0 失败**，请求量降到 3~11 次/分 |

| 26 | **BT 任务只下了几个小时，断电重启后页面显示"已下载 140 多小时"，随后被超时策略拉走**（用户报的真机 bug） | 根因：判定用的是**墙上时钟差值** `Date.now() - Date.parse(payload.btHandedAt)` —— ① 断电/关机那几天也被算成"在下载"；② 树莓派**没有 RTC**，重启后等 NTP 校时期间 `Date.now()` 可能差几天，一校准就跳变（反向还会算出负数）。修：新增 `src/core/clock.ts`（墙上时钟 vs 单调时钟分开用），BT 时长改成 `payload.btActiveMs` —— 每次巡检用 `process.hrtime`（单调时钟）取增量累加，**进程重启后的停机时间不补**；老任务（只有 btHandedAt）在 `migrateLegacyActiveMs()` 里一次性迁移：墙上差值 ≤ 策略窗口（12+6h）就照抄，超过窗口的**不再拿去清理**而是重置计时起点（保守：宁可晚清理也不误删）；页面/日志文案标注"只统计服务实际运行时间" | `test/bt-timing.test.mjs` 6 条（断电 140h 不虚增不被清理、时钟前跳 6 天判定不变、时钟回拨不出负数、单调累计恰好 1 小时、真下满 12h 仍照清、迁移规则）。**把这些用例跑在修复前的代码上必红**（旧逻辑 140h → 直接清理）。`test/bt-evict.test.mjs` 改为按 `btActiveMs` 构造 |
| 27 | **用户要"自动更新项目"**：开机必须拉最新代码（拉不到就用本地老代码启动）、运行期定时检查、升级不能影响正在下载的任务（可暂停，升完恢复）、页面上要有按钮；并且**版本号要按行业标准 Vx.x.x 规范化** | 新增：`docs/VERSIONING.md`（SemVer 规范：MAJOR=不兼容/MINOR=新功能/PATCH=修 bug，版本唯一来源 = `package.json`，`config.version` 直接读它 —— 删掉了原来写在 config.ts 里的第二份 `'1.0.0'`）；`src/core/version.ts`（解析/比较/读包版本）；`src/services/updater.ts`（开机延迟检查 + 失败重试 + 定时检查 + 只在远端版本更高时自动升级 + 升级前暂停 transmission/aria2 下载 + 失败/回滚 + 恢复计划）；`deploy/scripts/self-update.sh`（git fetch/reset → npm ci → 构建后端+前端 → 重启 → 健康检查 → **任何一步失败自动回滚到旧 commit 并重建**；用 `systemd-run` 跑在服务 cgroup 之外，否则 `systemctl restart` 会把正在构建的脚本自己杀掉）；`src/routes/update.ts`（status/check/apply/log/settings）；前端新增「更新」页（`/update`）+ 侧边栏入口。**关键约束：更新检查永远在 `server.listen()` 成功之后才启动 —— 拉不到网/远端挂了也必须能用本地代码起来** | `test/updater.test.mjs` 16 条：SemVer 三位规范（`1.2`/`1` 必须非法）、比较规则、`config.version` 必须等于 package.json、**拉取失败不抛异常且 HTTP 服务照常可用**、版本号没抬不自动升、非 git 仓库如实报错、升级前 `torrent-stop` 且**数据库状态保持 downloading**（回滚到老代码也能自愈）、无计划时不乱 start 种子。全套 316 条后端用例通过 |

| 28 | 用户要求「任务各个列表里也要有全选操作：全选删除、全选启动、全选暂停、全选恢复…」 | 后端：`GET /api/tasks/ids`（按**当前筛选条件**取全部 id，不受每页 20 条限制）+ `POST /api/tasks/actions`（批量，逐条执行、逐条回报；某条状态不允许只影响它自己并带出原因）。⚠️ 批量删除前先 `cancelTask` 再删记录 —— 直接删记录会在 transmission/aria2 里留下**没人管的孤儿下载**（页面看不见却一直占带宽）。前端：新增 `hooks/useTaskSelection.ts`（勾选/全选当前页/跨页全选/清空 + 结果摘要文案）与 `components/task/TaskBulkBar.tsx`（全选 + 已选 N 个 + 全部暂停/恢复/重试/取消/删除）；`TaskCard` 加 `selectable/selected/onToggleSelect`；任务页（/tasks、/tasks-waiting、/tasks-publish、/tasks-other 四个视图共用）、历史页、URL 直链页都接上了，卡片视图还支持**按区块全选**（比如「失败/已取消」那一档一键全选再重试）；删除走三步确认（`DangerConfirmModal`），其余动作可直接执行 | `test/task-bulk.test.mjs` 7 条：跨页全选 id 完整性（分页只有 20 条时也要拿全）、批量暂停/恢复/重试的状态流转、**状态不允许的逐条跳过并说明原因**、批量删除前必须取消（断言 transmission mock 收到了删除）、空 ids/未知动作 400、不存在的 id 只报它自己失败。`test/browser.smoke.mjs` 新增 1 条真机用例（勾选 → 已选计数 → 全部暂停 → 有结果提示）；全量 323 条后端用例通过 |

| 29 | **自动升级在真机上起不来**（用户点「更新」失败）：日志 `repo=/ ref=<远端默认>` → `git fetch` 报 not a git repository，而且**每 30 秒重复一次** | 两个根因：① 脚本为了防"git reset 换掉正在跑的脚本"会把自己复制到 /tmp 再执行，而仓库路径默认值是 `dirname($0)/../..` —— re-exec 后 `$0` 在 /tmp，`../..` 就是 `/`；同时 `systemd-run` 把命令后的 `--repo/--ref` 当自己的参数吃了（脚本收到 0 个参数）。修：**re-exec 之前**解析仓库路径并用 env 传下去、程序调用时也同时用 env 传参、`systemd-run` 前加 `--`、脚本打印 argv 与配置来源；脚本解析出的路径不存在要直接报错退出（不许拿坏路径去跑 git/npm）。② 升级失败后**每次开机都重试** → 升级→退出→systemd 重启→又发现新版本→又升级，每 30 秒一轮死循环，日志刷爆、下载被反复暂停。修：新增 `state/update-attempt.json` + `UPDATE_RETRY_COOLDOWN_MIN`（默认 30 分钟）冷却，同目标失败后不再自动重试（手动点按钮/手动命令不受限）。另：更新页新增「手动更新命令」卡片（**一键复制** `cd ~/ttdownload-web && sudo ./deploy.sh --update`，并显示服务器实际目录，避免 `~` 有歧义） | `test/self-update-script.test.mjs` 8 条：**0 参数也要解析出正确仓库路径（不能是 /）**、env 传参生效、命令行优先于 env、坏路径必须报错、systemd-run 命令带 `--` 且两份参数都在、冷却命中/过期/换目标/版本已变的判断、状态含手动命令。**把老脚本(HEAD)放回假仓库跑 0 参数 → 仓库路径变 /var/...**（已实测，用例会红）。`test/browser.smoke.mjs` 新增 1 条真机用例：更新页显示命令 → 点「复制命令」→ 剪贴板内容与显示一致 |

| 30 | 用户报：**URL 直链多个任务里有几个莫名其妙失败**（`下载失败：SSL/TLS handshake failure: The TLS connection was non-properly terminated.`），而他**手动 `mkdir tmp1 && cd tmp1 && screen -R tmp1 && aria2c -i url`（url 文件里放地址）从来没出过问题、再多文件也互不影响**；另外**所有直链任务都叫 "download"**，分不清谁是谁 | ① 并发：我们拉起 aria2c 时写死 `--split=16 --max-connection-per-server=16`，16 条并发 TLS 到同一台 CDN，服务器直接掐多余连接 —— 这正是"手动（aria2 默认：同服务器 1 条连接、同时 5 个）一遍就成、程序里偶发失败"的原因。修：默认对齐用户手动那套（`split=5`、`max-connection-per-server=1`、`max-concurrent=16`，全部可用 .env 调），补 `--max-tries=5 --retry-wait=3`；poll 认出"连接类"错误时**自动退到单连接重试一次**（`split=1/max-connection-per-server=1`）。② 互不影响：以前所有任务下到**同一个目录**，而 `.../download?id=x` 这类链接在服务器上很可能同名 → 两个任务同时写同一个文件，续传还会串味（"其中两个莫名其妙报错"的另一个真因）。修：`taskDownloadDir()` **每个任务一个专属目录**（`<id>-<slug>`，用户手动就是 mkdir 专目录），目录记进 payload，重试/续传复用同一个目录不白下。③ 标题：用户原话"绝对不能所有的 Url 直链下载任务都叫 download，download1，download2…downloadn 这样也能接受" → `titleForNewTask()`：像文件名就用文件名（重名加序号 `movie2.mp4`），不像就**一律编号 `download1/download2/…`**（跨批次也不重名）；aria2 解析出真实文件名后仍会刷成真名（只改"不像文件名"的占位标题）。④ 顺带：一次提交上限 200 → 2000，去重从"每个 URL 查一次库"改成一次性把队列拉全（几百个 URL 不再是几百次全表扫描） | `test/aria2-module.test.mjs` 新增 8 条：`/download?id=x` 四个任务必须是 `download1..download4` 且互不相同、像文件名的照旧/重名加序号、连接类失败 → 必须重建任务且 `split=1`、404 不许被"单连接重试"掩盖、真名解析后标题更新、每任务独立目录且重试复用、默认 per-server=1、250 个 URL 一次能提交、**接口层 5 个同形直链标题必须 download1..5 且跨批次不重名**。`test/browser.smoke.mjs` 全绿（只剩 2 条改动前就红的旧用例） |
| 31 | 用户升级后惊问「BT 下载是不是被改了？全部 0 进度！」，几分钟后进度自己慢慢涨回来 | 真因不是数据被删，而是**服务重启后 transmission 在重新校验已下载数据**（`status=1/2`），这期间 `percentDone` 会先掉到很低再涨回来。修：`transmission.poll()` 在等待校验/校验中时带出 `hint`（"正在校验已下载的数据……数据没丢"），`applyProgress` 把它写进任务消息、提示消失后自动清掉（只清我们自己写的提示，绝不动调度器的准入/限流说明）；前端 TaskCard 也改成**不是终态就显示「提示：」**（以前一律显示"失败原因：…"，于是"失败原因：transmission 正在校验已下载的数据"看着自相矛盾） | `test/transmission-module.test.mjs` 新增 1 条：status=2/1 必须带校验提示、status=4（正在下载）绝不能带 —— **状态码写错（把 4 当校验中）这条必红**（transmission 里 4 = 正在下载，1/2 才是校验） |
| 32 | 用户要求：文件页「全选」后**除了「全部删除」还要有「全部下载」和「全部下载原始文件」**；而且"一个一个点这两个选项，连续点到第 5~6 个就必须等前面的下完"，要求**把限制去掉** | 那个"5~6 个就得等"是**浏览器**对"同一站点同时下载数"的限制（Chrome 约 6 条连接），服务端加多少并发都绕不过去；唯一有效的办法是**打成包、一条连接**。于是：① 新增 `src/utils/tar.ts`（极简 **流式 ustar** 打包：不落盘、不压缩 —— 这些成品本来就是加密数据、压不动，而 zip 必须先写临时文件、下 50G 就要再占 50G）；② `GET /api/files/bulk-download?ids=` 把选中的成品流式打成 `ttdownload-<时间>.tar`（带 Content-Length、跳过磁盘上已不存在的、照样记 webDownloads）；③ 「全部下载原始文件」= `POST /api/original/bulk`（**一次把 N 个文件丢进解密队列，并行解密**，不是一个个来）+ `GET /api/original/bulk/download?jobs=`（全部就绪后打成一个 tar）；④ 前端 `OriginalDownloadContext` 增加批量流程：批量任务**不逐个**触发浏览器下载，整批就绪后只发一次 tar 请求；密码框文案也支持"这批 N 个" | `test/bulk-download.test.mjs` 5 条：**用系统 `tar` 验证响应是合法 tar**（列条目 + `-xOf` 校验字节一致）、Content-Length 与实际一致、已删文件自动跳过并如实报 `X-Bulk-Skipped`、全都不可用要 404、空 ids 要 400、**三个解密任务必须同时在跑**（并行，不是排队）、未就绪时明确报错、打包不落临时文件。`test/browser.smoke.mjs` 新增 1 条（文件页全选后三个按钮都在、勾选后「全部下载」可用）。实测：浏览器冒烟 33 条里只剩 2 条改动前就红的旧用例 |
| 33 | 用户：100G 空间跑着跑着只剩 50G，断电重启后留下很多垃圾临时文件，不想 ssh 一个个找 → 要"扫描 + 一键清理垃圾" | 新增 `src/services/junkScan.ts` + `GET /api/junk` + `POST /api/junk/clean` + 前端「垃圾清理」页（侧边栏入口 `/cleanup`）。分类：① aria2 残留（`.aria2` 控制文件 + 配套未下完文件，用 aria2 实时 gid 集合排除"还活着"的）② yt-dlp 分片（`.part/.ytdl/.tmp/.f*`，>6h 未更新）③ 解密临时（original-tmp，>1h）④ 加密临时（encryptTmp，>6h）⑤ 打包暂存（state/zipstage_*，>1h）⑥ 归档临时 zip（.tmp_*.zip，>1h）⑦ **疑似孤儿成品**（consumer/archiveReady 里 DB 没记录的文件）—— **只报告、不自动删**（可能是崩溃时没入账的合法成品）。**安全铁律**：只读扫描、白名单删除（每个文件删除前 `realpath` 校验在 DOWNLOAD_ROOT/state/transmission 目录内，不跟符号链接）、拿不到 aria2 实时集合时 aria2 目录**整体跳过**（宁可少清不误删）、删除前按 mtime 阈值避开正在写的文件。页面还给出「各目录占用」让用户看清那几十 G 去哪了 | `test/junk-scan.test.mjs` 4 条：能扫出 6 类垃圾、正在下载/刚写完的文件不进垃圾、孤儿成品只报告不自动删（手动选它也不会被删）、只删勾选类别且白名单外/符号链接一律不删。`test/browser.smoke.mjs` 新增 1 条（垃圾清理页能扫描并列出各目录占用） |
| 34 | 用户：把「文件」「任务」都清空了，`downd_aria2_path` 还占 30G；里面有下好的 mp4 却没出现在「文件」里 | 真因：aria2 的完成只靠 poll 的 done 触发 `handoffToArchive`，一旦①下完瞬间断电/重启②用户删了任务③aria2 重启 gid 对不上，文件就成了谁都不管的孤儿。修：新增 `src/services/aria2Harvest.ts` 定期收割（60s 一次 + 开机一次）——扫描下载区，凡是"已完成（无 .aria2 控制文件）+ 不在 aria2 实时任务 + 不在任何 DB 任务/成品记录 + mtime>5min"的文件，用 `createPublishTask` **重新送进归档流水线**（→ 加密 → 消费者 → 「文件」）。安全：aria2 RPC 不可用就整体跳过（宁可少收不误收）。另外垃圾扫描新增**文件清单**（只读），把关键目录里的文件名列出来（含大小/时间），用户一眼看清 30G 里都是啥 | `test/aria2-harvest.test.mjs` 5 条：孤儿文件被送进归档、有 .aria2 的（还在下）和实时任务里的不送、刚下完的（<5min）不抢收、RPC 不可用整体跳过、走完流水线后消费者目录多了条成品记录（标题=原文件名）。`test/junk-scan.test.mjs` 补 1 条（文件清单要能看到具体文件名）。`test/browser.smoke.mjs` 垃圾清理页用例补「文件清单」断言 |
| 35 | 用户问：归档加密是不是并发？20 多个 G 全在"加密中"半天完不了；断电了怎么办、垃圾会不会清、断电前没加密完的任务能不能恢复 | ① **加密本来就是串行**（pipeline 里逐个 `await encryptFile`，一个文件一个文件来），"全部加密中"是因为收割器一口气把 20 个孤儿任务全塞进了 `encrypting` 状态（其实是排队，UI 看着像并发）。修：`aria2Harvest` 加**节流**——流水线里 archiving/encrypting 积压 ≥3 就先别灌（队列始终小数字）。② **断电恢复（老写法有真 bug）**：原来加密前先把源文件 `move` 进 encryptTmp 再原地加密，中途断电 → 源不在 archiveReady → 重启任务报"归档文件不存在"→ 失败 + 明文卡在 encryptTmp 成垃圾、数据救不回。修：**源留在 archiveReady 不动**，加密输出先写 `.enc.*.part`，成功才删源、才搬去 consumer；断电后源还在 → 重启重新加密即可，**不丢数据**。③ 垃圾：开机 `cleanupStaleEncryptParts()` 清掉断电残留的 `.enc.*.part`（源在 archiveReady 可重来，纯属垃圾）；垃圾扫描的加密临时类把 `.enc.*.part` 视为**随时可删**（不看 6h 阈值），其它老残留仍按 >6h | `test/encrypt-recovery.test.mjs` 3 条：断电后源还在 archiveReady、任务能从源头重新加密完成（不丢数据）、加密成功才删源且不留 .part、**多任务串行**、收割器积压 ≥3 时不再灌。这些用例在旧写法（先 move 源）下必红 |
| 37 | 新增「在线播放器」：播放已下载/已加密归档的视频；加密视频要先解密，解出来是 zip 要再解压，不是 mp4 封装要用 ffmpeg 转封装成 mp4，且 mp4 的 moov 封装头要在文件前（faststart）才能边下边播。同时要求以后归档前就把非 mp4 转成 mp4 | `src/services/media.ts`：`isZipFile` / `pickVideoFile`（取最大视频）/ `isMp4Faststart`（解析顶层 box，moov 在 mdat 前才算）/ `remuxToMp4`（ffmpeg `-c copy -movflags +faststart`，失败退化音频转 AAC）/ `normalizeVideosForArchive`（归档前统一转 mp4，失败也绝不阻断归档）。`src/services/player.ts`：后台任务 解密(openssl) → 砍 VLT 尾 → zip 解压挑视频 → 非 faststart 就重封装 → 就绪；临时目录 state/play-tmp，2 小时 TTL + 开机清理。路由：`POST /api/files/:id/play`、`GET /api/files/play/status/:jobId`、`GET /api/files/play/stream/:jobId`（支持 HTTP Range，`<video>` 可拖进度条）。前端：文件页每行「播放」按钮 + 播放器弹窗（轮询 解密/解压/重封装 进度，就绪自动播放）。`pipeline.ts` 归档前调用 `normalizeVideosForArchive` | `test/player.test.mjs` 7 条：moov 在后→调 ffmpeg 重封装；moov 在前→不白跑 ffmpeg；zip→解压挑最大的视频；非视频→明确失败不瞎调 ffmpeg；pickVideoFile 取最大；播放流 Range 206+Content-Range；归档前 normalize 只转需要转的。测试用假 ffmpeg 脚本（复制输入到输出）确定性验证 |
| 38 | 用户要求：播放器解密 / 「下载原始文件」解密产生的**还原文件**统一放一个【还原文件目录】；每个文件从还原成功起单独活 4 小时；设置页顶部加「手动清理垃圾」按钮，一键清空还原文件目录（不管到期没）+ 顺带清其它临时垃圾 | 新增 `src/services/restored.ts` + `restored_files` 表（db.ts）：目录 `state/restored`，`registerRestored()` 登记（ready_at/expires_at = 还原成功 + 4h），每 5 分钟 `sweepRestored()` 删到期文件+记录，`cleanAllRestored()` 全清。`originalDownload.tempDir()` 与 `player.playTempDir()` 都改成 `restoredDir()`；两边还原成功后登记；玩家 TTL 改 4h 从 ready 算（不因播放续命）。开机 `purgeTempOnBoot()` 直接清空整个还原文件目录。垃圾扫描把 `original_tmp` 类改成「还原文件目录」。新增 `POST /api/system/clean-junk`：先 `cleanAllRestored()` 再 `scanJunk()`+`cleanFromReport()` 清其它能自动清的垃圾。前端设置页最顶部加「手动清理垃圾」卡片+确认框+toast | `test/restored.test.mjs` 5 条：原始下载与播放器共用同一目录；登记后 4 小时未到期保留/到期删文件+记录；一键清空不论到期；播放器还原目录登记并在到期后清掉；`POST /api/system/clean-junk` 清空还原目录 + 顺带清 encryptTmp 垃圾。既有 api/player 测试全绿 |
| 39 | 用户要求：设置页加「眼睛」按钮，管理全项目所有页面是否显示下载文件的原始名字；从下个版本起默认全部显示 `****`，只有点按钮后才显示真名 | 新增设置项 `showFileNames`（默认 **false**，持久化在 app.db）。**在 API 出口遮蔽**（不是前端遮罩）：新增 `src/services/mask.ts`（`showFileNames` / `maskName` / `maskFields` / `maskOne`），在 `/api/tasks`（列表+详情 title）、`/api/files`+`/pending`（name/title）、`/api/bt/seeds`+`/api/bt/tasks`（name/title）、`/api/stats`（recentTasks.title）、`/api/junk`（垃圾项与文件清单 name）统一替换成 `****`。设置页顶部按钮组新增眼睛按钮（Eye/EyeOff），点一下 `save({showFileNames})` 切换。⚠️ 白名单血案教训：`showFileNames` 已加入 `/api/settings` 的 allowed，否则永远存不进去。Android App 接口不遮蔽（App 需要真名保存文件，且那不是"页面"） | `test/mask-names.test.mjs` 3 条：默认任务/成品/统计都是 ****；打开眼睛后返回真名（并验证开关真的落盘）；再关掉立刻回到 ****。既有 api 测试显式打开 showFileNames（它们断言真名），mask-names 覆盖隐私默认；browser smoke 的文件页/BT/任务页全绿 |
| 40 | 用户报：任务页下载文件名字"一下显示 **** 一下显示原始名字"（一闪一闪） | 真因：文件名遮蔽只做了 REST 出口，**SSE `/api/events` 仍把原始 task 推给前端**；`useTasks` 收到 SSE 后 `{...current, ...event}` 把真名又盖回去，下一次轮询（遮蔽过）又变回 **** → 闪。修：在 SSE 出口统一遮蔽 —— `onTask`（title）、`onStats`（recentTasks.title，含每 5 秒定时推的 stats）、`onFile`（file.name/title）。新增 2 条回归用例：连上 SSE 后推一条带真名的事件，断言收到的 JSON 里是 `"title":"****"` 且**不含真名** | `test/mask-names.test.mjs` 新增「SSE 事件不能漏真名」「SSE stats 的 recentTasks 也要遮蔽」2 条，连同原有 3 条共 5 条全绿 |
| 41 | 用户报：任务页里有「进度 100% 但状态还是下载中」的任务；如果是加密归档阶段就别放在「正在下载」里，是 bug 就修 | 真因：BT 的完成判定由**扫货**负责，扫货只建**归档任务**（另有任务），原来的下载任务要等到 归档→加密→发布→收尾 全做完才被置 completed；中间一直挂着 `downloading 100%`。修：`btHarvest` 在 ①完成目录 把货物交给归档任务后**立刻把下载任务标 completed**；②种子 100% 但没有任何视频（音频/文本/压缩包）也标 completed（不再永远挂下载中）；③新增「收尾归位」：每轮扫货检查"下载任务 100% 且已有归档任务接手"→标 completed，**修复升级前就卡住的历史遗留任务**。归档/加密阶段的任务本来就在独立页「归档发布」（`payload.harvest` 判定），不会混进「正在下载」 | `test/bt-harvest.test.mjs` 新增 3 条：货物交给归档任务后下载任务立刻 completed；历史遗留（已有归档任务接手）下一轮扫货归位；100% 但无视频也标完成。bt-harvest 9 条 + bt-evict/bt-timing/api/mask 共 61 条全绿 |
| 42 | 用户澄清：眼睛只隐藏**下载文件的原始名字**；**加密归档后的名字（随机前缀，如 wrh2）一直可见**，不该隐藏 | 修正遮蔽范围：`/api/files` 与 `/pending` 从 `['name','title']` 改成只遮 `title`（`name` = 加密归档名，始终可见）；SSE `file` 事件同步只遮 `title`。另外把「下载原始文件」面板/toast 里的 `originalName` 也遮了（`publicJob` 用 `maskName`），但**真正下载的文件名不受影响**（服务端 Content-Disposition 仍用内部真名） | `test/mask-names.test.mjs` 更新：默认隐藏时成品 `name`（加密名）必须是 `abc123` 可见、只有 `title` 是 ****；新增「下载原始文件面板的原始名遮蔽、打开眼睛可见」1 条，共 6 条全绿；api 34 条 + 文件页冒烟全过 |
| 43 | 三条需求：①加密归档若是 zip，归档名要带 `_z` 标记；②zip 里往往有多个视频，播放器要能看列表自己选、还能切「下一个」（现代化播放器）；③把设置页的垃圾清理并进专门的「垃圾清理」页，删掉设置页那个入口，并统计所有垃圾总大小 | ①`archive.ts`：`archiveTaskFiles` 判断"多文件打包 zip 或原始文件本身是 zip"→ `publishedName` 加 `_z`（加密后成品名同带）。②`player.ts` 重构为**播放列表**：解密→zip 解压→`pickVideoFiles` 收集全部视频（按体积降序），每个视频独立状态（pending/remuxing/ready/failed），选中的那个才按需 ffmpeg 重封装；新增 `POST /api/files/play/prepare-item`、`GET /api/files/play/stream/:jobId/:index`；前端播放器改成「播放列表 + 视频区」，点列表切换、`下一个`按钮、`onEnded` 自动跳下一个。③`JunkPage` 新增「全部清理（含还原文件）」按钮（调用 `POST /api/system/clean-junk`，清空还原文件目录 + 所有可自动清理垃圾），页面显示可清理垃圾总大小；`SettingsPage` 删除「手动清理垃圾」卡片/handler/state | `test/player.test.mjs` 8 条（新增 zip 归档名 `_z`；zip 里两个视频都进播放列表；单视频 pending→prepare→ready；faststart 直接 ready；Range 流带 index）；restored/mask/pipeline 共 23 条全绿；文件页/垃圾清理页冒烟通过 |
| 44 | 用户报：iPhone 上视频播放又不行了（之前好好的）；另外设置页等手机端适配有问题 | **真因（播放）**：`express.static` 把 `index.html` 缓存了 1 小时 → 手机继续跑**旧前端**，而 v1.16 播放流接口已改成 `/play/stream/:jobId/:index`，旧 JS 打 `/play/stream/:jobId` **404**。修：index.html 一律 `Cache-Control: no-store`（带 hash 的 assets 才 `immutable` 长缓存）；同时**向后兼容**旧的 `/play/stream/:jobId`（默认第 0 个），并让地址支持 `0.mp4` 后缀（Safari 对无扩展名视频 URL 更挑剔）；视频加 `preload=metadata` + `max-h-[50vh]`。**手机适配**：设置页三处 `grid-cols-3` 改 `grid-cols-1 sm:grid-cols-3`，顶部按钮行加 `flex-wrap` | `test/player.test.mjs` 补充 `0.mp4` 与旧路径（无 index）都返回 206；`test/api.test.mjs` 新增「index.html 必须 no-store」；`test/junk-scan.test.mjs` 的还原目录 fixture 改到 `restoredDir()`。player/api/mask/restored/junk 共 58 条全绿；设置页/文件页/垃圾清理页冒烟通过 |
| 45 | 用户报：①点播放时上次已解密好的应该直接复用、别重复解密，并做好一一对应；②播放失败提示「解析出来的不是视频文件（原始名：1（4））」，可能解压出来是文件夹、文件名有空格/中文/特殊字符，要能进去播放文件夹里所有视频 | ①`player.ts` 新增**复用**：workDir 里写 `meta.json`（原始名），`restored_files` 表用 `source_file_id` 一一对应；`preparePlayable` 先复用内存 job，再按表找未过期且带 meta 的 workDir → 跳过 openssl 直接进入解压/组装列表；上次转好的 `play_N.mp4` 也复用。②**内容识别**替代扩展名判断：`media.ts` 新增 `looksLikeVideo`（mp4/mkv/avi/flv/ts/mpeg/ogg/rmvb 文件头）与 `detectArchiveKind`（zip/rar/7z）；`pickVideoFiles` 对无扩展名文件也按文件头识别，并递归进 zip 里的文件夹；rar/7z 给明确提示。所有子进程都用 argv 数组，空格/中文/特殊字符不受影响 | `test/player.test.mjs` 13 条（新增：同文件二次点播放复用同一 job；还原目录里已有的解密结果直接复用不再 openssl；无扩展名「1（4）」靠内容识别成视频；zip 里套文件夹 + 中文/空格/特殊字符名 → 两个视频都进列表且 mkv 按需转码；rar 明确报错）。player/restored/api/mask/junk 共 63 条全绿；手机视口溢出测试扩到 6 个页面（首页/设置/文件/任务/垃圾清理/BT），修掉 openssl 版本号徽章溢出 83px 的问题 |
| 46 | 用户报：文件清单在移动端没适配——播放/删除等按钮要横向侧滑才看得到，交互不友好 | `FilesPage` 拆成两套视图：`md` 以上仍是表格；`md` 以下（手机）渲染**卡片列表**，每张卡片直接显示 加密归档名 / 原始名 / 大小 / 来源 / 下载状态，以及**播放 / 下载 / 下载原始文件 / 删除**按钮（不用横向滑动）。把「下载状态」与「操作」抽成 `fileStatus()` / `fileActions()` 两个函数，表格与卡片共用，避免两套逻辑走样 | 浏览器冒烟新增「手机端文件页：卡片列表，播放/下载/删除按钮直接可见」：390px 视口下断言表格隐藏、播放/删除按钮的 boundingBox 完全在视口内；手机视口溢出测试覆盖 6 个页面。文件页桌面用例 + 全选批量动作用例照旧通过 |
| 47 | 用户问：播放能不能用 VLC 替代，这样不用转封装就能播任何视频 | **部分可以**：VLC 是客户端 App，不能替代浏览器内 `<video>`（浏览器只支持有限编码）；但可以给 VLC 一个**原始流**——服务器把解密/解压出来的原文件（mkv/avi/hevc…）**原样**通过 Range 提供，VLC 什么格式都能播，**完全不用 ffmpeg 转封装**。已实现 `GET /api/files/play/raw/:jobId/:index`（原始流，Content-Type 按扩展名 + Content-Disposition 带原文件名）、`POST /api/files/play/vlc`（返回带 `?token=` 的地址与 .m3u，供 VLC 免登录访问）、`GET /api/files/play/vlc.m3u`；播放器弹窗新增「复制 VLC 地址」按钮（提示：VLC → 网络 → 打开网络串流 → 粘贴）。单文件播放项显示名改用**原始名**（带真实扩展名，VLC 好识别） | `test/player.test.mjs` 新增 1 条：mkv 原始流返回**原文件字节**（不是转封装 mp4）、地址带 token、Range 206、Content-Type=video/x-matroska、.m3u 内容正确。player/api/mask/restored/junk 共 64 条全绿 |
| 48 | 用户要求：①「播放」和「下载原始文件」都要解密归档文件，产物应共用，别重复解密；②点播放解密很慢，退出解密页面后文件清单要显示每个文件的状态（播放文件：解密中 / 已有解密好的文件可直接播放），没点过或超过 4 小时就什么都不显示 | ①新增 `src/services/decrypted.ts`：**共享解密产物** `state/restored/dec_<fileId>.bin` + `dec_<fileId>.json`（原始名），登记 restored_files（kind='decrypted', source_file_id=fileId）；`ensureDecrypted(fileId)` 有就复用、没有才解密。播放器 `runPrepare` 和「下载原始文件」`runDecrypt` 都改用它 → 谁先点谁解密，另一个直接用；下载完成后**不再删**共享产物（`job.shared`），交给 4 小时 TTL。②`player.ts` 新增 `playStatusByFile()`（有任务在解密 → decrypting；有未过期的 decrypted/player 产物 → ready；否则不返回）；`/api/files` 与 `/pending` 每项带上 `playStatus`；文件页在下载状态下面显示「播放文件：解密中…」/「已有解密好的文件，可直接播放」，其余情况不显示；关闭播放器时顺手 refresh。 | `test/player.test.mjs` 新增 2 条（ensureDecrypted 第二次复用且文件不被重写、播放也复用同一份；没点过 playStatus=null → 解密完成变 ready），并更新原「复用」用例为共享产物语义；`test/api.test.mjs` 的原始文件清理用例改为「任务清掉但共享产物保留、开机全清」。player/restored/api/mask/junk 共 66 条全绿；文件页桌面+手机冒烟通过 |
| 49 | 用户要求：①转码播放绝对不要（代价太大，下载下来用播放器播）；②文件清单要标清封装格式——新下载的在加密归档前按**后缀**拿格式；已下载的点播放/下载原始文件解密后按原始名后缀拿格式并显示 | ①不做转码（保持现状：VLC 原始流用于其它格式，浏览器只播 mp4）。②`published_files` 新增 `container` 列（ensureColumn 补老库）：`media.ts` 新增 `containerFromName()`（后缀→MP4/MKV/AVI/RMVB/WMV/FLV/TS/ZIP/RAR/7Z…）与 `probeContainer()`（**后缀优先**，没后缀才用文件头/ffmpeg 兜底）；`archiveTaskFiles` 归档时算出 container（多文件=ZIP）→ `PublishUnit.container` → `filesRepo.add` 落库；`ensureDecrypted` 在解密/复用后 `backfillContainer()` 按 VLT 原始名后缀补写（明显非视视频的 txt/srt/jpg/pdf 跳过不探测）。`/api/files` 返回 `container`；文件页表格加「格式」列、手机卡片加格式徽章（老数据显示"未知"，点过播放/下载原始后自动补上） | `test/container.test.mjs` 5 条：后缀映射、后缀优先探测、归档时记录（多文件 ZIP/单视频 AVI）、流水线发布记录带格式、老成品解密后按后缀补 WMV。container/player/restored/api/mask/junk/pipeline 共 75 条全绿；文件页冒烟新增「格式」列断言 |
| 50 | 用户觉得 VLC 功能鸡肋，要求删掉 | 已彻底移除：`src/routes/files.ts` 的 `GET /play/raw/:jobId(/:index)`（原始流）、`POST /play/vlc`（带 token 的 VLC 地址）、`GET /play/vlc.m3u` 全部删除；前端播放器弹窗删掉「用 VLC 播放」按钮、`copyVlc`、相关提示与 `Copy`/`useToast` 引入；`api.ts` 删掉 `filePlayVlc`；测试删掉 VLC 用例；`player.ts` 注释同步去掉 VLC 字样。播放器恢复为：浏览器 `<video>` + 需要时 ffmpeg 重封装（不转码）。grep `vlc|play/raw|m3u` 已无残留 | player/container/api 共 55 条全绿；文件页桌面+手机冒烟通过 |
| 51 | 用户要求：文件清单在插入 U 盘、文件拷贝到 U 盘时显示状态（拷贝进行中 / 已经在 U 盘等）；并检查拷贝中途断电的安全措施 | ①`published_files` 新增 `on_usb` / `usb_copied_at`（ensureColumn 兼容老库）；发布时 U 盘在就写 on_usb=1（consumer 直接落 U 盘）。②`usbMount.ts` 拷贝改为**逐文件、异步**：`offloadToDir()` 用 `.part` → fsync → rename 原子落盘（`node:stream/promises` pipeline，不阻塞事件循环，拷 GB 不卡界面），成功后**先写库指向 U 盘 → 再删源**；带防重入（一轮没跑完不启第二轮）；失败保留源文件并标记 error，下次巡检重试。③文件清单 `usbStatus`：`copying`（正在拷贝到 U 盘…）/ `on_usb`（已在 U 盘）/ `error`（拷贝失败，源文件保留自动重试）。**断电措施**：拷贝中途断电只剩 `.part`（不被当成品，源完好）→ 巡检 `cleanupPartials()` 清掉重搬；rename 完但没写库 → `reconcileUsbCopies()` 认领 U 盘上完整文件；写库完但没删源 → 两边都在也不重复搬（残留源由垃圾扫描报告）。 | `test/usb-copy.test.mjs` 4 条：正常拷贝（记录 on_usb、源删除、幂等）；断电①rename 完没写库 → 认领；断电②清理 .part（完整文件不动）；断电③写库了但源没删 → 不重复搬。usb/api/pipeline 共 43 条全绿；文件页桌面+手机冒烟通过 |
| 52 | 用户报：插 U 盘后触发几十 GB 成品拷贝，系统卡死——网页打不开、SSH 很难登录（登上也卡） | 真因：拷贝**不限速**，几十 GB 把 SD/USB 共用总线打满（iowait 飙高 + 脏页回写），系统所有 I/O（含 SSH 登录、Node 服务）被饿死；同步拷贝还会阻塞事件循环。修：①拷贝改成**异步流式**（`node:stream/promises` pipeline，256KB 块），不再阻塞事件循环；②加**限速** `ThrottleStream`，默认 **10MB/s**（`USB_COPY_RATE_MBPS` 可调，0=不限）；③每拷完一个文件歇 150ms（`USB_COPY_PAUSE_MS`）；④防重入（一轮没跑完不启第二轮）；⑤USB 卡片提示限速与可调项。另外提示：U 盘若是 **NTFS**（走 ntfs-3g/FUSE）拷贝时 CPU 很高，建议格式化成 exFAT/FAT32 | `test/usb-copy.test.mjs` 新增 1 条「拷贝限速」：1MiB@2MB/s 至少几百毫秒（证明限速真的生效），且不能慢到离谱；usb/api/pipeline/container 共 49 条全绿 |
| 53 | 用户强烈反对 10MB/s 限速：插 U 盘就是要尽快搬完，短暂卡顿可以接受；要求改回全速 | 已改回：`usbCopyRateMbps` / `usbCopyPauseMs` **默认 0 = 全速、不额外等待**（限速能力保留为可选配置 `USB_COPY_RATE_MBPS`）；拷贝仍是**异步流式**（比同步快、且不阻塞事件循环——这一项不牺牲速度，保留）；USB 卡片文案改成"默认全速拷贝"。 | `test/container.test.mjs` 新增「默认全速」断言；usb-copy/container 11 条全绿 |
| 54 | 用户插的 U 盘叫 upo，`/media/mypi/` 下同时出现 `upo` 和 `upo1`，`cd upo` 失败，web 项目操作失败 | 真因：同一个分区被**重复/失效挂载**（典型场景：udisks 自动挂到 /media/mypi/upo，我们的服务又挂到 /mnt/usb；或者拔盘/松动后旧挂载点变"失效挂载"（stat 报 ENOTCONN），udisks 再插时发现 upo 被占用就挂成了 upo1）。修：`getUsbState()` 改用 `findmnt` 拿到该分区的**全部实际挂载点**，`pickAndCleanMounts()` 判断哪些是"活的"（stat+可写）：失效挂载 `umount -l` 清掉、重复挂载只留一个（优先固定点 `/mnt/usb`，否则第一个活的），并打日志；巡检发现盘不在时也把 `/mnt/usb` 的失效挂载清掉，避免下次插变 upo1 | `test/usb-copy.test.mjs` / `test/container.test.mjs` 11 条全绿（findmnt/umount 是 Linux 专用，macOS 测试环境走空实现，不影响既有用例） |
| 55 | 用户报：升级后拷 3.5G 到 U 盘失败；upo/upo1 同时存在时不知道拷到哪个；一直"拷贝中"；失败→重拷→又失败死循环 | 修：①**拷贝前探针** `probeWritable()`（异步写 4KB 带 8s 超时）——失效挂载/只读盘/空间不足会立刻暴露，失败就 `resetUsbMount()`（把该分区**全部挂载点**（upo、upo1、/mnt/usb）逐个 `umount -l` 推出，再重新挂到固定点 `/mnt/usb`）。②**卡死看门狗**：90 秒没有任何进度就中止（U 盘拔松/失效挂载），并重置挂载。③**失败冷却 60 秒** + 一次只处理一个失败就停，彻底杜绝"失败→立刻重拷→再失败"死循环。④**空间检查**：剩余空间不够直接标失败并冷却，不硬拷。⑤**进度可见**：文件清单显示"正在拷贝到 U 盘… 45%（1.6 GB / 3.5 GB）"。⑥全速不变（默认 0=不限速）。挂载点状态 `needsReset` 让巡检自动做"全部推出→重新挂载" | `test/usb-copy.test.mjs`/`test/container.test.mjs` 11 条全绿（findmnt/umount 为 Linux 专用，测试环境走空实现） |
| 56 | 用户 `/media/mypi/upo` 里 `cd upo` 报 "permission denied"（只有 upo，没有 upo1 了） | 真因：udisks 把 U 盘挂在 `/media/mypi/upo` 时，挂载点/文件系统根目录权限是 root-only（或 uid=0、fmask 太严），普通用户 `mypi` 进不去。修（应用侧）：`getUsbState()` 只要实际挂载点**不是固定点 `/mnt/usb`**（或存在重复/失效挂载）就置 `needsReset`，巡检把它们**全部推出后重新挂到 `/mnt/usb`**（root 拥有的 755 目录，普通用户也能 cd 进去），带 30 秒节流避免反复卸挂。 | usb-copy/container 11 条全绿 |
| 57 | 用户实测：`/media/mypi/upo` 是 **root 700 的普通目录**（不在挂载表里，`findmnt -T` 指回 `/`），里面有个 `ttdownload/`；真正的 U 盘（exfat/upo/88G）挂在 `/mnt/usb`。`cd upo` 失败就是权限；之前服务误把它当 U 盘挂载点往里写，文件其实写到了 SD 卡 | 修（应用侧自愈）：`reconcileUsbCopies(destDir, sdConsumerDir)` ①U 盘上存在同名完整文件 → 把记录改指向 U 盘（修复"记录指向旧 /media/... 路径"）；②记录标了 `on_usb` 但文件已不在、且 SD 源还在 → `resetUsb()` 改回"待拷贝"重新搬；同时 `getUsbState` 对"非 /mnt/usb 挂载点"也会触发统一重挂（v1.21.5）。用户侧清理：确认 `/media/mypi/upo/ttdownload` 里若有个别文件，先 `mv` 到 `/mnt/usb/ttdownload/xiaofeizhe_downd/` 再删掉整个 `/media/mypi/upo` | usb-copy/container 11 条全绿 |
| 58 | 用户 `/media/mypi/upo/ttdownload` 里有很多文件（不能删），U 盘已拔；问 `sudo ./deploy.sh --no-apt` 是否能完成升级 | ①`--no-apt` **不会** git pull，只构建本地代码 → 必须先更新代码（镜像/压缩包），再 `--no-apt`。②新增迁移逻辑（v1.21.7）：`reconcileUsbCopies()` 发现记录 `on_usb=1` 但路径**不在当前 U 盘目录**（旧 /media 残留）→ `resetUsb()` 标回待拷贝；`offloadToDir()` 把残留文件搬到 `/mnt/usb`，**拷完才删 SD 上的那份**；若 U 盘已有同名同大小文件则直接改记录+删源，不重复拷。用户无需手动删 `/media/mypi/upo`，服务会自动搬走（搬完剩空目录） | `test/usb-copy.test.mjs` 新增 2 条（旧 /media 残留自动迁移、U 盘同名同大小不重复拷），共 7 条全绿 |
| 59 | 升级 v1.21.7 后日志出现 `拷贝到U盘失败：scc304：ENOENT ... scc304.part`，紧接着服务把 /mnt/usb 卸了重挂 | 真因：拷贝进行中 U 盘没挂稳/被重置（或巡检在拷贝中做 reset），写 `.part` 时父目录消失 → ENOENT。修：①巡检的 reset 加 `!copyRunning`，**拷贝进行中绝不卸挂载点**；②`probeWritable(dir)` 对 `/mnt/usb/...` 先确认 `/mnt/usb` 确实是挂载点（否则 mkdir 会在 SD 上重建目录、把成品写进 SD）；③失败先探测目标是否还能写：能写=瞬时错误 → 不重置挂载、10 秒后重试；不能写才重置、冷却 30 秒；④ENOENT/ENOTCONN/EIO 的失败日志加提示"U 盘可能没挂上/被拔了一下" | usb-copy/container 13 条全绿 |
| 60 | scc304（1.53GB）拷贝到 80% 就失败，且每次都**从 0 重拷**（用户强调） | 真因：失败时把 `.part` 删了 → 每次重试都从头开始。修：①**断点续传**——失败保留 `.part`，下次从断点继续；`.part.meta` 记录源文件 size/mtime + **本次进程 boot 标识**，并校验 `.part` 尾部 64KB 与源同偏移一致（防没刷盘的半截脏数据被拼进去）；②断电/重启后（boot 不一致）的 `.part` 一律丢弃，从头拷；③卡死看门狗阈值 90s → **300s**（`USB_COPY_STALL_SEC` 可调），避免慢 U 盘刷盘被误判卡死；④拷贝进度从断点开始显示 | `test/usb-copy.test.mjs` 新增 3 条（断点续传内容完整、旧 boot 不续传、脏 .part 丢弃），共 10 条全绿 |
### 8.2 还没做 / 需要你决定

- **transmission 自己的队列**：它默认 `download-queue-size=5`（最多 5 个种子活跃下载）。
  我们这边放行了 10 个、界面显示"下载中"，transmission 实际只活跃 5 个。
  **用户还没决定要不要一起放开**（要放开就在 `start()` 里 `session-set`）。
- **发布任务失败后没有重试/收尾路径**（`pipeline.ts` 失败就 `failed`）：父下载任务不会收尾，
  源目录也不会被清理；用户点"重试"会走 `prepare` → 种子文件已删 → 永久失败。
  建议：给发布任务加有限重试 + 失败后保留目录并明确提示。
- **磁盘口径**：`disk.ts` 只测 `DOWNLOAD_ROOT` 所在分区，而 BT 数据写在 `BT_DOWNLOAD_DIR`；
  两者不同分区时准入/预留会算错。归档/加密需要的额外空间（zip 要再占一份源文件大小）也没进准入。
- **payload 读-改-写竞态**：`transmission.poll` / `btHarvest` / `btEvict` / `scheduler` 都是
  "读旧快照 → await → 整体写回"，定时器并发时可能互相覆盖 `harvestedFiles`/`timedOutAt`/`pausedBySpace`。
- **BT 计时口径（已改，2026-10）**：判定用的是 `payload.btActiveMs`（只在服务运行时用单调时钟累加，断电/关机不计），`btHandedAt` 只用来展示。因空间不足被暂停的时间**仍然计入**。
- **完成判定只看"文件在 downloads 目录"**：没有校验 `percentDone`；若 transmission 关掉了
  `incomplete-dir-enabled`，半成品会被当成品发布。部署默认开启，所以生产不触发，但代码不设防。
- **`db.ts` 把 `pageSize` 截到 200**，而扫货/入队都传 500 → 任务数 >200 时去重与收尾会漏项。
- 网页端的下载路由不支持 Range（安卓路由支持）—— 浏览器下载不能断点续传。
- 老目录 `/ttdownload/transmission/downloads` 已弃用；升级上来的机器里若有遗留文件不会被扫到。
- `btEvict` 的设置项 `btEvict.*` 已被 `btPolicy.*` 取代，旧字段留在配置里没清（无害）；
  `BT_EVICT_*` 环境变量同理（README 的环境变量表已标注"已废弃"）。
- `pipeline` 把归档文件 move 进 `downd_ok_p2_jiami_tmp` 之后、`fileId` 落库之前若崩溃，
  该单元会丢且临时 `.data` 不会回收（没有清理任务）。
