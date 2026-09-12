#!/usr/bin/env bash
# =============================================================================
#  修复脚本：把 yt-dlp 升级到最新版（并顺手补齐 --impersonate 支持）
#
#  适用场景（都是 yt-dlp 层面的问题，不是你的网络/代码问题）：
#    - YouTube 报 "The page needs to be reloaded."（yt-dlp 已知问题，多见于旧版本）
#    - YouTube 报 "Sign in to confirm you're not a bot."（新版 + cookies 一般可解）
#    - 报 "Impersonate target \"chrome\" is not available."（缺 curl_cffi，属可选能力）
#    - 某些站点突然解析失败、格式列不全（多为站点改版，新版 yt-dlp 通常已适配）
#
#  这个脚本做什么：
#    1) 记录升级前的版本
#    2) 优先用 pip 升级（Debian/树莓派 OS 走 --break-system-packages；Ubuntu 22.04 走普通 pip）
#    3) pip 不行就用官方单文件二进制（自带 Python，最省事）
#    4) 顺带尝试安装 curl_cffi（支持 --impersonate，能提高绕过风控的成功率；失败也不影响）
#    5) 打印升级后版本，并用「不带 cookies」「带 cookies」各试解析一次公开视频
#
#  回滚方法：
#    - pip 安装的：pip3 install -U "yt-dlp==<旧版本号>"
#    - apt 安装的：sudo apt-get install --reinstall yt-dlp
#    - 本脚本把头尾版本都写在日志里，直接照着回退即可
#
#  预期输出：结尾出现「yt-dlp 已升级到 <新版本>」以及解析测试结果
# =============================================================================
set -u

MARK() { printf '\n===== %s =====\n' "$1"; }
OK()   { printf '  [OK]   %s\n' "$1"; }
BAD()  { printf '  [BAD]  %s\n' "$1"; }
INFO() { printf '  [INFO] %s\n' "$1"; }

echo "ttdownload-web 修复脚本：升级 yt-dlp"
echo "时间：$(date '+%F %T %z')   主机：$(hostname)   用户：$(id -un)"

# 找项目目录（用于读 .env 里的 cookies 路径与刷新）
PROJ=""
for d in "$(pwd)" /home/*/ttdownload-web /root/ttdownload-web /opt/ttdownload-web; do
  if [ -f "$d/package.json" ] && [ -f "$d/web/package.json" ]; then PROJ="$d"; break; fi
done

MARK "1. 升级前"
OLD_VER="$(yt-dlp --version 2>/dev/null || echo '未安装')"
INFO "yt-dlp：${OLD_VER}"
if command -v yt-dlp >/dev/null 2>&1; then
  INFO "路径：$(command -v yt-dlp)"
  case "$(command -v yt-dlp)" in
    /usr/bin/*) INFO "看起来是 apt 安装的（apt 源里的版本通常偏旧）" ;;
    /usr/local/bin/*) INFO "看起来是 pip 或官方二进制安装的" ;;
  esac
fi
INFO "python3：$(python3 -V 2>&1 || echo '无')"
if yt-dlp --list-impersonate-targets >/dev/null 2>&1; then
  OK "已支持 --impersonate"
else
  INFO "暂不支持 --impersonate（本脚本会尝试补上 curl_cffi）"
fi

MARK "2. 用 pip 升级（首选）"
PIP_OK=0
export DEBIAN_FRONTEND=noninteractive
apt-get install -y python3-pip >/dev/null 2>&1 || true
if pip3 install -U yt-dlp 2>&1 | tail -5; then
  PIP_OK=1
  OK "pip 升级成功"
else
  BAD "普通 pip 升级失败（Debian 13+ 有 PEP 668 限制），改用 --break-system-packages"
  if pip3 install -U --break-system-packages yt-dlp 2>&1 | tail -5; then
    PIP_OK=1
    OK "pip --break-system-packages 升级成功"
  fi
fi

NEW_VER="$(yt-dlp --version 2>/dev/null || echo '未安装')"
if [ "${PIP_OK}" != "1" ] || [ "${NEW_VER}" = "未安装" ]; then
  MARK "3. 退回官方单文件二进制"
  BAD "pip 方式未能升级，尝试官方二进制（放 /usr/local/bin/yt-dlp）"
  if curl -fL --retry 3 -o /usr/local/bin/yt-dlp \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp; then
    chmod +x /usr/local/bin/yt-dlp
    NEW_VER="$(/usr/local/bin/yt-dlp --version 2>/dev/null || echo '未安装')"
    OK "官方二进制已就位：${NEW_VER}"
  else
    BAD "下载官方二进制失败（网络/GitHub 不通）：请检查网络后重试，或直接 sudo apt install -y yt-dlp"
  fi
fi

MARK "4. 可选：安装 curl_cffi（支持 --impersonate，提高过风控成功率）"
if command -v yt-dlp >/dev/null 2>&1 && yt-dlp --list-impersonate-targets >/dev/null 2>&1; then
  OK "已经支持，跳过"
else
  if pip3 install -U --break-system-packages "curl_cffi>=0.5.10" 2>&1 | tail -3; then
    if yt-dlp --list-impersonate-targets >/dev/null 2>&1; then
      OK "curl_cffi 安装成功，现在支持 --impersonate"
    else
      INFO "curl_cffi 装上了但 yt-dlp 仍不支持（可能需要 yt-dlp[default]），不影响主流程"
    fi
  else
    INFO "curl_cffi 安装失败（可选能力，不影响下载）"
  fi
fi

MARK "5. 升级结果与解析测试"
NEW_VER="$(yt-dlp --version 2>/dev/null || echo '未安装')"
if [ "${NEW_VER}" != "未安装" ]; then OK "yt-dlp：${OLD_VER} → ${NEW_VER}"; else BAD "yt-dlp 仍不可用"; fi

# 找 cookies
COOKIE_FILE=""
ENV_COOKIE="$(grep -h '^YTDLP_COOKIES_FILE=' "${PROJ:-.}/.env" 2>/dev/null | cut -d= -f2- || true)"
ROOT="${DOWNLOAD_ROOT:-/ttdownload}"
if [ -n "${ENV_COOKIE:-}" ] && [ -f "${ENV_COOKIE}" ]; then COOKIE_FILE="${ENV_COOKIE}"
elif [ -f "${ROOT}/state/cookies.txt" ]; then COOKIE_FILE="${ROOT}/state/cookies.txt"; fi
if [ -n "${COOKIE_FILE}" ]; then
  INFO "cookies：${COOKIE_FILE}（$(du -h "${COOKIE_FILE}" 2>/dev/null | cut -f1)）"
else
  INFO "cookies：未配置（会员/需登录视频仍会失败）"
fi

TEST_URL="https://www.youtube.com/watch?v=jNQXAC9IVRw"
INFO "不带 cookies 解析测试（最多 25s）…"
if OUT="$(timeout 25 yt-dlp -J --no-warnings --no-playlist --socket-timeout 15 "${TEST_URL}" 2>&1)"; then
  OK "解析成功：$(printf '%s' "${OUT}" | head -c 140)"
else
  BAD "仍失败：$(printf '%s' "${OUT}" | tail -2 | tr '\n' ' ')"
fi
if [ -n "${COOKIE_FILE}" ]; then
  INFO "带 cookies 解析测试（最多 25s）…"
  if OUT2="$(timeout 25 yt-dlp -J --no-warnings --no-playlist --socket-timeout 15 --cookies "${COOKIE_FILE}" "${TEST_URL}" 2>&1)"; then
    OK "带 cookies 解析成功 → cookies 有效"
  else
    BAD "带 cookies 仍失败：$(printf '%s' "${OUT2}" | tail -2 | tr '\n' ' ')"
    INFO "→ 若报 Sign in to confirm / page needs to be reloaded：请重新导出 cookies（只登录目标账号的 Chrome Profile），或稍后重试"
  fi
fi

MARK "6. 让服务用上新版本"
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^ttdownload-web.service'; then
  systemctl restart ttdownload-web
  sleep 3
  INFO "服务：$(systemctl is-active ttdownload-web 2>/dev/null || echo unknown)"
fi
if [ -n "${PROJ}" ]; then
  INFO "接下来在网页上重试任务即可（无需重新部署）"
fi

MARK "7. 尾巴"
echo "  升级前：${OLD_VER}"
echo "  升级后：$(yt-dlp --version 2>/dev/null || echo '未安装')"
echo
echo "===== 修复脚本结束 ====="
exit 0
