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
再补这四条 —— BT 最容易"装好了但静默不工作"：

```bash
# ① 四个后台 worker 都起来了吗
grep -aE '流水线已启动|调度器已启动|BT 超时策略已启动|BT 扫货已启动' /ttdownload/state/app.log | tail -4
# ② transmission RPC 真通吗（409 = 正常；401/000 = 凭据或服务不对，BT 一定不可用）
curl -s -o /dev/null -w 'tr rpc http=%{http_code}\n' http://127.0.0.1:9091/transmission/rpc
# ③ transmission 实际用的下载目录 = .env 里的 BT_DOWNLOAD_DIR 吗（不一致就永远扫不到货）
grep -h '"download-dir"' /etc/transmission-daemon/settings.json \
  /var/lib/transmission/.config/transmission-daemon/settings.json 2>/dev/null
# ④ 磁盘：/ttdownload 可用空间必须 > 预留（默认 10G），否则所有任务永远"空间不足"
df -h /ttdownload 2>/dev/null || df -h /
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
- **8 小时口径**：因空间不足被暂停的时间也计入 8 小时且不顺延（`btHandedAt` 不因暂停顺延）。
- **完成判定只看"文件在 downloads 目录"**：没有校验 `percentDone`；若 transmission 关掉了
  `incomplete-dir-enabled`，半成品会被当成品发布。部署默认开启，所以生产不触发，但代码不设防。
- **`db.ts` 把 `pageSize` 截到 200**，而扫货/入队都传 500 → 任务数 >200 时去重与收尾会漏项。
- 网页端的下载路由不支持 Range（安卓路由支持）—— 浏览器下载不能断点续传。
- 老目录 `/ttdownload/transmission/downloads` 已弃用；升级上来的机器里若有遗留文件不会被扫到。
- `btEvict` 的设置项 `btEvict.*` 已被 `btPolicy.*` 取代，旧字段留在配置里没清（无害）；
  `BT_EVICT_*` 环境变量同理（README 的环境变量表已标注"已废弃"）。
- `pipeline` 把归档文件 move 进 `downd_ok_p2_jiami_tmp` 之后、`fileId` 落库之前若崩溃，
  该单元会丢且临时 `.data` 不会回收（没有清理任务）。
