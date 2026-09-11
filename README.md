# ttdownload-web —— 统一下载管理器（Node.js + React）

> 把老脚本（`video_auto.sh` / `all1.sh`）的「扫描→加密→归档→清单→下载→上报删除」整条链路，
> 改造成一个**前后端 Web 应用**：三大下载模块（BT 种子 / aria2 URL / 公开视频URL）统一入队，
> 由**唯一调度器**做并发与磁盘空间（默认保留 10GiB）门控，完成后**归档 + AES 加密 + 发布**，
> 并通过 REST API 与**安卓 App** 通信（App 拉清单、下载、上报完成，服务端删文件腾空间）。

- 完整使用教程（部署 + 三大模块 + 安卓 App）：[`使用教程.md`](./使用教程.md)
- 接口契约（前后端 + 安卓共同遵守）：[`docs/API.md`](./docs/API.md)
- 架构设计（目录布局 / 队列 / 门控 / 加密兼容性）：[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

---

## 一、功能总览

| 模块 | 入口 | 下载目录 | 完成后 |
| --- | --- | --- | --- |
| transmission（BT 种子） | 上传 zip（自动解压出 `.torrent`）/ 种子列表入队 | `transmission/downloads/<种子名>` | 只保留下载**视频+图片**，多文件打 zip，统一命名后归档 |
| aria2（URL 直链） | Web 文本框，一行一个 URL（可多行） | `downd_aria2_path` | 单文件直接归档（判定：任务完成且无 `.aria2` 控制文件） |
| 公开视频URL（yt-dlp） | 粘贴视频链接 → 解析 → 选质量 → 加入队列 | `downd_web_tools` | 单文件归档 |

统一的后续流水线：`归档(downd_ok_p2) → AES-256-CBC 加密 → 去后缀 → 发布(xiaofeizhe_downd)`，
命名沿用老脚本规则（3 字母随机前缀 + 递增序号，V-L-T `FKY996` 标记保留原始文件名，PC 端可解密还原）。

**BT 出清机制**：识别"永远下不完"的 BT 任务（① 完全无资源 ② 中途停滞 ③ 还有资源但极慢），
按调度删除任务并清理 transmission incomplete 目录（默认 `/var/lib/transmission/incomplete`）；
**硬门槛：只有实际下载尝试 ≥10 小时的任务才参与判断**（因空间不足暂停的时间不计入）；
进度 ≥79% 的视频按"未下完但可播放"处理 —— 移交归档加密发布而**不删除**；
每次出清都会**广播"空间已腾挪"**，等待队列立即重新评估。

**统一等待下载队列 + 磁盘空间门控**：任何模块都不允许绕过队列直接开下载；
调度器按 `可用空间 - 预留(10GiB) - 运行中任务预估大小` 决定放行；空间吃紧自动暂停，释放后自动继续
（彻底避免三个模块同时抢空间把磁盘撑爆）。

## 二、技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS + react-router + recharts |
| 后端 | Node.js 18+ + TypeScript + Express + better-sqlite3(SQLite) + zod/multer |
| 实时 | SSE（`/api/events`）推送任务/文件/统计/日志 |
| 外部工具 | aria2c（JSON-RPC）、transmission-daemon（RPC）、yt-dlp、ffmpeg、openssl、zip/unzip |
| 部署 | 一键 `deploy.sh`（Ubuntu）+ systemd + Docker/docker-compose |
| 运维 | `--update` 拉取最新代码并重新部署、`--stop/--start/--restart`、`--logs/--logs-follow` |
| 调试 | 全链路 `[MARK:XXX]` 标记日志 + 网页「日志」页 + 一键导出诊断包 + 首页「网络自检」 |
| 远程修复 | 网页「修复脚本」页：上传环境修复脚本并一键执行（默认关闭 + 维护令牌 + 执行前预览 + 输出日志） |

## 三、快速开始（开发环境）

```bash
# 后端（默认 http://localhost:8080）
npm install
cp .env.example .env          # 按需修改 DOWNLOAD_ROOT / ANDROID_TOKEN
npm run dev                   # tsx watch 模式

# 前端（开发服务器 http://localhost:5173，自动代理 /api -> 8080）
cd web && npm install && npm run dev
```

生产/本地一体化（后端直接托管前端构建产物）：

```bash
npm run build:all             # 构建后端 dist/ + 前端 public/
npm start                     # http://localhost:8080
```

> 本机测试可把 `DOWNLOAD_ROOT` 指到一个临时目录，例如
> `DOWNLOAD_ROOT=$PWD/.runtime PORT=8099 ANDROID_TOKEN=test-token npm start`。

## 四、一键部署（Ubuntu，生产推荐）

**要求**：Ubuntu 20.04/22.04/24.04，或 Debian 12/13、树莓派 OS（Raspberry Pi OS）；
可 `sudo`、systemd、能上外网。Node.js 由脚本安装（目标 Node 20）。
除此之外**系统依赖全部由脚本自动安装**，你唯一需要交互的地方是 transmission 安装脚本的提问。

```bash
git clone git@github.com:markternu/ttdownload-web.git
cd ttdownload-web
sudo ./deploy.sh
```

脚本自动完成：安装基础依赖（Node 20/yt-dlp/ffmpeg/openssl/zip/unzip/jq/build-essential/python3；
依赖不含 transmission，改用下面的交互脚本）→ **单独判断并安装 aria2 / transmission**
（aria2 缺失则 `apt install -y aria2`；transmission 的 `transmission-daemon` 缺失则调用工程自带的
`deploy/ubuntutr.sh`，**保留其全部交互提问**：IP 白名单、RPC 登录密码等；已安装则跳过、不做改动）→ 建目录树 →
`npm ci` + 构建前后端 → 生成 `.env`（含随机安卓 Token，不覆盖已有配置）→ ufw 放行端口 →
注册 systemd 服务并启动 → 健康检查并打印访问地址与 Token。

```bash
sudo ./deploy.sh --check-deps   # 先体检：列出各依赖是否已装、缺了会怎么处理
sudo ./deploy.sh --update       # 已部署过：git pull + 重建前后端 + 重启 + 健康检查（最常用）
sudo ./deploy.sh --status       # 查看状态
sudo ./deploy.sh --restart      # 重启
sudo ./deploy.sh --stop         # 停止（数据不动）
sudo ./deploy.sh --start        # 启动
sudo ./deploy.sh --logs         # 看最近 200 行日志（--logs 2000 指定行数）
sudo ./deploy.sh --logs-follow  # 实时跟踪日志
sudo ./deploy.sh --port 9000    # 指定端口
sudo ./deploy.sh --root /data/ttdownload
sudo ./deploy.sh --uninstall    # 移除服务（保留数据）
```

### 日志与排查（调试期）

- 日志文件：`/ttdownload/state/app.log`（20MB 轮转），部署日志：`/ttdownload/state/logs/deploy.log`
- 默认 `LOG_LEVEL=debug`：记录外部命令完整 argv、退出码、stdout/stderr 摘要、HTTP 请求、RPC 调用
- 网页「**问题反馈**」页：**一键下载诊断报告**（zip：日志+部署日志+错误摘要+任务失败原因+网络自检+README），也可单项下载日志/任务清单/网络报告；页面直接列出最近失败任务与原因
- 网页「**日志**」页：调试开关、级别/标记/关键字过滤、下载日志、清空
- 首页「**网络自检**」：DNS / HTTPS(Google,YouTube,GitHub) / yt-dlp 解析 / googlevideo CDN / 本机 RPC 逐项实测
- 标记速查与排查流程：见 [`docs/排查手册.md`](./docs/排查手册.md)
- **环境问题远程修复**：网页「修复脚本」页上传 `.sh` 一键执行（默认关闭，需 `MAINTENANCE_TOKEN`，执行前可预览内容，输出与退出码留档）

## 五、Docker 部署

```bash
export DOWNLOAD_ROOT=/ttdownload        # 宿主下载目录
export ANDROID_TOKEN=$(openssl rand -hex 12)
docker compose up -d
# 打开 http://<服务器IP>:8080
```

## 六、环境变量（`.env`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | 0.0.0.0 / 8080 | 监听地址与端口 |
| `DOWNLOAD_ROOT` | /ttdownload | 下载根目录（所有模块/归档/发布目录都在其下，改后需重启） |
| `ENCRYPT_PASSWORD` | 老脚本默认值 | AES 密码（必须与 PC 端解密工具一致） |
| `RESERVE_FREE_BYTES` | 10737418240 (10GiB) | 磁盘保留空间：低于它就暂停下载 |
| `MAX_CONCURRENT` | 3 | 全局最大并发下载数 |
| `CONCURRENCY_TRANSMISSION` / `_ARIA2` / `_WEBVIDEO` | 1 / 2 / 2 | 各模块并发上限 |
| `ANDROID_TOKEN` | 无 | 安卓接口 Token；不配置则安卓接口关闭（401） |
| `ARIA2_RPC_HOST/PORT/SECRET` | 127.0.0.1 / 6800 / 空 | aria2 RPC（应用会在未启动时自动拉起 aria2c） |
| `TRANSMISSION_RPC_HOST/PORT/USER/PASSWORD` | 127.0.0.1 / 9091 / 空 | transmission RPC |
| `TRANSMISSION_INCOMPLETE_DIR` | /var/lib/transmission/incomplete | BT 出清时一并删除该目录下对应任务的文件夹 |
| `BT_EVICT_ENABLED` | 1 | 是否启用 BT 出清 |
| `BT_EVICT_MIN_AGE_HOURS` | 10 | 硬门槛：实际下载尝试满多少小时才参与出清判断 |
| `BT_EVICT_SALVAGE_PERCENT` | 79 | 进度达到该值且是视频 -> 按"可播放视为完整"移交归档 |
| `BT_EVICT_STALL_MINUTES` | 30 | 速率 0 且停滞超过该时长 -> 判定无资源 |
| `BT_EVICT_SLOW_KBPS` / `BT_EVICT_SLOW_ETA_HOURS` | 20 / 72 | 极慢判定：速率低于该值且预计剩余超过该时长 |
| `BT_EVICT_CHECK_INTERVAL_MIN` | 5 | 出清检查周期（分钟） |
| `YTDLP_BIN` / `FFMPEG_BIN` / `OPENSSL_BIN` / `ZIP_BIN` / `UNZIP_BIN` | 同名命令 | 外部工具路径 |

更多设置（默认质量/格式、限速、超时、重试、主题、模块并发等）可在 **Web 设置页** 在线修改（存 SQLite）。

## 七、目录结构

```
ttdownload-web/
├── src/
│   ├── core/          # config / db(SQLite) / logger / disk(空间门控) / scheduler(统一队列) / events(SSE)
│   ├── modules/       # aria2Client / aria2 / transmission / webvideo(yt-dlp) / types
│   ├── services/      # crypto(VLT+AES) / archive / pipeline(归档→加密→发布) / cleanup / settings
│   ├── routes/        # system / tasks / aria2 / bt / webvideo / files / android
│   ├── app.ts         # Express 应用（含静态资源与 SPA 回退）
│   └── server.ts      # 启动入口（任务恢复 + 调度器 + 流水线）
├── web/               # React + TS + Vite + Tailwind 前端源码（构建产物输出到 public/）
├── test/              # 单元/集成/压力测试（node:test + mock aria2/transmission/yt-dlp）
├── docs/              # API.md（接口契约）、ARCHITECTURE.md（架构设计）
├── deploy.sh          # 一键部署脚本（Ubuntu + systemd）
├── Dockerfile / docker-compose.yml
└── 使用教程.md         # 完整使用教程（含安卓 App）
```

下载目录树（`DOWNLOAD_ROOT` 下）：

```
transmission/{btzhongzi_zip,btzhongzi_nodownd,btzhongzi_yijingdownding,downloads}
downd_aria2_path/            downd_web_tools/{,downdok}
downd_ok_p2/                 downd_ok_p2_jiami_tmp/
xiaofeizhe_downd/            state/{app.db,app.log,indexFXY}
```

## 八、API 文档

完整接口见 [`docs/API.md`](./docs/API.md)。常用：

```bash
curl -s localhost:8080/api/health                      # 健康检查
curl -s localhost:8080/api/stats                       # Dashboard 统计
curl -s -X POST localhost:8080/api/aria2/urls \
     -H 'Content-Type: application/json' \
     -d '{"urls":"http://example.com/a.mp4\nhttp://example.com/b.mp4"}'
curl -s -X POST localhost:8080/api/webvideo/parse \
     -H 'Content-Type: application/json' -d '{"url":"https://www.youtube.com/watch?v=xxx"}'
# 会员/需登录视频：上传自己账号的 cookies.txt，让下载能通过登录校验
curl -s -X POST localhost:8080/api/webvideo/cookies -F 'file=@cookies.txt'
curl -s localhost:8080/api/webvideo/cookies            # 查看是否已配置
curl -s localhost:8080/api/webvideo/attempts           # 预览会按哪些方式依次尝试
curl -s localhost:8080/api/webvideo/network?refresh=1   # 网络自检（DNS/YouTube/CDN/yt-dlp/RPC）
# 调试与日志
curl -s 'localhost:8080/api/system/logs?lines=200&marker=TASK_FAIL'
curl -s -X POST localhost:8080/api/system/debug -H 'Content-Type: application/json' -d '{"debugMode":true}'
curl -OJ localhost:8080/api/system/report              # 一键诊断报告 zip（发我排查用，推荐）
curl -s localhost:8080/api/system/report/list          # 页面上可下载的清单
curl -OJ 'localhost:8080/api/system/logs/export?level=warn'   # 只导出报错日志
curl -OJ localhost:8080/api/system/report/tasks?format=csv    # 任务清单 CSV
# 安卓（Token 鉴权）
curl -s -H "X-Auth-Token: $ANDROID_TOKEN" localhost:8080/api/android/files
curl -s -X POST -H "X-Auth-Token: $ANDROID_TOKEN" -H 'Content-Type: application/json' \
     -d '{"ids":[1]}' localhost:8080/api/android/done
```

## 九、测试

```bash
npm test          # 构建 + 全部测试（单元/集成/压力，使用 mock 外部工具，无需真装 aria2/transmission/yt-dlp）
npm run typecheck # 只做类型检查
```

测试覆盖：日志标记/脱敏/轮转、日志与诊断接口、网络自检、加密/V-L-T 兼容性、归档打包命名、归档→加密→发布流水线、
aria2/transmission/webvideo 三模块（含 JSON-RPC 与进程交互）、统一队列与磁盘门控、
任务恢复、REST/安卓 API（含 Range 断点续传、上报删除）、SSE、20 任务压力测试。

## 十、常见问题

| 现象 | 处理 |
| --- | --- |
| 前端页面 404 / 显示后端提示页 | 未构建前端：`npm run build:web`（或 `npm run build:all`） |
| BT 模块报“transmission 不可用” | 运行 `sudo bash deploy/ubuntutr.sh` 完成交互式安装配置，再 `sudo ./deploy.sh --restart`；`sudo ./deploy.sh --check-deps` 可先检查依赖 |
| BT 模块报 RPC 认证失败(401) | transmission 脚本默认开启密码认证：网页「设置 → transmission RPC」填 用户 `opengl` + 密码，或写 `.env` 的 `TRANSMISSION_RPC_USER/PASSWORD` |
| Chrome 登录了多个 Google 账号，该导哪个的 cookies | cookies.txt 按「浏览器 Profile + 域名」导出，代表该 Profile 的**主账号**；会员账号是次要账号时，请新建一个 Profile 只登录会员账号再导出（详见 `使用教程.md` §2.3.2.1） |
| 会员专享 / 需登录 / 年龄限制视频下载失败 | 程序已自动尝试多种客户端、长重试、降级等方式；仍失败时请到网页「设置 → 公开视频（yt-dlp）」**上传 cookies.txt**（用有权限的账号登录后导出，扩展名 `Get cookies.txt LOCALLY`），保存后点任务「重试」。详见 [`使用教程.md` §2.3](./使用教程.md) |
| 解析时报“会员专享”但还想下 | 页面会显示「解析受限（仍可下载）」+「仍然下载（自动多方式尝试）」按钮，直接加入队列即可；配上 cookies 成功率更高 |
| 公开视频解析报 yt-dlp 不存在 | `pip3 install -U yt-dlp` 或 `apt install -y yt-dlp`（设置页可测试连通性） |
| aria2 任务一直等待 | 磁盘可用空间低于保留值（默认 10GiB）→ 清理消费者目录或调小 `RESERVE_FREE_BYTES` |
| 想看看哪些 BT 任务会被出清 | `curl http://localhost:8080/api/bt/stale`（预览，不改数据）；Web「BT 种子」页也有「出清预览」 |
| 想给 yt-dlp 加代理/自定义参数 | 网页「设置 → 公开视频（yt-dlp）」的「额外参数」填 `--proxy socks5://127.0.0.1:1080`；也可用 `.env` 的 `YTDLP_EXTRA_ARGS` |
| 想立刻执行一次出清 | `curl -X POST http://localhost:8080/api/bt/evict`；Web「BT 种子」页「立即出清」 |
| 安卓 App 401 | `.env` 的 `ANDROID_TOKEN` 与 App 里填的 Token 不一致，或未配置 Token |
| 想在 PC 上解密发布文件 | 用 `openssl enc -d -aes-256-cbc -K $(printf %s "$密码" \| openssl dgst -sha256 -binary \| xxd -p -c256) -iv $(printf %s "$密码" \| openssl dgst -md5 -binary \| xxd -p -c256) -in <文件> -out out.bin`，再按 V-L-T 标记还原原始文件名（与老脚本 `all1.sh` 完全兼容） |

## 十一、许可证

MIT
