#!/usr/bin/env bash
# =============================================================================
#  修复脚本：把 Node.js 升级到 20 并重建依赖、重启服务
#
#  适用场景：树莓派 OS / Debian 13 等系统上被旧版部署脚本误装成 Node 18
#            （典型现象：npm warn EBADENGINE playwright requires node >=20）
#
#  这个脚本做什么：
#    1) 检测当前 Node 版本；已是 20+ 则直接跳过升级（幂等，重复执行也安全）
#    2) 用 NodeSource 20.x 安装；若 NodeSource 不支持该系统版本，退回发行版仓库的 nodejs
#    3) 重新安装依赖并重建原生模块（better-sqlite3 与 Node ABI 绑定，必须重建）
#    4) 重新构建前后端
#    5) 只有第 3、4 步都成功才重启服务（失败则保持旧服务继续运行，不会把你搞挂）
#    6) 打印版本与健康检查结果
#
#  回滚方法：如果升级后有问题，执行
#      sudo apt-get install -y nodejs=18.* && cd <项目目录> && npm ci && npm run build:all && sudo ./deploy.sh --restart
#    （或者直接用 deploy/scripts/rollback-node18.sh，如果工程里带了）
#
#  预期输出：结尾出现 "Node 已升级到 v20.x" 与 "健康检查通过"
# =============================================================================
set -u

MARK() { printf '\n===== %s =====\n' "$1"; }
OK()   { printf '  [OK]   %s\n' "$1"; }
BAD()  { printf '  [BAD]  %s\n' "$1"; }
INFO() { printf '  [INFO] %s\n' "$1"; }
die()  { printf '  [FAIL] %s\n' "$1" >&2; exit 1; }

echo "ttdownload-web 修复脚本：Node 升级到 20"
echo "时间：$(date '+%F %T %z')   主机：$(hostname)   用户：$(id -un)"

if [ "$(id -u)" != "0" ]; then
  die "请以 root 运行（sudo）。在网页「修复脚本」页上传执行时本身就是 root，可忽略此提示。"
fi

MARK "1. 找到项目目录"
PROJ=""
for d in "$(pwd)" /home/*/ttdownload-web /root/ttdownload-web /opt/ttdownload-web; do
  if [ -f "$d/package.json" ] && [ -f "$d/web/package.json" ]; then PROJ="$d"; break; fi
done
[ -n "$PROJ" ] || die "没找到项目目录（应包含 package.json 与 web/package.json）"
OK "项目目录：$PROJ"
cd "$PROJ" || die "无法进入项目目录"
INFO "当前代码版本：$(git log --oneline -1 2>/dev/null || echo '非 git 仓库')"

MARK "2. 当前 Node"
CUR_MAJ=0
if command -v node >/dev/null 2>&1; then
  CUR_MAJ="$(node -v | sed 's/^v//' | cut -d. -f1)"
  INFO "node $(node -v) / npm $(npm -v 2>/dev/null || echo '?')"
else
  INFO "未安装 node"
fi

if [ "${CUR_MAJ:-0}" -ge 20 ]; then
  OK "已经是 Node $(node -v)，跳过升级步骤"
else
  MARK "3. 安装 Node 20"
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    INFO "系统：${PRETTY_NAME:-$ID $VERSION_ID}"
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y >/dev/null 2>&1 || true
  apt-get install -y curl ca-certificates gnupg >/dev/null 2>&1 || true
  if curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; then
    OK "NodeSource 20.x 源已配置"
  else
    BAD "NodeSource 源配置失败，改用发行版仓库"
  fi
  apt-get install -y nodejs || BAD "从当前源安装 nodejs 失败，稍后尝试发行版仓库"
  NEW_MAJ="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1 || echo 0)"
  if [ "${NEW_MAJ:-0}" -lt 20 ]; then
    INFO "当前仍为 $(node -v 2>/dev/null || echo '未安装')，尝试发行版仓库"
    apt-get install -y --reinstall nodejs npm || true
    NEW_MAJ="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1 || echo 0)"
  fi
  command -v node >/dev/null 2>&1 || die "Node 安装失败，请检查网络与 apt 源"
  [ "${NEW_MAJ:-0}" -ge 18 ] || die "Node 版本仍然过低：$(node -v)"
  if [ "${NEW_MAJ:-0}" -ge 20 ]; then OK "Node 已升级到 $(node -v)"; else BAD "Node 为 $(node -v)（可用但非 20，发行版仓库较旧）"; fi
fi

MARK "4. 重建依赖（better-sqlite3 与 Node ABI 绑定，必须重建）"
if npm ci --no-audit --no-fund || npm install --no-audit --no-fund; then
  OK "后端依赖安装完成"
else
  die "npm 依赖安装失败：保持旧服务不动，请把本日志发给开发者"
fi
if node -e "require('better-sqlite3')" >/dev/null 2>&1; then
  OK "better-sqlite3 加载正常（ABI 匹配 $(node -v)）"
else
  INFO "尝试单独重建 better-sqlite3"
  npm rebuild better-sqlite3 || true
  node -e "require('better-sqlite3')" >/dev/null 2>&1 && OK "重建后加载正常" || die "better-sqlite3 仍无法加载，请看上面的报错"
fi

MARK "5. 构建后端与前端"
if npm run build; then OK "后端构建完成（dist/）"; else die "后端构建失败：保持旧服务不动，请把本日志发给开发者"; fi
if (cd web && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund) && npm run build); then
  OK "前端构建完成（public/）"
else
  die "前端构建失败：保持旧服务不动，请把本日志发给开发者"
fi

MARK "6. 重启服务"
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^ttdownload-web.service'; then
  systemctl restart ttdownload-web
  sleep 3
  STATE="$(systemctl is-active ttdownload-web 2>/dev/null || echo unknown)"
  INFO "服务状态：$STATE"
  PORT="$(grep -E '^PORT=' "$PROJ/.env" 2>/dev/null | cut -d= -f2-)"; PORT="${PORT:-8080}"
  if curl -fsS --max-time 8 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    OK "健康检查通过（http://127.0.0.1:${PORT}/api/health）"
  else
    BAD "健康检查失败：请看 journalctl -u ttdownload-web -n 60 --no-pager"
  fi
else
  BAD "没找到 ttdownload-web.service，跳过重启（可用 sudo ./deploy.sh 完整部署）"
fi

MARK "7. 结果"
INFO "node $(node -v) / npm $(npm -v 2>/dev/null)"
journalctl -u ttdownload-web -n 8 --no-pager 2>/dev/null | sed 's/^/  /' || true
echo
echo "===== 修复脚本结束 ====="
exit 0
