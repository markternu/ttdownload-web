#!/usr/bin/env bash
# =============================================================================
#  修复脚本：归位项目目录属主（sudo 部署导致的 root:root 文件）
#
#  症状（都是这个原因）：
#    - 以普通用户执行 git pull / npm ci 报 "insufficient permission for adding an object
#      to repository database .git/objects" 或 "EACCES: permission denied, open .../dist/..."
#    - .git / node_modules / dist / public 属主变成 root:root（因为 `sudo ./deploy.sh`
#      以前是以 root 跑 git/npm/构建）
#    - 编辑器 / VSCode Remote 保存文件失败
#
#  这个脚本做什么：
#    1) 找出项目目录与"应该的属主"（目录本身的属主，或第一个普通用户）
#    2) 把项目目录下所有文件/目录（含 .git、node_modules、dist、public）chown 给该属主
#    3) 顺手修一下 git 的 safe.directory（避免 root 读他人仓库被拒）
#    4) 打印前后对比，确认没有残留 root 所有的文件
#
#  安全说明：只改属主，不改权限位、不删文件；服务以 root 运行，改属主后一切照常。
#  回滚：没有需要回滚的东西（属主不影响程序运行；如需改回，chown -R root:root <目录>）。
#
#  预期输出：结尾出现「属主归位完成，剩余 root 所有文件：0」
# =============================================================================
set -u

MARK() { printf '\n===== %s =====\n' "$1"; }
OK()   { printf '  [OK]   %s\n' "$1"; }
BAD()  { printf '  [BAD]  %s\n' "$1"; }
INFO() { printf '  [INFO] %s\n' "$1"; }
die()  { printf '  [FAIL] %s\n' "$1" >&2; exit 1; }

echo "ttdownload-web 修复脚本：项目目录属主归位"
echo "时间：$(date '+%F %T %z')   主机：$(hostname)   用户：$(id -un)"

[ "$(id -u)" = "0" ] || die "需要 root：sudo bash deploy/scripts/fix-ownership.sh"

MARK "1. 定位项目目录与目标属主"
PROJ=""
for d in "$(pwd)" /home/*/ttdownload-web /root/ttdownload-web /opt/ttdownload-web; do
  if [ -f "$d/package.json" ] && [ -f "$d/web/package.json" ]; then PROJ="$d"; break; fi
done
[ -n "$PROJ" ] || die "没找到项目目录（应包含 package.json 与 web/package.json）"
OK "项目目录：${PROJ}"

TARGET="$(stat -c '%U' "$PROJ" 2>/dev/null || echo root)"
if [ "${TARGET}" = "root" ]; then
  for u in $(ls /home 2>/dev/null); do
    id "$u" >/dev/null 2>&1 && TARGET="$u" && break
  done
fi
[ -n "${TARGET}" ] || die "无法确定目标属主"
OK "目标属主：${TARGET}"

MARK "2. 修复前统计"
BEFORE="$(find "$PROJ" -not -user "$TARGET" 2>/dev/null | wc -l)"
INFO "不属于 ${TARGET} 的文件/目录：${BEFORE} 个"
if [ "${BEFORE}" -gt 0 ]; then
  find "$PROJ" -not -user "$TARGET" 2>/dev/null | head -5 | sed 's/^/    /'
fi
ls -ld "$PROJ/.git" "$PROJ/node_modules" "$PROJ/dist" "$PROJ/public" 2>/dev/null | awk '{print "    ", $3":"$4, $9}'

MARK "3. 归位（chown -R ${TARGET}，含 .git / node_modules / dist / public）"
if chown -R "${TARGET}:${TARGET}" "$PROJ"; then
  OK "已归位"
else
  BAD "chown 失败（可能有只读挂载或特殊文件），请看上面的报错"
fi

MARK "4. 修复 git safe.directory（root 读普通用户仓库）"
if command -v git >/dev/null 2>&1; then
  if git config --global --add safe.directory "$PROJ" 2>/dev/null; then
    OK "已加入 root 的 git safe.directory：${PROJ}"
  else
    INFO "写入 safe.directory 失败（不影响，版本号读不到而已）"
  fi
fi

MARK "5. 复核"
AFTER="$(find "$PROJ" -not -user "$TARGET" 2>/dev/null | wc -l)"
INFO "仍不属于 ${TARGET} 的文件/目录：${AFTER} 个"
[ "${AFTER}" -eq 0 ] && OK "属主归位完成，剩余 root 所有文件：0" || BAD "仍有 ${AFTER} 个未归位（见上）"
ls -ld "$PROJ/.git" "$PROJ/node_modules" "$PROJ/dist" "$PROJ/public" 2>/dev/null | awk '{print "    ", $3":"$4, $9}'

MARK "6. 验证普通用户可以 git / npm"
if sudo -u "${TARGET}" -H bash -c "cd '${PROJ}' && git -c safe.directory='*' status --porcelain >/dev/null 2>&1 && echo GIT_OK"; then
  OK "git 可用（普通用户）"
else
  BAD "git 仍不可用，请把本日志发给开发者"
fi
if sudo -u "${TARGET}" -H bash -c "cd '${PROJ}' && touch .write-test && rm -f .write-test && echo WRITE_OK"; then
  OK "目录可写（普通用户）"
else
  BAD "目录仍不可写"
fi
echo
echo "服务无需重启（只改了属主）。以后用 sudo ./deploy.sh --update 即可。"
echo "===== 修复脚本结束 ====="
exit 0
