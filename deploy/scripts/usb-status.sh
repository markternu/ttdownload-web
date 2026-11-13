#!/usr/bin/env bash
# =============================================================================
#  U 盘状态一键体检（只读，不改任何东西）
#  用法：sudo bash deploy/scripts/usb-status.sh
# =============================================================================
set -uo pipefail
USB_MP=/mnt/usb
CONSUMER="$USB_MP/ttdownload/xiaofeizhe_downd"
SD_DIR=/ttdownload/xiaofeizhe_downd
OLD_MEDIA=/media/mypi/upo/ttdownload/xiaofeizhe_downd

echo "===== 1) 挂载情况 ====="
findmnt -rn -o TARGET,SOURCE,FSTYPE 2>/dev/null | grep -E "$USB_MP|/media/" || echo "（没有 /mnt/usb 或 /media 挂载）"
echo
lsblk -f 2>/dev/null | grep -E 'exfat|vfat|ntfs|ext4' || true
echo

echo "===== 2) 目录 / 数量 ====="
ls -ld "$USB_MP" 2>/dev/null || echo "缺少 $USB_MP"
echo "U 盘成品数   : $(ls "$CONSUMER" 2>/dev/null | wc -l)"
echo "SD 待搬数    : $(ls "$SD_DIR" 2>/dev/null | wc -l)"
echo "旧 /media 残留: $(ls "$OLD_MEDIA" 2>/dev/null | wc -l)"
echo "U 盘剩余空间 : $(df -h "$USB_MP" 2>/dev/null | awk 'NR==2{print $4}')"
echo "正在拷贝的 .part："
ls -lh "$CONSUMER"/*.part 2>/dev/null | tail -5 || echo "（没有 .part，说明没有进行中的拷贝）"
echo

echo "===== 3) 最近 U 盘日志 ====="
journalctl -u ttdownload-web -n 300 --no-pager 2>/dev/null | grep -E 'USB|拷贝|挂载|自愈' | tail -15 || echo "（无）"
echo

echo "===== 4) 服务 ====="
echo -n "ttdownload-web: "; systemctl is-active ttdownload-web 2>/dev/null || true
curl -s --max-time 5 http://127.0.0.1:8080/api/health 2>/dev/null || echo "（健康检查失败）"
echo
