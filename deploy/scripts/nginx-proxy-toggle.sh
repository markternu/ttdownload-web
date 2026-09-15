#!/usr/bin/env bash
# =============================================================================
#  nginx 子路径反向代理「开关」脚本（目前用于把 transmission 的 9091 暴露成一个子路径）
#
#  场景：远程服务器只开放 22/80/443，transmission 的 WebUI/RPC 在 127.0.0.1:9091 上，
#        外网访问不到。本脚本把 http://<域名>/transmission/ 反代到 127.0.0.1:9091，
#        **只新增 location**，不动 80 根路径与别人的站点；关掉即彻底移除，外界再也访问不到。
#
#  用法：
#      bash nginx-proxy-toggle.sh status  [--path /transmission] [--target 127.0.0.1:9091]
#      bash nginx-proxy-toggle.sh preview [--path ...] [--target ...]     # 只打印将写入的配置
#      bash nginx-proxy-toggle.sh enable  [...]                          # 开启
#      bash nginx-proxy-toggle.sh disable [...]                          # 关闭（移除 include 与 snippet）
#
#  选项：
#      --path <子路径>     默认 /transmission（transmission WebUI 自带这个前缀，别改）
#      --target <host:port> 默认 127.0.0.1:9091
#      --no-reload         只改配置不 reload（测试/预览用）
#
#  环境变量（供测试注入假 nginx）：
#      NGINX_BIN        默认 nginx          （命令名或绝对路径）
#      NGINX_CONF_DIR   默认 /etc/nginx     （主配置目录，脚本用它定位 snippets 与 nginx.conf）
#      NGINX_SERVICE    默认 nginx          （systemctl reload 的服务名）
#
#  安全：改动前备份到 $NGINX_CONF_DIR/ttdownload-backup-<时间>/；每次改动后跑 nginx -t，
#        失败立即回滚并退出码非 0；所有动作都打印带 [nginx-proxy] 前缀的日志。
#        最后一行固定输出 TTDL_NGINX_PROXY_RESULT={json}，供调用方（Node 服务）解析。
#
#  可移植性：不使用 `sed -i`（GNU 与 BSD/macOS 参数不兼容），改配置一律 awk + 原子替换。
# =============================================================================
set -u

NGINX_BIN="${NGINX_BIN:-nginx}"
CONF_ROOT="${NGINX_CONF_DIR:-/etc/nginx}"
NGINX_SERVICE="${NGINX_SERVICE:-nginx}"
MAIN_CONF="${CONF_ROOT}/nginx.conf"
SNIPPET_DIR="${CONF_ROOT}/snippets"
SUB_PATH="/transmission"
TARGET="127.0.0.1:9091"
DO_RELOAD=1

MANAGED_TAG="ttdownload-web managed"
BACKUP_GLOB="ttdownload-backup-*"

log()  { printf '[nginx-proxy] %s\n' "$*"; }
warn() { printf '[nginx-proxy][warn] %s\n' "$*" >&2; }
die()  { printf '[nginx-proxy][fail] %s\n' "$*" >&2; exit 1; }

ACTION="${1:-status}"
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --path) SUB_PATH="$2"; shift 2 ;;
    --path=*) SUB_PATH="${1#*=}"; shift ;;
    --target) TARGET="$2"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --no-reload) DO_RELOAD=0; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) die "未知参数：$1（--help 查看用法）" ;;
  esac
done

SUB_PATH="/${SUB_PATH#/}"
SUB_PATH="${SUB_PATH%/}"
case "$SUB_PATH" in *[!A-Za-z0-9._/-]*) die "子路径只能包含字母数字与 . _ - /" ;; esac
[[ "$TARGET" =~ ^[A-Za-z0-9._-]+:[0-9]+$ ]] || die "--target 需形如 127.0.0.1:9091"

# 每个子路径一个独立 snippet，互不干扰（/transmission 与 /ttdownload 可同时存在）
TAG="$(printf '%s' "${SUB_PATH#/}" | tr -c 'A-Za-z0-9._-' '-')"
SNIPPET="${SNIPPET_DIR}/ttdownload-proxy-${TAG}.conf"
BEGIN="# >>> ttdownload-web proxy ${SUB_PATH} (managed) >>>"
END="# <<< ttdownload-web proxy ${SUB_PATH} (managed) <<<"
INCLUDE_LINE="include ${SNIPPET}; # ${MANAGED_TAG} (${SUB_PATH})"

# ---------------------------------------------------------------------------
#  小工具（全部可移植，不依赖 GNU 专有参数）
# ---------------------------------------------------------------------------

# 跟随符号链接，返回真实文件路径。
# 重要：Ubuntu/Debian 的 /etc/nginx/sites-enabled/* 是指向 sites-available/ 的**符号链接**，
# 如果我们直接 mv 覆盖，就会把符号链接换成普通文件（之后改 sites-available 不再生效，极易踩坑）。
resolve_link() { # <path>
  local p="$1" i=0 t
  while [ -L "$p" ] && [ "$i" -lt 16 ]; do
    t="$(readlink "$p" 2>/dev/null)" || break
    [ -n "$t" ] || break
    case "$t" in
      /*) p="$t" ;;
      *) p="$(dirname "$p")/$t" ;;
    esac
    i=$((i + 1))
  done
  printf '%s' "$p"
}

# 原子写文件：从 stdin 读内容，保留原权限（写符号链接指向的真实文件，链接本身不动）
write_file_atomic() { # <file>
  local f tmp perms
  f="$(resolve_link "$1")"
  tmp="$(mktemp "${f}.ttdlXXXXXX")" || return 1
  if ! cat > "$tmp"; then rm -f "$tmp"; return 1; fi
  perms="$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f" 2>/dev/null || echo 644)"
  chmod "$perms" "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$f"
}

# 在第 N 行之后插入一行
insert_line_after() { # <file> <line_no> <text>
  local f="$1" ln="$2" text="$3"
  awk -v ln="$ln" -v text="$text" '{ print; if (NR == ln) print text }' "$f" | write_file_atomic "$f"
}

# 删除与给定内容完全相同的行
remove_line_exact() { # <file> <text>
  local f="$1" text="$2"
  grep -vF -e "$text" "$f" | write_file_atomic "$f"
}

# 在 $CONF_ROOT 下找含指定字符串的文件（跳过我们自己的备份目录）
grep_conf_files() { # <fixed-string>
  grep -rlF --exclude-dir="$BACKUP_GLOB" -e "$1" "$CONF_ROOT" 2>/dev/null || true
}

# 用 nginx -T 的全量 dump 找出「监听 80 端口的 server 块」所在文件。
# 打分：有 listen 80 +10、default_server +5、已经代理我们的应用 +20。
FIND_SERVER_AWK="$(cat <<'AWK'
function strip(l,   i, ch, out, instr) {
  out = ""; instr = 0
  for (i = 1; i <= length(l); i++) {
    ch = substr(l, i, 1)
    if (ch == "\"") { instr = !instr; out = out ch; continue }
    if (ch == "#" && !instr) break
    out = out ch
  }
  return out
}
function flush() {
  if (in_srv) {
    if (score > best) { best = score; bestfile = srvfile }
    in_srv = 0
  }
}
BEGIN { best = -1; depth = 0; in_srv = 0; bestfile = "" }
/^# configuration file / {
  cur = $0; sub(/^# configuration file /, "", cur); sub(/:$/, "", cur)
  next
}
{
  l = strip($0)
  if (!in_srv && l ~ /^[ \t]*server[ \t]*\{/) {
    in_srv = 1; srvfile = cur; srv_depth = depth; score = 0
  }
  if (in_srv) {
    if (l ~ /^[ \t]*listen[ \t]+([^;]*:)?80([ \t;]|$)/) score += 10
    if (l ~ /default_server/) score += 5
    if (l ~ /location[ \t]/ && l ~ /ttdownload/) score += 20
  }
  o = l; opens = gsub(/\{/, "{", o)
  o = l; closes = gsub(/\}/, "}", o)
  depth += opens - closes
  if (in_srv && depth <= srv_depth) flush()
}
END { flush(); if (bestfile != "") print bestfile }
AWK
)"

nginx_ok() { "$NGINX_BIN" -t -c "$MAIN_CONF" >/dev/null 2>&1; }
nginx_test_output() { "$NGINX_BIN" -t -c "$MAIN_CONF" 2>&1 || true; }

reload_nginx() {
  [ "$DO_RELOAD" = 1 ] || { log "按要求跳过 reload"; return 0; }
  if command -v systemctl >/dev/null 2>&1 && systemctl reload "$NGINX_SERVICE" 2>/dev/null; then
    log "已 reload nginx（systemctl）"
    return 0
  fi
  if "$NGINX_BIN" -s reload -c "$MAIN_CONF" 2>/dev/null; then
    log "已 reload nginx（nginx -s reload）"
    return 0
  fi
  warn "reload 失败（配置已写入，可手动 systemctl reload ${NGINX_SERVICE}）"
  return 0
}

find_server_file() {
  local dump candidate
  dump="$("$NGINX_BIN" -T -c "$MAIN_CONF" 2>/dev/null || true)"
  if [ -n "$dump" ]; then
    candidate="$(printf '%s\n' "$dump" | awk "$FIND_SERVER_AWK")"
    if [ -n "$candidate" ] && [ -f "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  fi
  # 退一步：任意已含我们 include 行的文件（disable / 半残状态用）
  candidate="$(grep_conf_files "$MANAGED_TAG" | head -1)"
  [ -n "$candidate" ] && { printf '%s' "$candidate"; return 0; }
  return 1
}

is_enabled() {
  [ -f "$SNIPPET" ] || return 1
  grep -rqsF --exclude-dir="$BACKUP_GLOB" -e "$INCLUDE_LINE" "$CONF_ROOT" || return 1
  return 0
}

# snippet 丢了但 include 还留着 → nginx -t 会报 include 文件不存在，清掉这条残行
cleanup_stale_include() {
  local f cleaned=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    log "发现残留 include（snippet 已不存在），正在清理：${f}"
    remove_line_exact "$f" "$INCLUDE_LINE"
    cleaned=1
  done <<EOF
$(grep_conf_files "$MANAGED_TAG")
EOF
  [ "$cleaned" = 1 ] && log "已清理残留 include 行"
  return 0
}

status_json() {
  local enabled=false reason="" server_file="" version=""
  is_enabled && enabled=true
  if ! command -v "$NGINX_BIN" >/dev/null 2>&1; then
    reason="未安装 nginx"
  elif [ ! -f "$MAIN_CONF" ]; then
    reason="找不到主配置 ${MAIN_CONF}"
  else
    version="$("$NGINX_BIN" -v 2>&1 | head -1)"
    server_file="$(find_server_file || true)"
    [ -n "$server_file" ] || reason="没找到监听 80 端口的 server 块（需手工把 include 加进去）"
  fi
  printf '{"enabled":%s,"subPath":"%s","target":"%s","snippet":"%s","serverFile":"%s","nginxVersion":"%s","reason":"%s"}' \
    "$enabled" "$SUB_PATH" "$TARGET" "$SNIPPET" "${server_file//\"/}" "${version//\"/}" "${reason//\"/}"
}

snippet_body() {
  cat <<EOF
${BEGIN}
# 由 deploy/scripts/nginx-proxy-toggle.sh 生成（${ACTION} 于 $(date '+%F %T')）
# 关闭方式：bash deploy/scripts/nginx-proxy-toggle.sh disable --path ${SUB_PATH}
location = ${SUB_PATH} { return 301 ${SUB_PATH}/; }
location ${SUB_PATH}/ {
    # 注意：proxy_pass 结尾**不带**斜杠 → 保留 ${SUB_PATH}/ 前缀
    # （transmission WebUI 内部用的是绝对路径，去掉前缀会 404）
    proxy_pass http://${TARGET};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    # 允许上传 .torrent
    client_max_body_size 100m;
}
${END}
EOF
}

preview() {
  if ! command -v "$NGINX_BIN" >/dev/null 2>&1; then
    die "未安装 nginx（NGINX_BIN=$NGINX_BIN）"
  fi
  local server_file
  server_file="$(find_server_file || true)"
  log "将写入：${SNIPPET}"
  snippet_body | sed 's/^/    /'
  if [ -n "$server_file" ]; then
    log "并会在 ${server_file} 的 80 端口 server 块里插入："
    log "    ${INCLUDE_LINE}"
  else
    warn "没自动定位到 80 端口 server 块：需要你手工把上面这行 include 加进 server 块"
  fi
  printf 'TTDL_NGINX_PROXY_RESULT=%s\n' "$(status_json)"
}

enable() {
  command -v "$NGINX_BIN" >/dev/null 2>&1 || die "未安装 nginx（NGINX_BIN=$NGINX_BIN）"
  [ -f "$MAIN_CONF" ] || die "找不到主配置 ${MAIN_CONF}"

  # 半残状态（snippet 没了、include 还在）先清理，否则 nginx -t 必然失败
  if [ ! -f "$SNIPPET" ] && [ -n "$(grep_conf_files "$MANAGED_TAG")" ]; then
    cleanup_stale_include
  fi

  if ! nginx_ok; then
    warn "当前 nginx 配置本身就有问题，先修好再开启："
    nginx_test_output | sed 's/^/    /' >&2
    die "nginx -t 未通过，未做任何改动"
  fi

  if is_enabled; then
    log "已经开启（include 与 snippet 都在），无需重复操作"
    printf 'TTDL_NGINX_PROXY_RESULT=%s\n' "$(status_json)"
    return 0
  fi

  local server_file
  server_file="$(find_server_file || true)"
  [ -n "$server_file" ] || die "没找到监听 80 端口的 server 块，无法自动插入 include（可先跑 preview 看要手工加什么）"

  # 同一个 server 块里若已有别人写的同名 location，nginx 会报 duplicate location → 先劝退
  local conflict
  conflict="$(grep -nF -e "location ${SUB_PATH}" -e "location = ${SUB_PATH}" "$server_file" 2>/dev/null | grep -vF "$MANAGED_TAG" || true)"
  if [ -n "$conflict" ]; then
    warn "${server_file} 里已经有 ${SUB_PATH} 的 location，不能重复添加："
    printf '%s\n' "$conflict" | sed 's/^/    /' >&2
    die "请先手工处理该 location（或换一个 --path），未做任何改动"
  fi

  # 备份
  local backup_dir="${CONF_ROOT}/ttdownload-backup-$(date +%Y%m%d-%H%M%S)"
  local server_real
  server_real="$(resolve_link "$server_file")"
  mkdir -p "$backup_dir"
  cp -a "$server_real" "$backup_dir/" 2>/dev/null || true
  [ -f "$SNIPPET" ] && cp -a "$SNIPPET" "$backup_dir/" 2>/dev/null || true
  log "已备份到 ${backup_dir}（$(basename "$server_real")${server_file:+，符号链接 $server_file 保持不动}）"

  mkdir -p "$SNIPPET_DIR"
  snippet_body > "$SNIPPET"
  log "已写入 snippet：${SNIPPET}"

  # 插到该文件里 80 端口 server 块的 "server {" 之后
  local listen_line srv_line
  listen_line="$(grep -nE "^[[:space:]]*listen[[:space:]]+([^;]*:)?80([[:space:];]|$)" "$server_file" | head -1 | cut -d: -f1)"
  srv_line="$(awk -v ln="${listen_line:-1}" 'NR <= ln && /^[[:space:]]*server[[:space:]]*\{/ { last = NR } END { print last }' "$server_file")"
  [ -n "$srv_line" ] || srv_line="${listen_line:-1}"
  insert_line_after "$server_file" "$srv_line" "    ${INCLUDE_LINE}"
  log "已在 ${server_file}:${srv_line} 插入 include"

  if nginx_ok; then
    reload_nginx
    log "✅ 已开启：http://<你的域名>${SUB_PATH}/web/  →  http://${TARGET}"
  else
    warn "nginx -t 失败，正在回滚："
    nginx_test_output | sed 's/^/    /' >&2
    cp -a "${backup_dir}/$(basename "$server_real")" "$server_real" 2>/dev/null || true
    rm -f "$SNIPPET"
    nginx_ok && reload_nginx
    die "配置有误，已回滚（未生效）"
  fi
  printf 'TTDL_NGINX_PROXY_RESULT=%s\n' "$(status_json)"
}

disable() {
  local removed=0 f
  if [ -f "$SNIPPET" ] || [ -n "$(grep_conf_files "$MANAGED_TAG")" ]; then
    # 从所有配置里移除 include 行（可能有多个文件引用）
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      remove_line_exact "$f" "$INCLUDE_LINE"
      log "已从 ${f} 移除 include"
      removed=1
    done <<EOF
$(grep_conf_files "$MANAGED_TAG")
EOF
    if [ -f "$SNIPPET" ]; then
      rm -f "$SNIPPET" && log "已删除 snippet：${SNIPPET}" && removed=1
    fi
  else
    log "本来就没有开启（snippet 不存在）"
  fi
  if command -v "$NGINX_BIN" >/dev/null 2>&1 && [ -f "$MAIN_CONF" ]; then
    if nginx_ok; then
      reload_nginx
    else
      warn "配置检查未通过，请手工确认："
      nginx_test_output | sed 's/^/    /' >&2
    fi
  fi
  [ "$removed" = 1 ] && log "✅ 已关闭：外界无法再访问 ${SUB_PATH}/"
  printf 'TTDL_NGINX_PROXY_RESULT=%s\n' "$(status_json)"
}

case "$ACTION" in
  status)  printf 'TTDL_NGINX_PROXY_RESULT=%s\n' "$(status_json)" ;;
  preview|print) preview ;;
  enable)  enable ;;
  disable) disable ;;
  *) die "未知动作：${ACTION}（status|preview|enable|disable）" ;;
esac
