#!/usr/bin/env bash
# =============================================================================
#  ttdownload-web 环境体检脚本（只读，不修改任何东西）
#
#  用法：在网页「修复脚本」页上传本文件并执行；或直接 sudo bash diagnose-env.sh
#  作用：把「代码之外」的环境状况打出来（Node/aria2/transmission/yt-dlp/DNS/磁盘/权限/服务），
#        出问题时把输出日志发给开发者，比一个个问要快得多。
# =============================================================================
set -u

MARK() { printf '\n===== %s =====\n' "$1"; }
OK()   { printf '  [OK]   %s\n' "$1"; }
BAD()  { printf '  [BAD]  %s\n' "$1"; }
INFO() { printf '  [INFO] %s\n' "$1"; }

echo "ttdownload-web 环境体检报告"
echo "时间：$(date '+%F %T %z')"
echo "主机：$(hostname)  用户：$(id -un)  内核：$(uname -srm)"

MARK "1. 系统"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  INFO "发行版：${PRETTY_NAME:-$ID $VERSION_ID}"
  INFO "ID=${ID:-?} VERSION_ID=${VERSION_ID:-?}"
fi
if command -v free >/dev/null 2>&1; then
  INFO "架构：$(uname -m)   内存：$(free -h | awk '/Mem:/{print $2" 总 / "$7" 可用"}')"
else
  INFO "架构：$(uname -m)   内存：（无 free 命令，跳过）"
fi
INFO "负载：$(uptime | sed 's/.*load average/load average/')"

MARK "2. Node / npm"
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -v)"; NODE_MAJ="$(node -v | sed 's/^v//' | cut -d. -f1)"
  INFO "node ${NODE_V} / npm $(npm -v 2>/dev/null || echo '?')  （路径 $(command -v node)）"
  if [ "${NODE_MAJ:-0}" -ge 20 ]; then OK "Node 版本符合目标（20+）"
  elif [ "${NODE_MAJ:-0}" -ge 18 ]; then BAD "Node ${NODE_V} 可用但不是目标版本（建议 20；sudo ./deploy.sh 会升级）"
  else BAD "Node ${NODE_V} 过低（需要 >= 18.17）"; fi
else
  BAD "未安装 node"
fi
if [ -f /etc/apt/sources.list.d/nodesource.list ]; then
  INFO "NodeSource 源：$(grep -h '^deb' /etc/apt/sources.list.d/nodesource.list 2>/dev/null | head -1)"
fi

MARK "3. 项目与原生模块（better-sqlite3）"
PROJ=""
for d in "$(pwd)" /home/*/ttdownload-web /root/ttdownload-web /opt/ttdownload-web; do
  if [ -f "$d/package.json" ] && [ -f "$d/dist/server.js" ]; then PROJ="$d"; break; fi
done
if [ -n "$PROJ" ]; then
  OK "项目目录：$PROJ"
  GIT_DESC="$(git -C "$PROJ" -c safe.directory='*' log --oneline -1 2>/dev/null || true)"
  if [ -n "$GIT_DESC" ]; then
    INFO "git：${GIT_DESC}"
  else
    BAD "读不到 git 版本（不是 git 仓库，或 git 的 dubious ownership 限制）"
    INFO "  若确实需要：git config --global --add safe.directory \"$PROJ\""
  fi
  if [ -d "$PROJ/node_modules/better-sqlite3" ]; then
    if (cd "$PROJ" && node -e "require('better-sqlite3')" >/dev/null 2>&1); then
      OK "better-sqlite3 可在当前 Node 下加载（ABI 匹配）"
    else
      BAD "better-sqlite3 加载失败：Node 升级后需要重建（cd $PROJ && npm ci 或 npm rebuild better-sqlite3）"
    fi
  else
    BAD "node_modules/better-sqlite3 不存在（需要 npm ci）"
  fi
else
  BAD "没找到项目目录（含 package.json 与 dist/server.js）"
fi

MARK "4. 服务与端口"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files 2>/dev/null | grep -q '^ttdownload-web.service'; then
    INFO "ttdownload-web：$(systemctl is-active ttdownload-web 2>/dev/null) / $(systemctl is-enabled ttdownload-web 2>/dev/null)"
  else
    BAD "未注册 ttdownload-web.service（需要 sudo ./deploy.sh）"
  fi
  INFO "transmission-daemon：$(systemctl is-active transmission-daemon 2>/dev/null || echo 未知)"
else
  INFO "无 systemd（容器环境？）"
fi
for p in 8080 6800 9091; do
  if command -v ss >/dev/null 2>&1; then
    if ss -ltnp 2>/dev/null | grep -q ":${p} "; then OK "端口 ${p} 正在监听"; else INFO "端口 ${p} 未监听"; fi
  fi
done

MARK "5. 下载引擎"
if command -v aria2c >/dev/null 2>&1; then
  OK "aria2c：$(aria2c --version 2>/dev/null | head -1)"
  if curl -fsS --max-time 4 http://127.0.0.1:6800/jsonrpc -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":"x","method":"aria2.getVersion"}' >/dev/null 2>&1; then
    OK "aria2 RPC 6800 可用"
  else
    BAD "aria2 RPC 6800 连不上（看日志 grep 'MARK:ARIA2_DAEMON'；端口占用/权限/state 目录可写）"
  fi
else
  BAD "未安装 aria2c（sudo apt install -y aria2）"
fi
if command -v transmission-remote >/dev/null 2>&1; then
  OK "transmission-remote：$(transmission-remote --version 2>/dev/null | head -1)"
else
  INFO "transmission-remote 未安装（后端只用 JSON-RPC，不装也不影响）"
fi

MARK "6. yt-dlp"
if command -v yt-dlp >/dev/null 2>&1; then
  OK "yt-dlp：$(yt-dlp --version 2>/dev/null)"
  INFO "python3：$(python3 -V 2>&1)"
  if yt-dlp --list-impersonate-targets >/dev/null 2>&1; then
    OK "支持 --impersonate（装了 curl_cffi）"
  else
    INFO "不支持 --impersonate（可选：pip3 install -U 'yt-dlp[default]'）"
  fi
  # 找 cookies：优先 .env 的 YTDLP_COOKIES_FILE，其次默认路径 state/cookies.txt
  COOKIE_FILE=""
  ENV_COOKIE="$(grep -h '^YTDLP_COOKIES_FILE=' "${PROJ:-.}/.env" 2>/dev/null | cut -d= -f2- || true)"
  if [ -n "${ENV_COOKIE:-}" ] && [ -f "${ENV_COOKIE}" ]; then
    COOKIE_FILE="${ENV_COOKIE}"
  elif [ -f "${ROOT:-/ttdownload}/state/cookies.txt" ]; then
    COOKIE_FILE="${ROOT:-/ttdownload}/state/cookies.txt"
  fi
  if [ -n "${COOKIE_FILE}" ]; then
    OK "cookies：${COOKIE_FILE}（$(du -h "${COOKIE_FILE}" 2>/dev/null | cut -f1)，更新于 $(date -r "${COOKIE_FILE}" '+%F %T' 2>/dev/null || echo '?'))"
    COOKIE_ARGS="--cookies ${COOKIE_FILE}"
  else
    INFO "cookies：未配置（会员/需登录/年龄限制视频会失败；在网页「设置 → 公开视频（yt-dlp）」上传）"
    COOKIE_ARGS=""
  fi

  INFO "正在试解析一个公开测试视频（不带 cookies，最多 25 秒）…"
  if OUT="$(timeout 25 yt-dlp -J --no-warnings --no-playlist --socket-timeout 15 \
        'https://www.youtube.com/watch?v=jNQXAC9IVRw' 2>&1)"; then
    OK "不带 cookies 解析成功：$(printf '%s' "$OUT" | head -c 160)"
  else
    BAD "不带 cookies 解析失败：$(printf '%s' "$OUT" | tail -2 | tr '\n' ' ')"
    INFO "→ 常见原因：出口被 YouTube 风控（需要 cookies 或 --proxy）"
  fi
  if [ -n "${COOKIE_ARGS}" ]; then
    INFO "再用 cookies 试一次…"
    # shellcheck disable=SC2086
    if OUT2="$(timeout 25 yt-dlp -J --no-warnings --no-playlist --socket-timeout 15 ${COOKIE_ARGS} \
          'https://www.youtube.com/watch?v=jNQXAC9IVRw' 2>&1)"; then
      OK "带 cookies 解析成功 → cookies 有效，会员/受限视频应可下载"
    else
      BAD "带 cookies 仍失败：$(printf '%s' "$OUT2" | tail -2 | tr '\n' ' ')"
      INFO "→ cookies 可能过期（重新导出上传），或该出口需要 --proxy"
    fi
  fi
else
  BAD "未安装 yt-dlp（sudo apt install -y yt-dlp 或 pip3 install -U yt-dlp）"
fi
for c in ffmpeg openssl zip unzip jq git; do
  if command -v "$c" >/dev/null 2>&1; then OK "${c}：$(command -v "$c")"; else BAD "缺少 $c"; fi
done

# 解析主机名（getent 不一定有：macOS 用 python3/dscacheutil，Linux 用 getent）
resolve_host() {
  local h="$1" ip=""
  if command -v getent >/dev/null 2>&1; then
    ip="$(getent hosts "$h" 2>/dev/null | awk 'NR==1{print $1}')"
  fi
  if [ -z "$ip" ] && command -v python3 >/dev/null 2>&1; then
    ip="$(python3 -c 'import socket,sys;print(socket.gethostbyname(sys.argv[1]))' "$h" 2>/dev/null)"
  fi
  if [ -z "$ip" ] && command -v dscacheutil >/dev/null 2>&1; then
    ip="$(dscacheutil -q host -a name "$h" 2>/dev/null | awk '/^ip_address: /{print $2; exit}')"
  fi
  if [ -z "$ip" ] && command -v nslookup >/dev/null 2>&1; then
    ip="$(nslookup "$h" 2>/dev/null | awk '/^Address: /{print $2; exit}')"
  fi
  printf '%s' "$ip"
}

MARK "7. 网络"
if [ -r /etc/resolv.conf ]; then
  INFO "DNS 服务器：$(awk '/^nameserver/{printf "%s ", $2}' /etc/resolv.conf)"
fi
for host in www.youtube.com redirector.googlevideo.com github.com; do
  IP="$(resolve_host "$host")"
  if [ -n "$IP" ]; then OK "$host → $IP"; else BAD "$host 解析失败"; fi
done
for url in https://www.google.com/generate_204 https://www.youtube.com/robots.txt https://github.com/robots.txt; do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)"
  case "$CODE" in
    2*|3*) OK "$url → HTTP $CODE" ;;
    4*)    INFO "$url → HTTP ${CODE}（链路可达，被目标站拒绝/限流）" ;;
    *)     BAD "$url → ${CODE}（连不上）" ;;
  esac
done
INFO "代理环境变量：$(env | grep -i proxy | tr '\n' ' ' || echo 无)"

MARK "8. 下载目录与磁盘"
ROOT="${DOWNLOAD_ROOT:-/ttdownload}"
if [ -d "$ROOT" ]; then
  OK "下载根目录存在：${ROOT}（属主 $(stat -c '%U:%G' "$ROOT" 2>/dev/null || echo '?'))"
  INFO "子目录：$(ls "$ROOT" 2>/dev/null | tr '\n' ' ')"
  for sub in state state/logs state/scripts xiaofeizhe_downd downd_aria2_path; do
    [ -w "$ROOT/$sub" ] && OK "$sub 可写" || INFO "$sub 不存在或不可写"
  done
else
  BAD "下载根目录不存在：$ROOT"
fi
df -h "$ROOT" 2>/dev/null | sed 's/^/  /'
[ -f "$ROOT/state/app.log" ] && INFO "应用日志：$ROOT/state/app.log（$(du -h "$ROOT/state/app.log" 2>/dev/null | cut -f1)）"

MARK "9. 最近的服务日志（结尾 15 行）"
journalctl -u ttdownload-web -n 15 --no-pager 2>/dev/null | sed 's/^/  /' || INFO "（读不到 journalctl 日志）"

echo
echo "===== 体检结束（本脚本只读，没有修改任何文件）====="
exit 0
