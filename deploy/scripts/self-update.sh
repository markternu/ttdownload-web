#!/usr/bin/env bash
# =============================================================================
#  ttdownload-web 自升级脚本（给「更新」页/开机自动更新用，不建议手动敲）
#
#  谁调用：services/updater.ts —— 它会先暂停正在下载的任务，再用 systemd-run
#          （没有 systemd 就用 setsid）把这个脚本拉起来，然后自己退出等重启。
#          用 systemd-run 的目的：让本脚本跑在**服务进程的 cgroup 之外**，
#          否则 systemctl restart 会把正在干活的脚本自己一起杀掉。
#
#  用法：
#      bash deploy/scripts/self-update.sh \
#           --repo /home/mypi/ttdownload-web \
#           --ref  <目标 commit（短 sha 即可）> \
#           --service ttdownload-web \
#           --log /ttdownload/state/update.log \
#           [--previous <回滚用的 commit>] [--no-restart]
#
#  做的事：git 拉取 → npm 依赖 → 构建后端 + 前端 → 重启服务 → 健康检查；
#          任何一步失败都**回滚到升级前的 commit 并重新构建**，保证服务能用旧版起来。
#          最终结果写进 <log 同目录>/update-result.json，页面会显示它。
#
#  ⚠️ 只管"代码级"升级（git/依赖/构建/重启）。涉及系统依赖（apt 包、systemd 单元、
#     nginx 配置）的大版本变更，仍然要人工执行 `sudo ./deploy.sh --update`。
# =============================================================================
set -uo pipefail

# ---------------------------------------------------------------- 参数
REPO=""
REF=""
SERVICE="ttdownload-web"
LOGFILE=""
PREVIOUS=""
NO_RESTART=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --log) LOGFILE="${2:-}"; shift 2 ;;
    --previous) PREVIOUS="${2:-}"; shift 2 ;;
    --no-restart) NO_RESTART=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$REPO" ]]; then
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO="$(cd "$REPO" && pwd)"
STATE_DIR="${TTDL_STATE_DIR:-}"
if [[ -z "$STATE_DIR" ]]; then
  # 状态目录：优先按 .env 里的 DOWNLOAD_ROOT 推导，退回落盘默认值
  ROOT_FROM_ENV="$(grep -E '^DOWNLOAD_ROOT=' "$REPO/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  STATE_DIR="${ROOT_FROM_ENV:-/ttdownload}/state"
fi
if [[ -z "$LOGFILE" ]]; then LOGFILE="${STATE_DIR}/update.log"; fi
RESULT_FILE="$(dirname "$LOGFILE")/update-result.json"
mkdir -p "$(dirname "$LOGFILE")" 2>/dev/null || true

say() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

# ------------------------------------------------- 把自己复制到 /tmp 再执行
# 因为下面 git reset --hard 会把本脚本文件本身换掉，而 bash 是边读边执行的
# （deploy.sh 里踩过：换掉自己会导致后续步骤被跳过）。复制到临时文件后，
# 无论仓库里怎么变，正在跑的这份都是稳定的。
if [[ -z "${TTDL_SELF_UPDATE_REEXEC:-}" ]]; then
  TMP_SELF="$(mktemp "${TMPDIR:-/tmp}/ttdl-self-update.XXXXXX.sh")"
  cp "${BASH_SOURCE[0]}" "$TMP_SELF"
  chmod +x "$TMP_SELF"
  export TTDL_SELF_UPDATE_REEXEC=1
  export TTDL_SELF_UPDATE_TMP="$TMP_SELF"
  exec bash "$TMP_SELF" "$@"
fi
trap 'rm -f "${TTDL_SELF_UPDATE_TMP:-}" 2>/dev/null || true' EXIT

# 全部输出同时进日志文件（页面会 tail 它）
exec >>"$LOGFILE" 2>&1
say "===== 开始自动升级 =====  repo=$REPO ref=${REF:-<远端默认>} service=$SERVICE"

# 并发保护：同一时间只允许一个升级在跑
LOCK_FILE="$(dirname "$LOGFILE")/update.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    say "已有一个升级在跑，本次退出（避免两个构建互相踩）"
    exit 3
  fi
fi

# ---------------------------------------------------------------- 属主
# 关键：仓库/依赖的属主是部署用户（例如 mypi），不是 root。用 root 跑 git/npm
# 会把产物变成 root 所有，之后 `sudo ./deploy.sh --update` 就会
# "insufficient permission for adding an object"（deploy.sh 里记过这个血案）。
REPO_OWNER="$(stat -c '%U' "$REPO" 2>/dev/null || echo root)"
as_owner() {
  if [[ "$REPO_OWNER" != "root" ]] && id "$REPO_OWNER" >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1; then sudo -u "$REPO_OWNER" -H "$@"; else runuser -u "$REPO_OWNER" -- "$@"; fi
  else
    "$@"
  fi
}
say "仓库属主：$REPO_OWNER（git/npm/构建都以它身份执行）"

# ---------------------------------------------------------------- 工具
GIT="git -c safe.directory=*"
cd "$REPO" || { say "进不去仓库目录 $REPO"; exit 1; }

OLD_SHA="$(as_owner $GIT rev-parse --short HEAD 2>/dev/null || echo '')"
OLD_VERSION="$(node -e "try{console.log(require('$REPO/package.json').version)}catch(e){console.log('unknown')}" 2>/dev/null || echo unknown)"
[[ -n "$PREVIOUS" ]] || PREVIOUS="$OLD_SHA"
say "升级前：$OLD_SHA（v$OLD_VERSION）"

write_result() { # ok from to fromSha toSha message rolledBack
  local ok="$1" from="$2" to="$3" fromsha="$4" tosha="$5" msg="$6" rolled="$7"
  cat >"$RESULT_FILE" <<EOF
{
  "ok": $ok,
  "fromVersion": $(json_str "$from"),
  "toVersion": $(json_str "$to"),
  "fromCommit": $(json_str "$fromsha"),
  "toCommit": $(json_str "$tosha"),
  "at": $(json_str "$(date -Iseconds 2>/dev/null || date '+%Y-%m-%dT%H:%M:%S%z')"),
  "message": $(json_str "$msg"),
  "rolledBack": $rolled
}
EOF
}
json_str() { # 最小 JSON 转义（不想依赖 jq）
  local s="${1//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"
  printf '"%s"' "$s"
}

service_alive() { systemctl is-active --quiet "$SERVICE" 2>/dev/null; }

restart_service() {
  if [[ $NO_RESTART -eq 1 ]]; then say "--no-restart：跳过重启"; return 0; fi
  if command -v systemctl >/dev/null 2>&1 && [[ -f "/etc/systemd/system/${SERVICE}.service" ]]; then
    say "重启服务：systemctl restart ${SERVICE}"
    systemctl restart "$SERVICE"
    return $?
  fi
  # 没有 systemd（比如 npm start 手跑）：杀掉旧进程后自己拉起来
  say "没有 systemd 单元，改用 pkill + nohup 重启"
  pkill -f "${REPO}/dist/server.js" 2>/dev/null || true
  sleep 2
  (cd "$REPO" && nohup "$(command -v node)" "$REPO/dist/server.js" >>"${STATE_DIR}/app.log" 2>&1 &)
  return 0
}

health_check() { # 等健康检查通过，最多 ~90 秒
  local port
  port="$(grep -E '^PORT=' "$REPO/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  port="${port:-8080}"
  local i
  for i in $(seq 1 45); do
    if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
      say "健康检查通过（第 ${i} 次，端口 ${port}）"
      return 0
    fi
    sleep 2
  done
  say "健康检查失败：90 秒内 http://127.0.0.1:${port}/api/health 一直不通"
  return 1
}

build_all() {
  say "安装后端依赖（npm ci / install）..."
  if [[ -f package-lock.json ]]; then
    as_owner npm ci --no-audit --no-fund || as_owner npm install --no-audit --no-fund || return 1
  else
    as_owner npm install --no-audit --no-fund || return 1
  fi
  say "构建后端（tsc）..."
  as_owner npm run build || return 1

  if [[ -f web/package.json ]]; then
    say "构建前端（vite）—— 先备份 public/，失败可回滚"
    WEB_BAK="public.selfupdate-bak.$$"
    rm -rf "$WEB_BAK"
    [[ -d public ]] && cp -a public "$WEB_BAK"
    # ⚠️ vite 的 outDir 是 ../public 且 emptyOutDir=true：构建一开始就清空 public/，
    #    失败就是白页。所以：内存上限 + 20 分钟硬超时 + 失败回滚（与 deploy.sh 一致）
    if (cd web && (as_owner npm ci --no-audit --no-fund || as_owner npm install --no-audit --no-fund) \
          && as_owner env NODE_OPTIONS="--max-old-space-size=2048" timeout 1200 npm run build); then
      if [[ ! -f public/index.html ]]; then
        say "前端构建结束但没有 public/index.html —— 回滚前端产物"
        rm -rf public; [[ -d "$WEB_BAK" ]] && mv "$WEB_BAK" public
        return 1
      fi
      rm -rf "$WEB_BAK"
      say "前端构建完成"
    else
      say "前端构建失败/超时（20 分钟）—— 回滚到构建前的 public/"
      rm -rf public; [[ -d "$WEB_BAK" ]] && mv "$WEB_BAK" public
      return 1
    fi
  fi
  return 0
}

# ---------------------------------------------------------------- 1. 拉取
say "git fetch --prune ${REF:+（目标 $REF）} ..."
if ! as_owner $GIT fetch --prune --tags; then
  say "git fetch 失败：网络/凭据问题？本次不升级，保持旧代码运行"
  write_result false "$OLD_VERSION" "$OLD_VERSION" "$OLD_SHA" "$OLD_SHA" "git fetch 失败（网络或凭据问题），未做任何改动" false
  exit 1
fi

TARGET="${REF:-origin/main}"
if ! as_owner $GIT rev-parse --verify --quiet "$TARGET^{commit}" >/dev/null; then
  say "目标 $TARGET 在本地不存在（远端没有这个提交？）—— 不升级"
  write_result false "$OLD_VERSION" "$OLD_VERSION" "$OLD_SHA" "$OLD_SHA" "目标提交 $TARGET 不存在" false
  exit 1
fi
NEW_SHA="$(as_owner $GIT rev-parse --short "$TARGET")"
if [[ "$NEW_SHA" == "$OLD_SHA" ]]; then
  say "已经就是目标提交 $NEW_SHA，无需升级"
  write_result true "$OLD_VERSION" "$OLD_VERSION" "$OLD_SHA" "$NEW_SHA" "已是最新提交" false
  exit 0
fi

say "切换到 $NEW_SHA ..."
if ! as_owner $GIT reset --hard "$TARGET"; then
  say "git reset --hard 失败 —— 不升级"
  write_result false "$OLD_VERSION" "$OLD_VERSION" "$OLD_SHA" "$OLD_SHA" "git reset 失败" false
  exit 1
fi
NEW_VERSION="$(node -e "try{console.log(require('$REPO/package.json').version)}catch(e){console.log('unknown')}" 2>/dev/null || echo unknown)"
say "目标版本：v$NEW_VERSION（$NEW_SHA）"

# ---------------------------------------------------------------- 2. 构建
if ! build_all; then
  say "构建失败 → 回滚到 $PREVIOUS（v$OLD_VERSION）"
  as_owner $GIT reset --hard "$PREVIOUS" || say "回滚 git reset 也失败了，请手动处理"
  build_all || say "回滚后构建仍失败：服务可能起不来，请手动执行 sudo ./deploy.sh --update"
  restart_service || true
  write_result false "$OLD_VERSION" "$NEW_VERSION" "$OLD_SHA" "$NEW_SHA" "构建失败，已回滚到 v$OLD_VERSION" true
  say "===== 升级失败（已回滚）====="
  exit 1
fi

# ---------------------------------------------------------------- 3. 重启 + 健康检查
if ! restart_service; then
  say "重启服务失败 → 回滚到 $PREVIOUS"
  as_owner $GIT reset --hard "$PREVIOUS" || true
  build_all || true
  restart_service || true
  write_result false "$OLD_VERSION" "$NEW_VERSION" "$OLD_SHA" "$NEW_SHA" "重启服务失败，已回滚" true
  exit 1
fi

if ! health_check; then
  say "新版起不来 → 回滚到 $PREVIOUS（v$OLD_VERSION）"
  as_owner $GIT reset --hard "$PREVIOUS" || say "回滚 git reset 失败"
  build_all && restart_service && health_check \
    && say "已回滚并恢复服务（v$OLD_VERSION）" \
    || say "回滚后仍不健康：请手动执行 sudo ./deploy.sh --update 排查"
  write_result false "$OLD_VERSION" "$NEW_VERSION" "$OLD_SHA" "$NEW_SHA" "升级后健康检查失败，已回滚到 v$OLD_VERSION" true
  say "===== 升级失败（已回滚）====="
  exit 1
fi

write_result true "$OLD_VERSION" "$NEW_VERSION" "$OLD_SHA" "$NEW_SHA" "升级成功：v$OLD_VERSION → v$NEW_VERSION" false
say "===== 升级成功：v$OLD_VERSION → v$NEW_VERSION（$NEW_SHA）====="
exit 0
