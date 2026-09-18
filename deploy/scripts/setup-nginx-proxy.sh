#!/usr/bin/env bash
# =============================================================================
#  nginx 子路径反向代理：http://<公网IP>/ttdownload/  →  http://127.0.0.1:8080/
#
#  适用场景：远程服务器只开放了 22/80/443，8080 外网访问不到，而 80 端口已经有 nginx
#            在给别的站点用（不能把整个 80 抢过来）。
#  做法：在**现有**的 80 端口 server 块里插入一段 location（通过 include 引入独立 snippet），
#        **不动根路径**，不影响别人；也不需要重启其他服务。
#
#  用法：
#      sudo bash deploy/scripts/setup-nginx-proxy.sh                    # 默认子路径 /ttdownload，转发到 .env 的 PORT
#      sudo bash deploy/scripts/setup-nginx-proxy.sh --path /dl         # 自定义子路径
#      sudo bash deploy/scripts/setup-nginx-proxy.sh --port 8080        # 指定后端端口
#      sudo bash deploy/scripts/setup-nginx-proxy.sh --print            # 只打印将要写入的配置，不改动
#      sudo bash deploy/scripts/setup-nginx-proxy.sh --remove           # 卸载（移除 include 与 snippet）
#
#  安全性：
#    - 改配置前自动备份到 /etc/nginx/ttdownload-backup-<时间>/
#    - 写入用带标记的独立 snippet，include 行幂等（重复执行不会重复插入）
#    - 每次改动后先 `nginx -t`，失败立刻回滚并退出
#    - 只新增 location，不修改任何既有 location
#
#  预期输出：结尾出现「✅ 反向代理已生效」以及可访问的完整 URL
# =============================================================================
set -u

MARK() { printf '\n===== %s =====\n' "$1"; }
OK()   { printf '  [OK]   %s\n' "$1"; }
BAD()  { printf '  [BAD]  %s\n' "$1"; }
INFO() { printf '  [INFO] %s\n' "$1"; }
WARN() { printf '  [WARN] %s\n' "$1"; }
die()  { printf '  [FAIL] %s\n' "$1" >&2; exit 1; }

SUB_PATH="/ttdownload"
BACKEND_PORT=""
PRINT_ONLY=0
REMOVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --path) SUB_PATH="$2"; shift 2 ;;
    --path=*) SUB_PATH="${1#*=}"; shift ;;
    --port) BACKEND_PORT="$2"; shift 2 ;;
    --port=*) BACKEND_PORT="${1#*=}"; shift ;;
    --print) PRINT_ONLY=1; shift ;;
    --remove) REMOVE=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "未知参数：$1（--help 查看用法）" ;;
  esac
done
# 规范化：/ttdownload 与 /ttdownload/ 都接受
SUB_PATH="/${SUB_PATH#/}"
SUB_PATH="${SUB_PATH%/}"
[ -n "$SUB_PATH" ] || die "子路径不能为空"
case "$SUB_PATH" in *[!A-Za-z0-9._/-]*) die "子路径只能包含字母数字与 . _ - /" ;; esac

echo "ttdownload-web nginx 子路径反向代理配置"
echo "时间：$(date '+%F %T %z')   主机：$(hostname)"

# ---------- 项目目录与后端端口 ----------
PROJ=""
for d in "$(pwd)" /home/*/ttdownload-web /root/ttdownload-web /opt/ttdownload-web; do
  if [ -f "$d/package.json" ] && [ -f "$d/web/package.json" ]; then PROJ="$d"; break; fi
done
if [ -z "$BACKEND_PORT" ]; then
  if [ -n "$PROJ" ] && [ -f "$PROJ/.env" ]; then
    BACKEND_PORT="$(grep -hE '^PORT=' "$PROJ/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
  fi
  BACKEND_PORT="${BACKEND_PORT:-8080}"
fi
OK "子路径：${SUB_PATH}/   后端：http://127.0.0.1:${BACKEND_PORT}"

SNIPPET="/etc/nginx/snippets/ttdownload-proxy.conf"
MARK_BEGIN="# >>> ttdownload-web proxy (managed) >>>"
MARK_END="# <<< ttdownload-web proxy (managed) <<<"

SNIPPET_BODY="${MARK_BEGIN}
# 由 deploy/scripts/setup-nginx-proxy.sh 生成；删除本文件并移除 include 即可回退
location = ${SUB_PATH} { return 301 ${SUB_PATH}/; }
location ${SUB_PATH}/ {
    proxy_pass http://127.0.0.1:${BACKEND_PORT}/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \"upgrade\";
    # SSE / 长轮询：必须关闭缓冲并放长超时（任务日志靠它实时推送）
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    # 允许上传较大的种子 zip / cookies
    client_max_body_size 1024m;
}
${MARK_END}"

if [ "$PRINT_ONLY" = 1 ]; then
  MARK "将要写入 ${SNIPPET}"
  printf '%s\n' "$SNIPPET_BODY"
  INFO "并在 80 端口 server 块中插入： include ${SNIPPET};"
  exit 0
fi

[ "$(id -u)" = "0" ] || die "需要 root（网页「修复脚本」页执行时本身就是 root）"

# ---------- nginx 是否可用 ----------
MARK "1. 检查 nginx"
if ! command -v nginx >/dev/null 2>&1; then
  INFO "未安装 nginx，正在安装…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y >/dev/null 2>&1 || true
  apt-get install -y nginx || die "nginx 安装失败"
fi
# 装了不等于在跑（真机上遇到 apt 装完仍是 inactive+disabled，policy-rc.d 会阻止自启）
if ! systemctl is-active --quiet nginx 2>/dev/null; then
  WARN "nginx 未运行，正在启动并设为开机自启…"
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl start nginx >/dev/null 2>&1 || true
fi
if ! systemctl is-active --quiet nginx 2>/dev/null; then
  systemctl status nginx --no-pager -l 2>&1 | tail -5 | sed 's/^/    /' || true
  die "nginx 没有运行（80 端口无人监听，外面进不来）—— 先修好 nginx 再重试"
fi
nginx -v 2>&1 | sed 's/^/    /'
if ! nginx -t >/dev/null 2>&1; then
  WARN "当前 nginx 配置本身就有问题（先修好再继续）："
  nginx -t 2>&1 | sed 's/^/    /'
  die "nginx 配置检查未通过，已中止（没有做任何改动）"
fi
OK "nginx 配置当前正常"

# ---------- 卸载模式 ----------
if [ "$REMOVE" = 1 ]; then
  MARK "卸载反向代理"
  CONF_FILES="$(grep -rl "include ${SNIPPET};" /etc/nginx 2>/dev/null || true)"
  for f in $CONF_FILES; do
    sed -i "\\#include ${SNIPPET};#d" "$f" && INFO "已从 ${f} 移除 include"
  done
  rm -f "$SNIPPET" && INFO "已删除 ${SNIPPET}"
  if nginx -t >/dev/null 2>&1; then systemctl reload nginx && OK "已卸载并 reload nginx"; else BAD "配置检查失败，请手动检查"; fi
  exit 0
fi

# ---------- 找 80 端口的 server 块 ----------
MARK "2. 找到 80 端口的 server 块"
# nginx -T 会打印合并后的配置，并带 "# configuration file /path:" 分隔注释
CONF_DUMP="$(nginx -T 2>/dev/null)"
TARGET_FILE=""
CURRENT_FILE=""
FOUND_LINE=""
LINE_NO=0
while IFS= read -r line; do
  LINE_NO=$((LINE_NO + 1))
  case "$line" in
    "# configuration file "*) CURRENT_FILE="${line#\# configuration file }"; CURRENT_FILE="${CURRENT_FILE%:}" ;;
  esac
  if printf '%s' "$line" | grep -qE "^[[:space:]]*server[[:space:]]*\{"; then
    SRV_FILE="$CURRENT_FILE"
    SRV_LINE=0
    continue
  fi
  if printf '%s' "$line" | grep -qE "^[[:space:]]*listen[[:space:]]+([^;]*:)?80([[:space:];]|$)" && [ -n "${SRV_FILE:-}" ]; then
    if [ -f "$SRV_FILE" ] && [ -z "$TARGET_FILE" ]; then
      # 在真实文件里定位该 server 块（按 "server {"+listen 80 的顺序近似：取文件里最后一个 listen 80 所属 server）
      TARGET_FILE="$SRV_FILE"
      FOUND_LINE="$(grep -nE "^[[:space:]]*listen[[:space:]]+([^;]*:)?80([[:space:];]|$)" "$SRV_FILE" | head -1 | cut -d: -f1)"
    fi
  fi
done <<< "$CONF_DUMP"

if [ -z "$TARGET_FILE" ] || [ -z "$FOUND_LINE" ]; then
  WARN "没能自动定位 80 端口的 server 块。你可能需要手工做两步："
  INFO "  1) 把下面内容保存为 ${SNIPPET}"
  printf '%s\n' "$SNIPPET_BODY" | sed 's/^/      /'
  INFO "  2) 在 80 端口 server 块里加一行： include ${SNIPPET};"
  INFO "  3) nginx -t && systemctl reload nginx"
  exit 1
fi
OK "目标配置文件：${TARGET_FILE}（listen 80 在第 ${FOUND_LINE} 行附近）"

# ---------- 备份 ----------
MARK "3. 备份现有配置"
BACKUP_DIR="/etc/nginx/ttdownload-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp -a "$TARGET_FILE" "$BACKUP_DIR/" 2>/dev/null || true
[ -f "$SNIPPET" ] && cp -a "$SNIPPET" "$BACKUP_DIR/" 2>/dev/null || true
OK "已备份到 ${BACKUP_DIR}"

# ---------- 写 snippet ----------
MARK "4. 写入 snippet 并挂到 80 端口 server 块"
mkdir -p "$(dirname "$SNIPPET")"
printf '%s\n' "$SNIPPET_BODY" > "$SNIPPET"
OK "已写入 ${SNIPPET}"

# 找到该 listen 80 所属 server 块的起始行（在真实文件里从 FOUND_LINE 往前找最近的 "server {"）
SRV_START="$(awk -v ln="$FOUND_LINE" 'NR<=ln && /^[[:space:]]*server[[:space:]]*\{/ {last=NR} END{print last}' "$TARGET_FILE")"
if [ -z "$SRV_START" ]; then
  # 退而求其次：直接插到 listen 行之后
  SRV_START="$FOUND_LINE"
fi
if grep -q "include ${SNIPPET};" "$TARGET_FILE"; then
  OK "include 已存在（幂等，跳过插入）"
else
  sed -i "${SRV_START}a\\    include ${SNIPPET}; # ttdownload-web subpath proxy" "$TARGET_FILE"
  OK "已在 ${TARGET_FILE}:${SRV_START} 之后插入 include"
fi

# ---------- 校验并 reload ----------
MARK "5. 校验并 reload"
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || true
  OK "nginx 配置检查通过，已 reload"
else
  BAD "nginx -t 失败，正在回滚"
  nginx -t 2>&1 | sed 's/^/    /'
  cp -a "${BACKUP_DIR}/$(basename "$TARGET_FILE")" "$TARGET_FILE" 2>/dev/null || true
  rm -f "$SNIPPET"
  nginx -t >/dev/null 2>&1 && { systemctl reload nginx 2>/dev/null || true; INFO "已回滚到改动前的配置"; }
  die "配置有误，已回滚（没有生效）"
fi

# ---------- 自检 ----------
MARK "6. 自检"
sleep 1
PUBLIC_IP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null | tr -d ' \n' || true)"
if curl -fsS --max-time 8 "http://127.0.0.1${SUB_PATH}/api/health" >/dev/null 2>&1; then
  OK "本机访问通过：http://127.0.0.1${SUB_PATH}/api/health"
else
  BAD "本机访问失败：请确认后端在 ${BACKEND_PORT} 端口运行（systemctl status ttdownload-web）"
fi
# 走 Host 头模拟外部访问（绕过 DNS）
if curl -fsS --max-time 8 -H "Host: localhost" "http://127.0.0.1${SUB_PATH}/api/health" >/dev/null 2>&1; then
  OK "经 nginx 反代访问通过"
fi
if [ -n "$PUBLIC_IP" ]; then
  if curl -fsS --max-time 8 "http://${PUBLIC_IP}${SUB_PATH}/api/health" >/dev/null 2>&1; then
    OK "公网访问通过：http://${PUBLIC_IP}${SUB_PATH}/"
  else
    WARN "公网自测未通过（服务器自己访问公网 IP 常被 NAT 回环限制，不一定代表外网不通）"
    INFO "请用手机 4G/5G 打开：http://${PUBLIC_IP}${SUB_PATH}/"
  fi
fi

echo
echo "✅ 反向代理已生效"
echo "   网页地址   : http://${PUBLIC_IP:-<公网IP>}${SUB_PATH}/"
echo "   安卓 App   : 服务器地址填 http://${PUBLIC_IP:-<公网IP>}${SUB_PATH}   （Token 不变）"
echo "   后端仍在   : http://127.0.0.1:${BACKEND_PORT}（无需对外开放 ${BACKEND_PORT} 端口）"
echo "   配置备份   : ${BACKUP_DIR}"
echo "   卸载命令   : sudo bash deploy/scripts/setup-nginx-proxy.sh --remove"
echo "===== 完成 ====="
exit 0
