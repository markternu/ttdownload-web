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
| 安卓解密 App | `VltRestore` | （见其 README） | 纯 Java、零依赖，把服务端加密的 `.data` 还原 |

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

- 后端 **221 项测试**、浏览器 **23 项**全绿；已在树莓派（Debian + transmission 4.x）实机部署验证。
- 安卓端 v1.4.1 已对接本服务端的 `/api/android/*`（多台服务器、自动扫描、下载后上报、SD 搬移）。
- **本窗口刚做完的大改动：BT 模块整体重构**（第 3 节），以及磁盘准入、日志脱敏。

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
- **预留 10G 是给「归档/加密/发布」周转的操作空间**（加密是边读边删）。
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

---

## 6. 日志与排障

**BT 日志绝不出现种子名/文件名**（用户要求）。统一走 `services/btAnon.ts`：
`anonFile(i)`=文件N、`hideName()`、`hidePath()`（只留目录）、`hideText()`。
连 `TR_RPC` 的 `metainfo`（整颗种子的 base64，含全部文件名）也隐藏了。
数据库/界面里的真实标题照旧，只有日志脱敏。
`test/transmission-module.test.mjs` 有一条断言：跑完 prepare+start+poll 后翻整个 app.log，
`SECRETMOVIE9377.mp4` 这类名字一个都不许出现。

常用标记（`grep -aE 'MARK:(BT_|DISK_GATE|TASK_)' /ttdownload/state/app.log`）：

| 标记 | 含义 |
| --- | --- |
| `BT_SELECT` | 只挑视频的结果（数量/大小） |
| `BT_PICK` | 多视频挑同类（哪条规则、下几个） |
| `BT_PREPARE` | 已备好（种子暂停中，等空间准入）+ 要下多少 |
| `BT_SEED_DELETED` | transmission 已接管，种子文件已删 |
| `BT_HARVEST` | 扫货：扫到什么、交了什么、清理了什么 |
| `BT_TIMEOUT_GRACE` / `BT_TIMEOUT_DROP` | 超时宽限中 / 已清理 |
| `BT_CLEANUP` / `BT_CLEANUP_SHARED` | 目录清理 / 因为共用而跳过 |
| `DISK_GATE` | 空间准入：谁被放行、谁被跳过、可用多少 |
| `MODULE_GATE` | 模块并发满（默认 0=不限，一般不会出现） |
| `SPACE_FREED` | 空间回血，立刻重算等待队列 |

排障手册（`docs/排查手册.md`）按现象分类，含 4.95「一堆任务全停住+磁盘满+零成品」那次的完整复盘。

---

## 7. 测试与部署

```bash
npm run test:only      # 后端（改动逻辑必跑）
npm run test:browser   # 真浏览器（改前端必跑）
npm run test:all       # 两个都跑
```

- BT 相关测试：`test/transmission-module.test.mjs`、`test/bt-harvest.test.mjs`、
  `test/bt-select.test.mjs`、`test/bt-evict.test.mjs`、`test/bt-cleanup.test.mjs`
- 队列/磁盘：`test/scheduler-space.test.mjs`、`test/disk-driven-admission.test.mjs`
- 测试脚手架 `test/helpers.mjs`：`setupRuntime()` 会把 `DOWNLOAD_ROOT` 指到临时目录；
  **它的并发默认是 3（不是生产默认）**，要测"不限并发"得显式传 env。

部署到真机后**必须**确认的三件事：

```bash
grep -E '^(BT_DOWNLOAD_DIR|TRANSMISSION_INCOMPLETE_DIR|MAX_CONCURRENT|CONCURRENCY_)' .env
ls -ld /var/lib/transmission/downloads /var/lib/transmission/incomplete
grep -aE 'BT 扫货已启动|BT 超时策略已启动' /ttdownload/state/app.log | tail -2
```

---

## 8. 已知/未完成

- **transmission 自己的队列**：它默认 `download-queue-size=5`（最多 5 个种子活跃下载）。
  我们这边放行了 10 个、界面显示"下载中"，transmission 实际只活跃 5 个。
  **用户还没决定要不要一起放开**（要放开就在 `start()` 里 `session-set`）。
- **种子文件已删**：任务被超时清理后想重下，需要重新上传 .torrent
  （可选改进：把元数据 base64 存库，支持从库重新丢给 transmission）。
- 网页端的下载路由不支持 Range（安卓路由支持）—— 浏览器下载不能断点续传。
- 老目录 `/ttdownload/transmission/downloads` 已弃用；升级上来的机器里若有遗留文件不会被扫到。
- `btEvict` 的设置项 `btEvict.*` 已被 `btPolicy.*` 取代，旧字段留在配置里没清（无害）。
