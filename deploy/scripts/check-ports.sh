#!/usr/bin/env bash
# =============================================================================
#  端口可达性探测：本机监听 / 本机防火墙 / 外部是否真的能访问
#
#  为什么需要它：服务器上"服务起来了"不等于"外面能访问"。
#  常见的三道墙：① 服务没监听在 0.0.0.0 ② 本机防火墙(ufw/iptables/nft) ③ 云厂商安全组
#  前两道本机可查，第三道只能从**外部**探测 —— 本脚本会借助公共探测服务做真实外部测试。
#
#  用法：
#      sudo bash deploy/scripts/check-ports.sh                 # 默认探测 22 80 443 8080 和 .env 里的 PORT
#      sudo bash deploy/scripts/check-ports.sh 8080 3000       # 指定端口
#      sudo bash deploy/scripts/check-ports.sh --no-external   # 跳过外部探测（无外网时）
#
#  输出：一张表 + 结论 + 建议（例如"8080 外网不可达，但 80 可达 → 建议用 nginx 子路径反代"）
#  只读脚本：不修改任何配置。
# =============================================================================
set -u

MARK() { printf '\n===== %s =====\n' "$1"; }
OK()   { printf '  [OK]   %s\n' "$1"; }
BAD()  { printf '  [BAD]  %s\n' "$1"; }
INFO() { printf '  [INFO] %s\n' "$1"; }
WARN() { printf '  [WARN] %s\n' "$1"; }

EXTERNAL=1
PORTS=()
for a in "$@"; do
  case "$a" in
    --no-external) EXTERNAL=0 ;;
    *[!0-9]*) ;;
    *) PORTS+=("$a") ;;
  esac
done

# 项目目录（用于读 .env 里的 PORT）
PROJ=""
for d in "$(pwd)" /home/*/ttdownload-web /root/ttdownload-web /opt/ttdownload-web; do
  if [ -f "$d/package.json" ] && [ -f "$d/web/package.json" ]; then PROJ="$d"; break; fi
done
APP_PORT=""
if [ -n "$PROJ" ] && [ -f "$PROJ/.env" ]; then
  APP_PORT="$(grep -hE '^PORT=' "$PROJ/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
fi
APP_PORT="${APP_PORT:-8080}"

# 默认端口集合：22(ssh) 80(http) 443(https) 应用端口
if [ ${#PORTS[@]} -eq 0 ]; then
  PORTS=(22 80 443 "$APP_PORT")
else
  PORTS+=("$APP_PORT")
fi
# 去重
UNIQ=()
for p in "${PORTS[@]}"; do
  skip=0
  for u in "${UNIQ[@]:-}"; do [ "$u" = "$p" ] && skip=1 && break; done
  [ "$skip" = 0 ] && UNIQ+=("$p")
done
PORTS=("${UNIQ[@]}")

echo "ttdownload-web 端口可达性探测"
echo "时间：$(date '+%F %T %z')   主机：$(hostname)"

MARK "0. 公网出口 IP"
PUBLIC_IP=""
for url in https://api.ipify.org https://ifconfig.me/ip https://ipinfo.io/ip; do
  PUBLIC_IP="$(curl -fsS --max-time 8 "$url" 2>/dev/null | tr -d ' \n' || true)"
  [ -n "$PUBLIC_IP" ] && break
done
if [ -n "$PUBLIC_IP" ]; then OK "公网 IP：${PUBLIC_IP}"; else BAD "取不到公网 IP（无外网？）"; fi
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$LAN_IP" ] && INFO "内网 IP：${LAN_IP}"
ROUTE_SRC="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
if printf '%s' "${ROUTE_SRC:-}" | grep -qE '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)'; then
  INFO "本机处于 NAT 之后（出口源地址 ${ROUTE_SRC}）：外部探测反映的是**网关/VPN 的公网 IP**，"
  INFO "  若网关没做端口转发、或走的是 VPN 代理，探测结果可能不代表你需要的入站可达性 —— 请以手机 4G 实测为准"
fi

MARK "1. 本机监听情况（服务有没有起来）"
# 返回某个端口的本地监听地址（空 = 没监听）。优先 ss，退回 /proc/net/tcp，跨发行版都可用。
port_listen_addr() {
  local p="$1" hex
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :${p}" 2>/dev/null | awk '{print $4}' | head -1
    return
  fi
  if [ -r /proc/net/tcp ]; then
    hex="$(printf '%04X' "$p")"
    awk -v h=":${hex}" 'NR>1 && $4=="0A" {split($2,a,":"); if (":"a[2]==h) {print a[1]; exit}}' /proc/net/tcp
    return
  fi
  echo ""
}
classify_listen() {
  # $1=端口  $2=监听地址
  case "$2" in
    "") return 1 ;;
    00000000:*|0.0.0.0:*|*:::*) return 0 ;;
    0100007F:*|127.0.0.1:*|::1:*) return 2 ;;
    *) return 0 ;;
  esac
}
if ! command -v ss >/dev/null 2>&1 && [ ! -r /proc/net/tcp ]; then
  WARN "该系统没有 ss 也没有 /proc/net/tcp，跳过监听检查（本脚本面向 Linux 服务器）"
else
  for p in "${PORTS[@]}"; do
    ADDR="$(port_listen_addr "$p")"
    if [ -z "$ADDR" ]; then
      BAD "端口 ${p}：没有进程监听"
      continue
    fi
    if classify_listen "$p" "$ADDR"; then
      OK "端口 ${p}：已监听（${ADDR}）→ 允许外部连接"
    else
      BAD "端口 ${p}：只监听在 ${ADDR} → 外部访问不到（改 0.0.0.0，或走 nginx 反向代理）"
    fi
  done
fi

MARK "2. 本机防火墙规则"
FW_FOUND=0
if command -v ufw >/dev/null 2>&1; then
  UFW_STATE="$(ufw status 2>/dev/null | head -1 || true)"
  INFO "ufw：${UFW_STATE}"
  if printf '%s' "$UFW_STATE" | grep -qi "active"; then
    FW_FOUND=1
    for p in "${PORTS[@]}"; do
      if ufw status 2>/dev/null | grep -qE "(^|[[:space:]])${p}(/tcp)?([[:space:]]|$)"; then
        OK "ufw 已放行 ${p}"
      else
        BAD "ufw 未放行 ${p}（可执行：ufw allow ${p}/tcp）"
      fi
    done
  else
    INFO "ufw 未启用（不等于没墙：也可能用 iptables/nft/云安全组）"
  fi
fi
if command -v nft >/dev/null 2>&1 && nft list ruleset >/dev/null 2>&1; then
  DROPS="$(nft list ruleset 2>/dev/null | grep -ciE "drop|reject" || true)"
  [ "${DROPS:-0}" -gt 0 ] && { FW_FOUND=1; INFO "nftables 里有 ${DROPS} 条 drop/reject 规则（明细：nft list ruleset）"; }
fi
if command -v iptables >/dev/null 2>&1; then
  POLICY="$(iptables -S INPUT 2>/dev/null | head -1 || true)"
  [ -n "$POLICY" ] && INFO "iptables INPUT 默认策略：${POLICY#-P INPUT }"
  for p in "${PORTS[@]}"; do
    if iptables -S 2>/dev/null | grep -qE "\-\-dport ${p}([[:space:]]|$)"; then
      FW_FOUND=1
      if iptables -S 2>/dev/null | grep -E "\-\-dport ${p}([[:space:]]|$)" | grep -q "ACCEPT"; then OK "iptables 有放行 ${p} 的规则"; else WARN "iptables 有涉及 ${p} 的规则但非 ACCEPT，请核对"; fi
    fi
  done
fi
[ "$FW_FOUND" = 0 ] && INFO "本机未发现明显的防火墙规则（那"外网不通"多半是云厂商安全组）"

MARK "3. 外部可达性（真实从公网探测）"
EXT_RESULT=""
if [ "$EXTERNAL" = 0 ]; then
  INFO "已按要求跳过外部探测（--no-external）"
elif [ -z "$PUBLIC_IP" ]; then
  WARN "没有公网 IP，跳过外部探测"
else
  for p in "${PORTS[@]}"; do
    RESP="$(curl -fsS --max-time 12 -H 'Accept: application/json' \
      "https://check-host.net/check-tcp?host=${PUBLIC_IP}:${p}&max_nodes=3" 2>/dev/null || true)"
    RID="$(printf '%s' "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('request_id',''))" 2>/dev/null || true)"
    if [ -z "$RID" ]; then
      WARN "端口 ${p}：外部探测服务不可用（网络受限），无法自动确认"
      continue
    fi
    sleep 8
    RES="$(curl -fsS --max-time 12 -H 'Accept: application/json' \
      "https://check-host.net/check-result/${RID}" 2>/dev/null || true)"
    SUMMARY="$(printf '%s' "$RES" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('ERR|0|0'); raise SystemExit
ok=bad=0
for node,val in d.items():
    if not val: continue
    r=val[0]
    if isinstance(r, dict) and 'time' in r: ok+=1
    else: bad+=1
print(f'{ok}|{bad}')
" 2>/dev/null || echo "ERR|0|0")"
    OK_CNT="${SUMMARY%%|*}"; BAD_CNT="${SUMMARY##*|}"
    if [ "$OK_CNT" = "ERR" ]; then
      WARN "端口 ${p}：外部探测结果解析失败"
      VERDICT="unknown"
    elif [ "${OK_CNT:-0}" -gt 0 ] && [ "${BAD_CNT:-0}" -eq 0 ]; then
      OK "端口 ${p}：外部**可达**（${OK_CNT} 个探测点全部可达）"
      VERDICT="reachable"
    elif [ "${OK_CNT:-0}" -gt 0 ]; then
      WARN "端口 ${p}：**部分探测点可达**（${OK_CNT} 可达 / ${BAD_CNT} 不可达）——可能是地区/运营商差异，用手机实测确认"
      VERDICT="partial"
    else
      BAD "端口 ${p}：外部**不可达**（0/${BAD_CNT} 可达）"
      VERDICT="unreachable"
    fi
    EXT_RESULT="${EXT_RESULT}${p}=${VERDICT}(${OK_CNT}/${BAD_CNT}); "
  done
fi

MARK "4. 结论与建议"
if [ -n "$(port_listen_addr "$APP_PORT")" ]; then
  OK "应用端口 ${APP_PORT} 已监听"
else
  BAD "应用端口 ${APP_PORT} 没有在监听：先确认服务已启动（systemctl status ttdownload-web）"
fi
PORT80_LISTEN="$(port_listen_addr 80)"
if [ -n "$EXT_RESULT" ]; then
  INFO "外部探测汇总：${EXT_RESULT}"
  if printf '%s' "$EXT_RESULT" | grep -q "${APP_PORT}=unreachable"; then
    if [ "${PORT80_LISTEN:-0}" != "0" ]; then
      INFO "→ ${APP_PORT} 外网不可达、但 80 端口有服务监听（多半是 nginx）：**建议用 nginx 子路径反向代理**，"
      INFO "   这样不用开放 ${APP_PORT}，也不影响别人用 80 端口根路径："
      INFO "     sudo bash deploy/scripts/setup-nginx-proxy.sh            # 默认子路径 /ttdownload"
      INFO "     sudo bash deploy/scripts/setup-nginx-proxy.sh --path /dl # 自定义子路径"
    else
      INFO "→ ${APP_PORT} 外网不可达，且本机没有 80 端口服务："
      INFO "   要么在云厂商安全组放行 ${APP_PORT}/tcp，要么装 nginx 后用子路径反代（setup-nginx-proxy.sh）"
    fi
  fi
fi
echo
echo "提示：外部探测依赖公共探测服务（check-host.net），偶尔会抽风；"
echo "      最可靠的最终确认是用手机 4G/5G 访问 http://${PUBLIC_IP:-<公网IP>}:${APP_PORT}/api/health"
echo "===== 探测结束（只读，没有任何改动）====="
exit 0
