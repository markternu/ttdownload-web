#!/usr/bin/env bash
# =============================================================================
#  ttdownload-web 一键部署脚本
#  支持：Ubuntu 20.04/22.04/24.04（推荐）、Debian 12/13、树莓派 OS（Raspberry Pi OS，已在 Pi 4B 实测）
#        Ubuntu 18.04 可用但 yt-dlp 模块可能不可用（系统 Python 太旧）
#
#  前置条件：可 sudo 的账号、systemd、能访问外网（apt 源 / NodeSource / npm / GitHub）。
#  其它系统依赖（Node、aria2、transmission、yt-dlp、ffmpeg、openssl、zip/unzip、jq、
#  build-essential + python3）全部由本脚本负责安装，无需预先准备。
#
#  用法（在项目根目录执行）：
#      sudo ./deploy.sh              # 完整部署：装依赖 -> 建目录 -> 构建 -> systemd 启动 -> 自检
#      sudo ./deploy.sh --no-apt     # 跳过 apt 安装（依赖已就绪时）
#      sudo ./deploy.sh --skip-web   # 跳过前端构建（用已构建好的 public/）
#      sudo ./deploy.sh --port 8080  # 指定端口
#      sudo ./deploy.sh --root /ttdownload
#      sudo ./deploy.sh --check-deps # 只检查依赖（aria2/transmission/node/yt-dlp 等）是否已安装，不做任何改动
#      sudo ./deploy.sh --update     # 【已部署过】拉取最新代码 + 重新构建 + 重启（最常用）
#      sudo ./deploy.sh --status     # 查看服务状态
#      sudo ./deploy.sh --restart    # 重启服务
#      sudo ./deploy.sh --stop       # 停止服务（不删除任何数据）
#      sudo ./deploy.sh --start      # 启动服务
#      sudo ./deploy.sh --logs       # 查看最近日志（默认 200 行；--logs 500 可指定行数）
#      sudo ./deploy.sh --logs-follow# 实时跟踪日志（Ctrl+C 退出）
#      sudo ./deploy.sh --collect    # 【服务起不来也能用】离线打包日志到当前目录，发给开发者排查
#      sudo ./deploy.sh --check-ports# 端口可达性体检（本机监听/防火墙/公网是否真的能访问）
#      sudo ./deploy.sh --proxy      # 用 nginx 把 http://IP/ttdownload/ 反代到本服务（8080 外网不通时用）
#      sudo ./deploy.sh --proxy --proxy-path /dl   # 自定义子路径
#
#  环境问题自检/修复脚本（可在网页「修复脚本」页上传执行，也可 sudo bash 直接跑）：
#      deploy/scripts/diagnose-env.sh   只读体检（Node/aria2/transmission/yt-dlp/DNS/磁盘/服务）
#      deploy/scripts/fix-node20.sh     Node 升级到 20 并重建依赖、重启服务（幂等）
#      sudo ./deploy.sh --uninstall  # 停止并移除 systemd 服务（保留数据目录）
#
#  脚本做的事：
#    1) 安装系统依赖：Node.js（目标 20；仅老 Ubuntu 退回 18）、aria2、yt-dlp、ffmpeg、openssl、zip/unzip、jq、
#       build-essential/python3；transmission 缺失时改用工程自带 deploy/ubuntutr.sh 交互安装
#    2) 创建下载目录树（三大模块/归档/加密/消费者目录）
#    3) 安装 npm 依赖并构建前端 + 后端
#    4) 生成 .env（保留已有配置，不覆盖密码/token）
#    5) ufw 放行端口 -> 注册 systemd 服务并启动 -> 健康检查
# =============================================================================
set -euo pipefail

# 部署机上不跑浏览器测试：跳过 playwright 的浏览器下载（省几百 MB 空间与构建时间）
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export npm_config_playwright_skip_browser_download=1

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="ttdownload-web"
# 仓库属主：sudo 部署时以它身份执行 git/npm/构建，避免产物变成 root 所有
REPO_OWNER="$(stat -c '%U' "$PROJECT_DIR" 2>/dev/null || echo root)"
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" && -d "/home/${SUDO_USER}" ]]; then
  REPO_OWNER="${SUDO_USER}"
fi
as_owner() {
  if [[ "${REPO_OWNER}" != "root" ]] && id "${REPO_OWNER}" >/dev/null 2>&1; then
    sudo -u "${REPO_OWNER}" -H "$@"
  else
    "$@"
  fi
}
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
PORT="${PORT:-8080}"
DOWNLOAD_ROOT="${DOWNLOAD_ROOT:-/ttdownload}"
SKIP_APT=0
SKIP_WEB=0
ACTION="deploy"
LOG_LINES=200
ORIGINAL_ARGS=("$@")   # git pull 后要用新脚本重新执行同样的参数
PROXY_PATH="${PROXY_PATH:-/ttdownload}"

DEPLOY_LOG_DIR="${DOWNLOAD_ROOT}/state/logs"
DEPLOY_LOG="${DEPLOY_LOG_DIR}/deploy.log"
if mkdir -p "$DEPLOY_LOG_DIR" 2>/dev/null; then
  # 让脚本的全部输出同时进日志文件（排查部署问题时可直接把这个文件发出来）
  exec > >(tee -a "$DEPLOY_LOG") 2>&1
  printf '\n===== %s 执行 deploy.sh %s =====\n' "$(date '+%F %T')" "$*" >>"$DEPLOY_LOG" 2>/dev/null || true
fi

# 生成 16 位随机密码（只用字母数字，避免 .env/shell/URL 转义问题）
gen_password() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16; }

log()  { printf '\033[1;32m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-apt) SKIP_APT=1; shift ;;
    --skip-web) SKIP_WEB=1; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --root) DOWNLOAD_ROOT="$2"; shift 2 ;;
    --check-deps) ACTION="check-deps"; shift ;;
    --update) ACTION="update"; shift ;;
    --status) ACTION="status"; shift ;;
    --restart) ACTION="restart"; shift ;;
    --stop) ACTION="stop"; shift ;;
    --start) ACTION="start"; shift ;;
    --logs) ACTION="logs"; shift; if [[ $# -gt 0 && "$1" =~ ^[0-9]+$ ]]; then LOG_LINES="$1"; shift; fi ;;
    --logs-follow) ACTION="logs-follow"; shift ;;
    --collect) ACTION="collect"; shift ;;
    --check-ports) ACTION="check-ports"; shift ;;
    --proxy) ACTION="proxy"; shift ;;
    --proxy-path) PROXY_PATH="$2"; shift 2 ;;
    --uninstall) ACTION="uninstall"; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "未知参数: $1（--help 查看用法）" ;;
  esac
done

if [[ $EUID -ne 0 && "$ACTION" != "check-deps" && "$ACTION" != "logs" && "$ACTION" != "logs-follow" && "$ACTION" != "collect" && "$ACTION" != "check-ports" ]]; then
  die "请用 root 运行：sudo ./deploy.sh（仅 --check-deps 可以在普通用户下运行）"
fi

# ---------------------------------------------------------------- 依赖检查/安装（ARIA2 + TRANSMISSION）
#  说明：
#   - aria2：未安装则 `apt install -y aria2`；已安装则跳过；
#   - transmission：**必须**使用随工程附带的 deploy/ubuntutr.sh 安装（脚本内交互原样保留），
#     已安装则跳过，不做任何改动。
BT_INSTALLER="${PROJECT_DIR}/deploy/ubuntutr.sh"

have_cmd() { command -v "$1" >/dev/null 2>&1; }

detect_node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

# 是否具备交互条件（有 TTY；DEPLOY_ASSUME_TTY=1 用于自动测试模拟）
prompt_ok() {
  [[ "${DEPLOY_ASSUME_TTY:-0}" == "1" ]] && return 0
  [[ -t 0 ]] && return 0
  { true </dev/tty; } 2>/dev/null
}

# 读取用户输入（自动处理有无 TTY 的情况）：read_prompt <变量名> <提示语>
read_prompt() {
  local __var="$1" __prompt="$2" __val=""
  if [[ "${DEPLOY_ASSUME_TTY:-0}" == "1" ]] || [[ -t 0 ]]; then
    IFS= read -r -p "$__prompt" __val || __val=""
  else
    IFS= read -r -p "$__prompt" __val </dev/tty 2>/dev/null || __val=""
  fi
  printf -v "$__var" '%s' "$__val"
}

# 运行 transmission 交互安装脚本（保证 stdin 来自终端，提问可正常输入）
run_bt_installer() {
  if [[ "${DEPLOY_ASSUME_TTY:-0}" == "1" ]] || [[ -t 0 ]]; then
    bash "$BT_INSTALLER"
  else
    bash "$BT_INSTALLER" </dev/tty
  fi
}

aria2_installed() { have_cmd aria2c; }
# 注意：后端只用 transmission 的 JSON-RPC，不需要 transmission-remote；
# 因此这里只以 transmission-daemon 是否存在为准 —— 否则已有配置的 transmission 会被
# deploy/ubuntutr.sh 重新安装（该脚本会 purge 旧配置与 /var/lib/transmission-daemon）。
transmission_installed() { have_cmd transmission-daemon; }

print_dep_status() {
  echo "依赖检查结果："
  if aria2_installed; then echo "  ✓ aria2       已安装（$(aria2c --version 2>/dev/null | head -1)）"; else echo "  ✗ aria2       未安装（部署时会 apt install）"; fi
  if transmission_installed; then
    echo "  ✓ transmission 已安装（transmission-daemon，后端走 JSON-RPC）"
  else
    echo "  ✗ transmission 未安装（部署时会调用 deploy/ubuntutr.sh 交互式安装配置）"
  fi
  have_cmd jq       && echo "  ✓ jq          已安装"       || echo "  ✗ jq          未安装（transmission 安装脚本会一并安装）"
  have_cmd openssl  && echo "  ✓ openssl     已安装"       || echo "  ✗ openssl     未安装（加密功能必需）"
  if have_cmd yt-dlp; then
    echo "  ✓ yt-dlp      $(yt-dlp --version 2>/dev/null)"
    if pip3 show yt-dlp-ejs >/dev/null 2>&1; then echo "  ✓ yt-dlp-ejs  已安装（n challenge 求解脚本）"; else echo "  ✗ yt-dlp-ejs  未安装 → YouTube 会报 No video formats found（部署时会自动补）"; fi
    if js_runtime_available; then echo "  ✓ JS 运行时   $( { deno --version 2>/dev/null | head -1; } || { node -v; } )"; else echo "  ✗ JS 运行时   缺失（deno/bun/quickjs/node>=22）→ YouTube 一定失败（部署时会自动装 deno）"; fi
  else
    echo "  ✗ yt-dlp      未安装（公开视频模块需要）"
  fi
  have_cmd ffmpeg   && echo "  ✓ ffmpeg      已安装"       || echo "  ✗ ffmpeg      未安装（视频合并需要）"
  if have_cmd node; then
    NODE_MAJ="$(detect_node_major || echo 0)"
    if [[ "${NODE_MAJ:-0}" -ge 20 ]]; then
      echo "  ✓ node        $(node -v)"
    elif [[ "${NODE_MAJ:-0}" -ge 18 ]]; then
      echo "  ! node        $(node -v)（低于 20，部署时会升级到 Node 20；旧版 Ubuntu 会保留 18）"
    else
      echo "  ✗ node        $(node -v)（低于 18，部署时会升级）"
    fi
  else
    echo "  ✗ node        未安装（部署时会装 NodeSource Node 20）"
  fi
  have_cmd npm      && echo "  ✓ npm         $(npm -v 2>/dev/null | head -1)"    || echo "  ✗ npm         未安装"
  if have_cmd make && have_cmd g++ && have_cmd python3; then
    echo "  ✓ 编译工具链   make/g++/python3 齐全（better-sqlite3 兜底编译需要）"
  else
    echo "  ✗ 编译工具链   缺 make/g++/python3（部署时会装 build-essential python3）"
  fi
  if [ -r /etc/os-release ]; then
    echo "  · 系统        $(. /etc/os-release; echo "${PRETTY_NAME:-unknown}")"
  fi
  echo
}

# aria2：没有才装（apt 直接安装）
ensure_aria2() {
  if aria2_installed; then
    log "aria2 已安装（$(aria2c --version 2>/dev/null | head -1)），跳过安装"
    return 0
  fi
  log "未检测到 aria2，开始安装：apt-get install -y aria2"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y >/dev/null 2>&1 || true
  if ! apt-get install -y aria2; then
    warn "aria2 安装失败（aria2 模块将不可用；可稍后手动 apt install -y aria2）"
    return 1
  fi
  log "aria2 安装完成：$(aria2c --version 2>/dev/null | head -1)"
  return 0
}

# transmission：没装则必须用工程自带脚本安装（交互提示原样保留，供用户输入白名单/密码等）
ensure_transmission() {
  if transmission_installed; then
    log "transmission 已安装（transmission-daemon），跳过安装（不做任何改动）"
    return 0
  fi
  if [[ ! -f "$BT_INSTALLER" ]]; then
    warn "未找到 transmission 安装脚本：$BT_INSTALLER（transmission 模块将不可用）"
    return 1
  fi
  if ! prompt_ok; then
    warn "当前环境没有可用终端（非交互执行），无法运行需要输入信息的 transmission 安装脚本。"
    warn "请稍后手动执行：sudo bash ${BT_INSTALLER}"
    warn "执行完再运行：sudo ./deploy.sh --restart"
    return 1
  fi
  log "未检测到 transmission，开始运行官方安装配置脚本：deploy/ubuntutr.sh"
  log "（该脚本会进行交互式提问：IP 白名单、RPC 登录密码等，请按提示输入）"
  echo
  if ! run_bt_installer; then
    warn "transmission 安装脚本执行失败（可稍后手动：sudo bash deploy/ubuntutr.sh）"
    return 1
  fi
  echo
  log "transmission 安装脚本执行完成"
  return 0
}

# 把 transmission RPC 凭据写入 .env（安装脚本里设置的用户名固定 opengl，密码由用户输入）
configure_transmission_env() {
  have_cmd transmission-daemon || return 0
  local user password
  user="$(grep -E '^TRANSMISSION_RPC_USER=' .env 2>/dev/null | cut -d= -f2-)"
  password="$(grep -E '^TRANSMISSION_RPC_PASSWORD=' .env 2>/dev/null | cut -d= -f2-)"
  [[ -n "$user" ]] || user="opengl"
  # 用户名先落盘（安装脚本固定用 opengl），密码允许稍后在网页「设置」里补
  if grep -q '^TRANSMISSION_RPC_USER=' .env; then
    sed -i "s#^TRANSMISSION_RPC_USER=.*#TRANSMISSION_RPC_USER=${user}#" .env
  else
    echo "TRANSMISSION_RPC_USER=${user}" >> .env
  fi
  if [[ -n "$password" ]]; then
    log "transmission RPC 凭据已在 .env 中配置（用户 $user）"
    return 0
  fi
  if prompt_ok; then
    local input=""
    echo
    read_prompt input "请输入刚才在 transmission 安装脚本里设置的 RPC 密码（用户 $user，直接回车可跳过，稍后可在网页「设置」里填）: "
    if [[ -n "$input" ]]; then
      # 更新 .env
      if grep -q '^TRANSMISSION_RPC_PASSWORD=' .env; then
        sed -i "s#^TRANSMISSION_RPC_PASSWORD=.*#TRANSMISSION_RPC_PASSWORD=${input}#" .env
      else
        echo "TRANSMISSION_RPC_PASSWORD=${input}" >> .env
      fi
      if grep -q '^TRANSMISSION_RPC_USER=' .env; then
        sed -i "s#^TRANSMISSION_RPC_USER=.*#TRANSMISSION_RPC_USER=${user}#" .env
      else
        echo "TRANSMISSION_RPC_USER=${user}" >> .env
      fi
      chmod 600 .env
      log "transmission RPC 凭据已写入 .env（BT 模块可直接使用）"
    else
      warn "已跳过写入；请稍后在网页「设置 → 网络设置 → transmission RPC」里填写用户名/密码"
    fi
  else
    warn "非交互环境：请稍后在网页「设置」里填写 transmission RPC 用户名($user)/密码，或手动写入 .env"
  fi
}


# -------------------------------------------------------------------------------- yt-dlp 全家桶
#  YouTube 现在必须解 n challenge：需要
#    (a) yt-dlp 本体；(b) yt-dlp-ejs 挑战求解脚本；(c) 一个受支持的 JS 运行时（deno/bun/quickjs 或 node>=22）
#  三者缺一就会报 "No video formats found!" / "The page needs to be reloaded."，看起来像网络问题。
#  这里做多重兜底，并在最后如实汇报状态（幂等，可重复执行）。

js_runtime_available() {
  command -v deno >/dev/null 2>&1 && return 0
  command -v bun >/dev/null 2>&1 && return 0
  command -v qjs >/dev/null 2>&1 && return 0
  command -v node >/dev/null 2>&1 && [[ "$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)" -ge 22 ]] && return 0
  return 1
}

install_js_runtime() {
  js_runtime_available && { log "JS 运行时已就绪：$( { deno --version 2>/dev/null | head -1; } || { bun --version 2>/dev/null; } || { node -v; } )"; return 0; }

  log "安装 JS 运行时（yt-dlp 解 YouTube n challenge 必需）..."
  # ① 官方安装脚本（deno.land）
  if DENO_INSTALL=/usr/local curl -fsSL https://deno.land/install.sh | sh -s -- -y >/dev/null 2>&1; then
    ln -sf /usr/local/bin/deno /usr/bin/deno 2>/dev/null || true
    log "deno 已安装：$(deno --version 2>/dev/null | head -1)"
    return 0
  fi
  warn "deno.land 安装失败，改用 GitHub release"

  # ② GitHub release（按架构）
  case "$(uname -m)" in
    aarch64|arm64) DENO_ASSET="deno-aarch64-unknown-linux-gnu.zip" ;;
    x86_64|amd64)  DENO_ASSET="deno-x86_64-unknown-linux-gnu.zip" ;;
    *)             DENO_ASSET="" ;;
  esac
  if [[ -n "$DENO_ASSET" ]] && curl -fL --retry 2 -o /tmp/deno.zip "https://github.com/denoland/deno/releases/latest/download/${DENO_ASSET}" >/dev/null 2>&1; then
    if command -v unzip >/dev/null 2>&1; then unzip -o -q /tmp/deno.zip -d /usr/local/bin; else python3 -c "import zipfile;zipfile.ZipFile('/tmp/deno.zip').extractall('/usr/local/bin')"; fi
    chmod +x /usr/local/bin/deno 2>/dev/null || true
    ln -sf /usr/local/bin/deno /usr/bin/deno 2>/dev/null || true
    rm -f /tmp/deno.zip
    if command -v deno >/dev/null 2>&1; then log "deno 已安装（GitHub release）：$(deno --version 2>/dev/null | head -1)"; return 0; fi
  fi
  warn "GitHub release 也失败，尝试发行版仓库的 quickjs"

  # ③ 发行版仓库的 quickjs（体积小、apt 直装）
  if apt-get install -y quickjs >/dev/null 2>&1 && command -v qjs >/dev/null 2>&1; then
    log "quickjs 已安装：$(qjs --version 2>&1 | head -1)"
    return 0
  fi

  # ④ npm 上的 deno 包（有些环境只有 npm 通）
  if command -v npm >/dev/null 2>&1 && npm install -g deno >/dev/null 2>&1 && command -v deno >/dev/null 2>&1; then
    log "deno 已通过 npm 安装：$(deno --version 2>/dev/null | head -1)"
    return 0
  fi

  warn "❌ 未能安装任何 JS 运行时：YouTube 下载会报 No video formats found!"
  warn "   请稍后执行：sudo bash deploy/scripts/fix-ytdlp.sh（或手动装 deno：https://deno.com/）"
  return 1
}

ensure_ytdlp_ejs() {
  command -v yt-dlp >/dev/null 2>&1 || return 1
  pip3 show yt-dlp-ejs >/dev/null 2>&1 && return 0
  log "安装 yt-dlp-ejs（n challenge 求解脚本）..."
  apt-get install -y python3-pip >/dev/null 2>&1 || true
  pip3 install -U "yt-dlp[default]" >/dev/null 2>&1 \
    || pip3 install -U --break-system-packages "yt-dlp[default]" >/dev/null 2>&1 \
    || pip3 install -U --break-system-packages yt-dlp-ejs >/dev/null 2>&1 || true
  pip3 show yt-dlp-ejs >/dev/null 2>&1
}

ensure_ytdlp_stack() {
  # yt-dlp 本体：pip[default] → apt → 官方二进制
  if ! command -v yt-dlp >/dev/null 2>&1; then
    log "安装 yt-dlp ..."
    apt-get install -y python3-pip >/dev/null 2>&1 || true
    if pip3 install -U "yt-dlp[default]" >/dev/null 2>&1 \
      || pip3 install -U --break-system-packages "yt-dlp[default]" >/dev/null 2>&1 \
      || apt-get install -y yt-dlp >/dev/null 2>&1; then
      :
    elif curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp; then
      chmod +x /usr/local/bin/yt-dlp
    else
      warn "yt-dlp 安装失败（公开视频模块将不可用；可稍后跑 deploy/scripts/fix-ytdlp.sh）"
    fi
  fi
  ensure_ytdlp_ejs || warn "yt-dlp-ejs 未装上（YouTube 会报 No video formats found；可跑 deploy/scripts/fix-ytdlp.sh）"
  install_js_runtime || true

  # 如实汇报（这行会出现在部署日志与「网络自检」里）
  local ytv ejs js
  ytv="$(yt-dlp --version 2>/dev/null || echo 未安装)"
  ejs="$(pip3 show yt-dlp-ejs 2>/dev/null | awk -F': ' '/^Version/{print $2}' || true)"
  js="$( { deno --version 2>/dev/null | head -1; } || { bun --version 2>/dev/null; } || { qjs --version 2>&1 | head -1; } || { node -v 2>/dev/null; } )"
  log "公开视频依赖：yt-dlp ${ytv}｜yt-dlp-ejs ${ejs:-缺失}｜JS 运行时 ${js:-缺失}"
  if [[ -z "${ejs}" ]] || [[ -z "${js}" ]]; then
    warn "⚠️  公开视频（YouTube）可能仍失败：缺 yt-dlp-ejs 或 JS 运行时 → 稍后执行 sudo bash deploy/scripts/fix-ytdlp.sh"
  else
    log "✅ YouTube 下载依赖齐全（yt-dlp + ejs + JS 运行时）"
  fi
}

# ---------------------------------------------------------------- 已部署后的管理动作
case "$ACTION" in
  check-deps)
    print_dep_status
    exit 0 ;;
  stop)
    log "停止服务 ${SERVICE_NAME} ..."
    systemctl stop "$SERVICE_NAME" || true
    systemctl status "$SERVICE_NAME" --no-pager | head -8 || true
    log "已停止（数据目录 ${DOWNLOAD_ROOT} 未改动；重新启动：sudo ./deploy.sh --start）"
    exit 0 ;;
  start)
    log "启动服务 ${SERVICE_NAME} ..."
    systemctl start "$SERVICE_NAME"
    sleep 2
    systemctl status "$SERVICE_NAME" --no-pager | head -8 || true
    curl -fsS "http://127.0.0.1:${PORT}/api/health" && echo || warn "健康检查失败，看日志：sudo ./deploy.sh --logs"
    exit 0 ;;
  logs)
    APP_LOG="${DOWNLOAD_ROOT}/state/app.log"
    log "最近 ${LOG_LINES} 行日志（文件：${APP_LOG}）"
    if [[ -f "$APP_LOG" ]]; then
      tail -n "$LOG_LINES" "$APP_LOG"
    else
      warn "还没有应用日志文件，改用 systemd 日志"
      journalctl -u "$SERVICE_NAME" -n "$LOG_LINES" --no-pager
    fi
    echo
    log "部署脚本日志：${DEPLOY_LOG}"
    log "只看某个标记（例如任务创建）：grep 'MARK:TASK_CREATE' ${APP_LOG}"
    exit 0 ;;
  logs-follow)
    APP_LOG="${DOWNLOAD_ROOT}/state/app.log"
    log "实时跟踪日志（Ctrl+C 退出）：${APP_LOG}"
    if [[ -f "$APP_LOG" ]]; then
      tail -f "$APP_LOG"
    else
      journalctl -u "$SERVICE_NAME" -f
    fi
    exit 0 ;;
  collect)
    # 离线收集：不依赖服务是否在运行，直接把日志文件打包出来
    STAMP="$(date +%Y%m%d-%H%M%S)"
    STATE_DIR="${DOWNLOAD_ROOT}/state"
    [[ -d "$STATE_DIR" ]] || die "找不到状态目录 ${STATE_DIR}（用 --root 指定下载根目录）"
    log "离线收集日志（服务在不在跑都可以）：${STATE_DIR}"
    files=()
    for f in "$STATE_DIR"/app.log "$STATE_DIR"/app.log.*; do [[ -f "$f" ]] && files+=("$f"); done
    [[ -f "$STATE_DIR/logs/deploy.log" ]] && files+=("$STATE_DIR/logs/deploy.log")
    [[ -f "$STATE_DIR/app.db" ]] && files+=("$STATE_DIR/app.db")
    if [[ ${#files[@]} -eq 0 ]]; then
      die "没有找到任何日志文件（${STATE_DIR}/app.log 等）"
    fi
    if have_cmd zip; then
      OUT="${PWD}/ttdownload-logs-${STAMP}.zip"
      zip -j -q "$OUT" "${files[@]}" && log "已生成：${OUT}"
    else
      OUT="${PWD}/ttdownload-logs-${STAMP}.tar.gz"
      tar czf "$OUT" -C "$STATE_DIR" . && log "已生成：${OUT}"
    fi
    log "包含 ${#files[@]} 个文件：$(printf '%s ' "${files[@]##*/}")"
    log "把这个文件发给开发者即可（内含 app.log / 轮转日志 / deploy.log / app.db）"
    exit 0 ;;
  check-ports)
    if [[ -f "${PROJECT_DIR}/deploy/scripts/check-ports.sh" ]]; then
      bash "${PROJECT_DIR}/deploy/scripts/check-ports.sh"
    else
      die "缺少 deploy/scripts/check-ports.sh（先 git pull / --update 拿到最新代码）"
    fi
    exit 0 ;;
  proxy)
    if [[ -f "${PROJECT_DIR}/deploy/scripts/setup-nginx-proxy.sh" ]]; then
      bash "${PROJECT_DIR}/deploy/scripts/setup-nginx-proxy.sh" --path "${PROXY_PATH}"
    else
      die "缺少 deploy/scripts/setup-nginx-proxy.sh（先 git pull / --update 拿到最新代码）"
    fi
    exit 0 ;;
  update)
    log "更新代码并重新部署 ..."
    cd "$PROJECT_DIR"
    if [[ -d .git ]]; then
      log "git pull（属主 ${REPO_OWNER}；当前版本：$(git -c safe.directory='*' log --oneline -1 2>/dev/null || echo 未知)）"
      git_pull_ok=0
      if as_owner git -c safe.directory='*' pull --ff-only; then
        git_pull_ok=1
      else
        # 常见原因一：项目里混入了 root 所有的文件（历史上用 sudo 跑过 git/npm）→ 自动归位后重试
        OWNER_MISMATCH="$(find "$PROJECT_DIR" -not -user "$REPO_OWNER" 2>/dev/null | head -1)"
        if [[ -n "$OWNER_MISMATCH" && "$REPO_OWNER" != "root" ]]; then
          warn "检测到不属于 ${REPO_OWNER} 的文件（例如 $OWNER_MISMATCH），正在自动归位属主后重试 git pull ..."
          chown -R "${REPO_OWNER}:${REPO_OWNER}" "$PROJECT_DIR" && log "属主已归位"
          as_owner git -c safe.directory='*' pull --ff-only && git_pull_ok=1
        fi
      fi
      if [[ $git_pull_ok -ne 1 ]]; then
        warn "若提示 'insufficient permission for adding an object'：执行 sudo bash deploy/scripts/fix-ownership.sh 后重试；"
        die "git pull 失败：请检查网络/凭据，或手动处理冲突后再执行"
      fi
      log "已更新到：$(git -c safe.directory='*' log --oneline -1)"
    else
      warn "当前目录不是 git 仓库（可能是 scp 上传的），跳过 git pull，仅重新构建"
    fi

    # 关键：git pull 可能已经把 deploy.sh 自己更新了，而 bash 还在按旧文件的偏移继续读，
    # 会导致"新加的步骤被跳过"。这里用**新脚本**重新执行同样的参数（DEPLOY_REEXEC 防死循环）。
    if [[ -z "${DEPLOY_REEXEC:-}" ]]; then
      DEPLOY_REEXEC=1
      log "代码已更新，改用最新版 deploy.sh 继续执行 ..."
      export DEPLOY_REEXEC
      exec bash "${PROJECT_DIR}/deploy.sh" "${ORIGINAL_ARGS[@]}"
    fi
    # 老部署升级时自愈：补 yt-dlp-ejs / JS 运行时（缺了 YouTube 一定失败）
    if [[ $SKIP_APT -eq 0 ]]; then ensure_ytdlp_stack; fi
    # 老部署升级时补齐「全站鉴权」账号密码（缺了就生成并打印，否则等于没有鉴权）
    if [[ -f .env ]]; then
      if ! grep -q '^WEB_AUTH_USER=' .env; then echo "WEB_AUTH_USER=${WEB_AUTH_USER:-admin}" >> .env; log "已补齐 WEB_AUTH_USER"; fi
      if ! grep -q '^WEB_SESSION_HOURS=' .env; then echo "WEB_SESSION_HOURS=168" >> .env; fi
      if ! grep -q '^WEB_SESSION_SECRET=' .env; then echo "WEB_SESSION_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> .env; fi
      if ! grep -q '^WEB_AUTH_PASSWORD=' .env; then
        GEN_PW="$(gen_password)"
        echo "WEB_AUTH_PASSWORD=${GEN_PW}" >> .env
        log "已为现有部署生成网页登录密码（写入 .env）：${GEN_PW}"
      fi
      chmod 600 .env 2>/dev/null || true
    fi
    log "重新安装依赖并构建后端（以 ${REPO_OWNER} 身份，避免产物变 root 所有）..."
    if [[ -f package-lock.json ]]; then as_owner npm ci --no-audit --no-fund || as_owner npm install --no-audit --no-fund; else as_owner npm install --no-audit --no-fund; fi
    as_owner npm run build
    if [[ $SKIP_WEB -eq 0 && -f web/package.json ]]; then
      log "重新构建前端 ..."
      (cd web && (as_owner npm ci --no-audit --no-fund || as_owner npm install --no-audit --no-fund) && as_owner npm run build)
    fi
    log "重启服务 ${SERVICE_NAME} ..."
    systemctl restart "$SERVICE_NAME"
    sleep 3
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      log "更新完成并已重启，健康检查通过 ✅"
    else
      warn "更新完成但健康检查失败，请查看日志：sudo ./deploy.sh --logs"
      journalctl -u "$SERVICE_NAME" -n 40 --no-pager || true
      exit 1
    fi
    exit 0 ;;
  status)
    systemctl status "$SERVICE_NAME" --no-pager || true
    curl -fsS "http://127.0.0.1:${PORT}/api/health" && echo || warn "健康检查失败"
    exit 0 ;;
  restart)
    systemctl restart "$SERVICE_NAME"
    sleep 2
    systemctl status "$SERVICE_NAME" --no-pager | head -12
    exit 0 ;;
  uninstall)
    systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload
    log "已卸载服务（数据目录 ${DOWNLOAD_ROOT} 保留）"
    exit 0 ;;
esac

# ---------------------------------------------------------------- 1. 系统依赖
if [[ $SKIP_APT -eq 0 ]]; then
  log "安装系统依赖（apt）..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  # 注意：transmission 不在这里装 —— 未安装时会调用 deploy/ubuntutr.sh（交互式安装配置）
  # build-essential/python3：better-sqlite3 若无预编译二进制时需要用 node-gyp 本机编译
  apt-get install -y curl ca-certificates gnupg openssl zip unzip ffmpeg jq build-essential python3 || true

  # Node.js：目标 Node 20（package.json 要求 >=18.17，但 18 已 EOL 且部分依赖要求 20）
  #   只有确实跑不了 Node 20 的老系统才退回 18：Ubuntu 18.04（glibc 2.27）。
  #   注意：树莓派 OS / Debian 的 VERSION_ID 是 12/13 这类数字，不能被当成“Ubuntu 13 < 20”。
  NODE_WANT_MAJOR=20
  NEED_NODE=1
  if command -v node >/dev/null 2>&1; then
    MAJ="$(detect_node_major || echo 0)"
    [[ "${MAJ:-0}" -ge "$NODE_WANT_MAJOR" ]] && NEED_NODE=0
  fi
  if [[ $NEED_NODE -eq 1 ]]; then
    OS_ID="$(. /etc/os-release 2>/dev/null && echo "${ID:-}")"
    OS_VER="$(. /etc/os-release 2>/dev/null && echo "${VERSION_ID:-0}")"
    OS_MAJ="${OS_VER%%.*}"
    NODE_SETUP="$NODE_WANT_MAJOR"
    if [[ "$OS_ID" == "ubuntu" ]] && [[ "${OS_MAJ:-0}" =~ ^[0-9]+$ ]] && (( OS_MAJ < 20 )); then
      NODE_SETUP="18"
      warn "检测到 Ubuntu ${OS_VER}（glibc 较老），退回 Node 18.x"
    fi
    log "安装 Node.js ${NODE_SETUP}.x（NodeSource）；当前：$(node -v 2>/dev/null || echo '未安装')，系统：${OS_ID:-未知} ${OS_VER:-}"
    # NodeSource 不一定支持所有新发行版（如 Debian 13），失败就退化为发行版仓库的 nodejs
    if ! curl -fsSL "https://deb.nodesource.com/setup_${NODE_SETUP}.x" | bash -; then
      warn "NodeSource 源配置失败（该系统版本可能暂不支持），改用发行版仓库安装 nodejs"
    fi
    apt-get install -y nodejs || warn "NodeSource 的 nodejs 安装失败，尝试发行版仓库"
    if ! command -v node >/dev/null 2>&1 || [[ "$(detect_node_major || echo 0)" -lt 18 ]]; then
      warn "当前 Node 仍不可用或版本过低（$(node -v 2>/dev/null || echo 未安装)），改用发行版仓库重试"
      apt-get update -y >/dev/null 2>&1 || true
      apt-get install -y nodejs npm || true
    fi
    command -v node >/dev/null 2>&1 || die "Node 安装失败：请手动安装 Node 20 后重试（https://nodejs.org 或 nvm）"
    [[ "$(detect_node_major || echo 0)" -ge 18 ]] || die "Node 版本仍然过低：$(node -v)（需要 >= 18.17）"
    log "Node 已就绪：$(node -v 2>/dev/null) / npm $(npm -v 2>/dev/null)"
    warn "Node 大版本变化后需要重建原生模块（better-sqlite3）——下面的 npm ci 会重新编译，属正常现象"
  fi

  # yt-dlp 全家桶（本体 + ejs + JS 运行时），多重兜底
  ensure_ytdlp_stack
else
  warn "按参数要求跳过 apt 安装"
fi

for c in node npm openssl; do
  command -v "$c" >/dev/null 2>&1 || die "缺少必要命令: $c（请去掉 --no-apt 重新运行）"
done
warn "以下工具缺失只影响对应模块（脚本会继续）："
for c in aria2c transmission-daemon yt-dlp ffmpeg zip unzip; do
  command -v "$c" >/dev/null 2>&1 && log "  ✓ $c" || warn "  ✗ $c（对应模块不可用）"
done

# ---------------------------------------------------------------- 2. 目录树
log "创建下载目录树: $DOWNLOAD_ROOT"
mkdir -p \
  "$DOWNLOAD_ROOT/transmission/btzhongzi_zip" \
  "$DOWNLOAD_ROOT/transmission/btzhongzi_nodownd" \
  "$DOWNLOAD_ROOT/transmission/btzhongzi_yijingdownding" \
  "$DOWNLOAD_ROOT/transmission/downloads" \
  "$DOWNLOAD_ROOT/downd_aria2_path" \
  "$DOWNLOAD_ROOT/downd_web_tools/downdok" \
  "$DOWNLOAD_ROOT/downd_ok_p2" \
  "$DOWNLOAD_ROOT/downd_ok_p2_jiami_tmp" \
  "$DOWNLOAD_ROOT/xiaofeizhe_downd" \
  "$DOWNLOAD_ROOT/state"
chmod -R 755 "$DOWNLOAD_ROOT"

# ---------------------------------------------------------------- 3. 依赖与构建
cd "$PROJECT_DIR"
log "安装后端依赖（npm ci/install；以 ${REPO_OWNER} 身份执行）..."
if [[ -f package-lock.json ]]; then as_owner npm ci --no-audit --no-fund || as_owner npm install --no-audit --no-fund; else as_owner npm install --no-audit --no-fund; fi

log "构建后端（TypeScript -> dist）..."
as_owner npm run build

if [[ $SKIP_WEB -eq 0 ]]; then
  if [[ -f web/package.json ]]; then
    log "安装并构建前端（React + Vite -> public/）..."
    (cd web && (as_owner npm ci --no-audit --no-fund || as_owner npm install --no-audit --no-fund) && as_owner npm run build)
  else
    warn "未找到 web/package.json，跳过前端构建"
  fi
fi
[[ -d public ]] || warn "public/ 不存在：访问 / 只会显示后端提示页（可用 --skip-web 之外的方式重新构建）"

# ---------------------------------------------------------------- 4. .env
if [[ ! -f .env ]]; then
  log "生成 .env（首次部署）"
  ANDROID_TOKEN_VALUE="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  WEB_AUTH_USER_VALUE="${WEB_AUTH_USER:-admin}"
  WEB_AUTH_PASSWORD_VALUE="${WEB_AUTH_PASSWORD:-$(gen_password)}"
  WEB_SESSION_SECRET_VALUE="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > .env <<EOF
HOST=0.0.0.0
PORT=${PORT}
DOWNLOAD_ROOT=${DOWNLOAD_ROOT}
ENCRYPT_PASSWORD=ec3e458fcde2582e079f19368abc780f
RESERVE_FREE_BYTES=10737418240
MAX_CONCURRENT=3
CONCURRENCY_TRANSMISSION=1
CONCURRENCY_ARIA2=2
CONCURRENCY_WEBVIDEO=2
ANDROID_TOKEN=${ANDROID_TOKEN_VALUE}
# 网页登录账号密码（全站鉴权；部署完成后终端会打印一次）
WEB_AUTH_USER=${WEB_AUTH_USER_VALUE}
WEB_AUTH_PASSWORD=${WEB_AUTH_PASSWORD_VALUE}
WEB_SESSION_HOURS=168
WEB_SESSION_SECRET=${WEB_SESSION_SECRET_VALUE}
# 调试期：debug 记录外部命令 argv/退出码/stdout 摘要，排查完可改成 info 以减小日志
LOG_LEVEL=debug
SCRIPT_UPLOAD_ENABLED=0
SCRIPT_RUN_TIMEOUT_SEC=600
LOG_MAX_MB=20
LOG_KEEP_FILES=5
ARIA2_RPC_HOST=127.0.0.1
ARIA2_RPC_PORT=6800
ARIA2_RPC_SECRET=
ARIA2_BIN=aria2c
TRANSMISSION_RPC_HOST=127.0.0.1
TRANSMISSION_RPC_PORT=9091
TRANSMISSION_RPC_USER=
TRANSMISSION_RPC_PASSWORD=
TRANSMISSION_REMOTE_BIN=transmission-remote
YTDLP_BIN=yt-dlp
FFMPEG_BIN=ffmpeg
OPENSSL_BIN=openssl
ZIP_BIN=zip
UNZIP_BIN=unzip
EOF
  chmod 600 .env
  log "已生成 .env（安卓 Token 见文件内 ANDROID_TOKEN）"
else
  log ".env 已存在，保留现有配置（端口/Token/密码不会被覆盖）"
  # 补齐可能缺失的项（老部署升级后也能用上新功能）
  backfill_env() {
    local kv key
    for kv in "$@"; do
      key="${kv%%=*}"
      if ! grep -q "^${key}=" .env; then
        echo "$kv" >> .env
        log "已为现有 .env 补齐 ${kv}"
      fi
    done
  }
  backfill_env \
    "DOWNLOAD_ROOT=${DOWNLOAD_ROOT}" \
    "PORT=${PORT}" \
    "LOG_LEVEL=debug" \
    "LOG_MAX_MB=20" \
    "LOG_KEEP_FILES=5" \
    "SCRIPT_UPLOAD_ENABLED=0" \
    "SCRIPT_RUN_TIMEOUT_SEC=600" \
    "WEB_AUTH_USER=${WEB_AUTH_USER:-admin}" \
    "WEB_SESSION_HOURS=168" \
    "WEB_SESSION_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  # 密码单独处理：缺了就生成一个，并在下面显著打印出来
  if ! grep -q '^WEB_AUTH_PASSWORD=' .env; then
    GEN_PW="$(gen_password)"
    echo "WEB_AUTH_PASSWORD=${GEN_PW}" >> .env
    warn "本次为老部署生成了网页登录密码（已写入 .env）：${GEN_PW}"
  fi
fi
set -a; . ./.env; set +a
PORT="${PORT:-8080}"

# ---------------------------------------------------------------- 5. aria2 / transmission 依赖（已安装则跳过）
ensure_aria2 || true
ensure_transmission || true
# 把 transmission RPC 凭据写进 .env（BT 模块需要；用户名默认 opengl）
configure_transmission_env

# ---------------------------------------------------------------- 6. 防火墙（如果启用了 ufw）
# 只放行 Web 端口；aria2/transmission 的 RPC 仅监听本机，无需对外开放
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  if ufw allow "${PORT}/tcp" >/dev/null 2>&1; then
    log "已放行防火墙端口 ${PORT}/tcp（ufw）"
  else
    warn "ufw 放行 ${PORT}/tcp 失败，如外网访问不了请手动执行：ufw allow ${PORT}/tcp"
  fi
fi

# ---------------------------------------------------------------- 7. systemd
log "注册 systemd 服务: ${SERVICE_FILE}"
NODE_BIN="$(command -v node)"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=ttdownload-web (下载管理器 Web 应用)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
EnvironmentFile=${PROJECT_DIR}/.env
ExecStart=${NODE_BIN} ${PROJECT_DIR}/dist/server.js
Restart=always
RestartSec=3
User=root
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"
sleep 3

# ---------------------------------------------------------------- 8. 自检
log "健康检查 ..."
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    OK=1; break
  fi
  sleep 1
done

echo
if [[ "${OK:-0}" -eq 1 ]]; then
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  TOKEN="$(grep '^ANDROID_TOKEN=' .env | cut -d= -f2-)"
  log "============================== 部署成功 =============================="
  log "Web 管理界面 : http://${IP:-<服务器IP>}:${PORT}/"
  log "API 健康检查 : http://${IP:-<服务器IP>}:${PORT}/api/health"
  log "安卓 App 填写 : 服务器地址 http://${IP:-<服务器IP>}:${PORT}   Token ${TOKEN}"
  WEB_USER_SHOW="$(grep -E '^WEB_AUTH_USER=' .env 2>/dev/null | cut -d= -f2-)"
  WEB_PASS_SHOW="$(grep -E '^WEB_AUTH_PASSWORD=' .env 2>/dev/null | cut -d= -f2-)"
  log "网页登录账号 : ${WEB_USER_SHOW:-（未配置）}"
  log "网页登录密码 : ${WEB_PASS_SHOW:-（未配置，任何人不登录即可访问！）}"
  if [[ -n "$WEB_USER_SHOW" && -n "$WEB_PASS_SHOW" ]]; then
    log "登录地址     : http://${IP:-<服务器IP>}:${PORT}/  （走反代则为 http://<公网IP>${PROXY_PATH}/）"
  fi
  log "下载根目录   : ${DOWNLOAD_ROOT}"
  log "服务管理     : systemctl status|restart|stop ${SERVICE_NAME}"
  log "项目属主     : ${REPO_OWNER}（如发现 git/npm 报权限错误，跑 deploy/scripts/fix-ownership.sh 归位）"
  log "日志/排查    : http://${IP:-<服务器IP>}:${PORT}/logs 与 /report（一键下载诊断报告发给开发者）"
  log "修复脚本页   : http://${IP:-<服务器IP>}:${PORT}/scripts（维护令牌 = 上面的安卓 Token；也可在 .env 里自设 MAINTENANCE_TOKEN）"
  # 若本机 80 端口已有服务（多半是 nginx）而本服务端口未必对外开放，给出子路径反代建议
  if command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :80" 2>/dev/null | grep -q .; then
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi active && ! ufw status 2>/dev/null | grep -qE "(^|[[:space:]])${PORT}(/tcp)?([[:space:]]|$)"; then
      warn "检测到 80 端口已有服务（nginx?），且 ufw 未放行 ${PORT}：外网很可能访问不到本服务"
      log "   → 建议用子路径反向代理（不影响 80 根路径）：sudo ./deploy.sh --proxy"
    else
      log "端口可达性   : 如需确认外网能否访问 ${PORT}：sudo ./deploy.sh --check-ports"
      log "     若外网不通而 80 可用：sudo ./deploy.sh --proxy   → http://${IP:-<服务器IP>}${PROXY_PATH}/"
    fi
  fi
  log "日志文件     : journalctl -u ${SERVICE_NAME} -f   或   ${DOWNLOAD_ROOT}/state/app.log"
  log "===================================================================="
else
  warn "部署完成但健康检查失败，请查看：journalctl -u ${SERVICE_NAME} -n 80 --no-pager"
  exit 1
fi
