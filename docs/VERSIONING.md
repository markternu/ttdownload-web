# 版本规范（SemVer）与自动更新

> 用户硬要求（原话）：**「对于 nodejs 本次以及后续开发都要版本号规范化，要用行业标准 Vx.x.x 三位来表示，每一位都有规范的意义。」**
> 这份文档就是那条规矩的落地说明。**改代码的人每次发布都必须遵守。**

---

## 1. 版本号长什么样

```
v 主版本 . 次版本 . 修订号
  MAJOR    MINOR    PATCH
  不兼容    新功能    修 bug
```

| 位置 | 名字 | 什么时候 +1 | 例子 |
| --- | --- | --- | --- |
| 第 1 位 | **MAJOR（主版本）** | **不兼容变更**：需要迁移数据/配置、老机器必须人工做点什么才能升（换 Node 大版本、改目录结构、删掉某个接口）、或者行为契约变了 | 把 BT 计时口径从"墙上时钟"改成"实际运行时长"并重置老任务计时 |
| 第 2 位 | **MINOR（次版本）** | **向后兼容的新功能**：新页面、新接口、新配置项、新的自动化能力 | 新增「更新」页 + 自动更新机制；新增 U 盘自动挂载 |
| 第 3 位 | **PATCH（修订号）** | **向后兼容的修 bug / 性能 / 文案 / 文档** | 修掉"断电重启后 BT 显示 140 小时"；修掉按钮不弹密码框 |

规则（照抄 [SemVer 2.0.0](https://semver.org/lang/zh-CN/) 的关键几条）：

1. **三位都要写全**：`1.1.0`，不是 `1.1`，也不是 `v1.1`（页面展示时前面加 `v`，仓库里存的是 `1.1.0`）。
2. **只要有改动就要抬**。修个 bug 只想抬 PATCH 也行，但**不允许改了代码不抬版本**——服务器认版本号决定要不要升级。
3. **MAJOR 归零**：抬了 MAJOR，MINOR 和 PATCH 必须归 0（`1.4.2` 的不兼容变更 → `2.0.0`）。
4. **预发布**用后缀：`1.2.0-beta.1`（比 `1.2.0` 小，不会自动升到正式版之前）。
5. 已经发布的版本号**绝不重用**（发错了就往上抬，不要改回去）。

---

## 2. 版本号写在哪（唯一来源）

- **唯一来源：`package.json` 的 `version` 字段。**
- 后端运行时通过 `src/core/version.ts::readPackageVersion()` 读它，暴露成 `config.version`
  （日志启动横幅、`/api/health`、`/api/system`、前端「更新」页显示的都是它）。
- ⚠️ **不要在别处再写一份版本号**。以前 `src/core/config.ts` 里写死过 `'1.0.0'`，
  和 `package.json` 成了两份，改一处忘一处 —— 现在只保留 package.json 这一份。
- `web/package.json` 的版本是前端子包的构建版本，**不参与**发布判定（别混）。
- 抬版本时 **`package-lock.json` 顶部的两处 `version` 要跟着改**（`npm install` 也会自动同步）。

发布 checklist：

```bash
cd github/ttdownload-web
# 1) 抬版本（按上面的表判断抬哪一位）
#    package.json 与 package-lock.json 顶部两处一起改
# 2) 构建 + 跑测试
npm run build && npm run test:only && npm run test:browser
# 3) 提交 + 打 tag（tag 就是"这是一次发布"的标记，和 package.json 版本保持一致）
git commit -am "feat(xxx): ... (v1.1.0)"
git tag -a v1.1.0 -m "v1.1.0"
git push origin main --tags
```

---

## 3. 自动更新怎么用版本号做判断

实现：`src/services/updater.ts`（后端）、`src/routes/update.ts`（接口）、`web/src/pages/UpdatePage.tsx`（页面）、
`deploy/scripts/self-update.sh`（真正干活的升级脚本）。

判断逻辑（简单到可以背下来）：

```
拉远端 package.json 的 version  →  latest
本地 package.json 的 version     →  current
compareSemVer(latest, current) > 0   →  有新版本，自动升级
否则                                  →  不动（页面会提示"远端有新提交但版本号没抬"）
```

- **版本号一样但远端有新提交**：不自动升级（防止把没发布的半成品推上线）。页面会明确提示，
  确实想装可以点「立即更新」强制装最新提交。
- **MAJOR 升级**：按用户 2026-10 的决定 **也自动升**；但页面和日志会明确标出
  「这是大版本升级，可能有不兼容变更」，升级前的确认弹窗会写清楚。
- **换更新源**：改 `.env` 的 `UPDATE_REMOTE` / `UPDATE_BRANCH` 即可（默认 `origin` / `main`）。

### 开机与定时行为（用户明确要求）

| 时机 | 行为 |
| --- | --- |
| 开机启动 | **先启动服务**（永远用本地代码把服务拉起来），启动后 `UPDATE_BOOT_DELAY_SEC`（默认 20 秒）再做第一次检查 |
| 开机第一次检查 | 失败会重试 `UPDATE_BOOT_RETRIES` 次（默认 3 次，间隔 15 秒）；**全都失败就直接用本地老代码继续跑**，只记一条日志 |
| 运行期间 | 每 `UPDATE_INTERVAL_MIN`（默认 60 分钟）检查一次，发现版本更高就自动升级 |
| 页面 | 「更新」页可以随时点「检查更新 / 立即更新」，也能开关自动更新、改进检查间隔 |

> ⚠️ 开机拉取**绝不能挡住启动**：更新检查永远在 `server.listen()` 成功之后才启动
> （见 `src/server.ts`）。网络不通、GitHub 抽风、远端删库，服务都必须照常起来。

### 升级时怎么保护下载任务（用户明确要求）

1. 先**暂停**：`torrent-stop` 正在下的 BT 种子、`aria2.pause` 正在下的直链任务；
   写一份恢复计划 `state/update-resume.json`。
   - 关键设计：**只暂停底层下载器，不动数据库里的任务状态**。这样即使升级失败回滚到老代码，
     重启时的 `recoverTasks()` 也会把任务重新排队继续下（老代码没有"恢复被升级暂停的任务"逻辑，
     改状态的话任务会永远卡在暂停）。
2. 拉代码 → `npm ci` → 构建后端 → 构建前端 → 重启服务（`deploy/scripts/self-update.sh`）。
3. 重启后：`startUpdateWorker()` 一进来就 `resumeAfterUpdate()` —— 把刚才停掉的种子/任务重新开起来。
4. 任何一步失败 → **自动回滚到升级前的 commit 并重新构建**，保证服务能用旧版起来，
   结果写进 `state/update-result.json` 显示在「更新」页。

### 升级起不来时怎么办（2026-10-08 真机事故的教训）

现场：日志里 `repo=/`、`git fetch` 报 not a git repository，而且**每 30 秒重复一次**。
两个根因（都已修，并各配了会红的回归测试 `test/self-update-script.test.mjs`）：

1. **脚本把仓库路径认成了 `/`**：脚本会把自己复制到 `/tmp` 再执行（防止 `git reset`
   换掉正在跑的脚本），而仓库路径的默认值是 `dirname($0)/../..` —— re-exec 之后
   `$0` 指向 `/tmp/xxx.sh`，`../..` 就是 `/`。再加上 `systemd-run` 在某些版本会把命令
   后面的 `--repo/--ref` 当成它自己的参数吃掉（脚本收到 0 个参数），两个问题叠在一起就炸了。
   现在：**re-exec 之前**解析好仓库路径、用环境变量传下去；程序调用时也**同时**用
   env 传一份；`systemd-run` 命令前加 `--`；脚本日志里打印完整 argv 与配置来源。
2. **失败后每次开机都重试**（死循环：升级→退出→systemd 重启→又发现新版本→又升级）。
   现在：同一个目标失败后进入冷却期（`UPDATE_RETRY_COOLDOWN_MIN`，默认 30 分钟），
   冷却期内不再自动重试；**手动点「立即更新」或执行下面的命令不受冷却限制**。

兜底命令（网页「更新」页有「复制命令」按钮，一键复制的就是它）：

```bash
cd ~/ttdownload-web && sudo ./deploy.sh --update
```

### 升级脚本的边界（重要）

`deploy/scripts/self-update.sh` 只管**代码级**升级（git / npm 依赖 / 构建 / 重启 / 回滚）。
涉及**系统级**变更的发布（apt 装新包、改 systemd 单元、改 nginx 配置、换 Node 大版本），
必须人工执行一次：

```bash
cd ~/ttdownload-web && sudo ./deploy.sh --update
```

所以：**MAJOR 版本如果动了系统依赖，请在 CHANGELOG/commit message 里显式写
"需要手动 sudo ./deploy.sh --update"**。

---

## 4. 相关文件与状态文件

| 路径 | 作用 |
| --- | --- |
| `src/core/version.ts` | SemVer 解析/比较、读 package.json 的版本 |
| `src/core/clock.ts` | 时间源（墙上时钟 vs 单调时钟，见"断电计时"事故说明） |
| `src/services/updater.ts` | 检查/暂停/升级/恢复/定时线程 |
| `src/routes/update.ts` | `/api/update/status|check|apply|log|settings` |
| `deploy/scripts/self-update.sh` | 外部升级脚本（跑在服务 cgroup 之外，可回滚） |
| `web/src/pages/UpdatePage.tsx` | 「更新」页面 |
| `$DOWNLOAD_ROOT/state/update-status.json` | 后端写的当前/上次检查状态 |
| `$DOWNLOAD_ROOT/state/update-result.json` | 升级脚本写的上次升级结果 |
| `$DOWNLOAD_ROOT/state/update-resume.json` | 升级前暂停了哪些下载（恢复用，恢复完删除） |
| `$DOWNLOAD_ROOT/state/update.log` | 升级全过程日志（页面可查看） |
