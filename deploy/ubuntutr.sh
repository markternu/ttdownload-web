#!/bin/bash

# ============================================================
# Transmission 终极安装配置脚本 v4.0
# 解决多配置文件冲突问题，支持公网部署
# ============================================================

# set -e 会在某些非关键命令失败时退出，所以不使用
# 改为在关键步骤手动检查

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}============================================================${NC}"
echo -e "${BLUE}    Transmission 终极安装配置脚本 v4.0${NC}"
echo -e "${BLUE}============================================================${NC}\n"

# --- 检查 root 权限 ---
if [[ $EUID -ne 0 ]]; then
   echo -e "${RED}❌ 错误: 此脚本需要 root 权限运行${NC}"
   echo -e "${YELLOW}请使用: sudo $0${NC}"
   exit 1
fi

# --- 读取用户输入 ---
echo -e "${GREEN}📝 请输入配置信息：${NC}\n"

# 获取当前 SSH 连接的客户端 IP
CLIENT_IP=$(echo $SSH_CONNECTION | awk '{print $1}')
if [ -n "$CLIENT_IP" ]; then
    echo -e "${YELLOW}检测到您的 SSH 连接 IP: ${GREEN}$CLIENT_IP${NC}"
fi

# 询问是否启用白名单
echo ""
read -p "是否启用 IP 白名单? (y/n，默认 n 推荐): " enable_whitelist
enable_whitelist=${enable_whitelist:-n}

if [[ "$enable_whitelist" =~ ^[Yy]$ ]]; then
    if [ -n "$CLIENT_IP" ]; then
        read -p "是否使用检测到的 IP ($CLIENT_IP) 作为白名单? (y/n，默认 y): " use_detected_ip
        use_detected_ip=${use_detected_ip:-y}
        
        if [[ "$use_detected_ip" =~ ^[Yy]$ ]]; then
            value_url="$CLIENT_IP"
        else
            read -p "请输入允许访问的 IP 地址或网段（如 192.168.1.0/24）: " value_url
        fi
    else
        read -p "请输入允许访问的 IP 地址或网段（如 192.168.1.0/24）: " value_url
    fi
    
    if [ -z "$value_url" ]; then
        echo -e "${RED}❌ IP 地址不能为空${NC}"
        exit 1
    fi
    
    WHITELIST="$value_url,127.0.0.1,::1"
    WHITELIST_ENABLED="true"
    echo -e "${GREEN}✓ 将启用 IP 白名单: $WHITELIST${NC}\n"
else
    WHITELIST="*"
    WHITELIST_ENABLED="false"
    echo -e "${YELLOW}⚠ 将禁用 IP 白名单（依赖密码保护）${NC}\n"
fi

# 读取密码
while true; do
    read -s -p "设置 RPC 登录密码: " value_psw
    echo ""
    if [ -n "$value_psw" ]; then
        read -s -p "再次确认密码: " value_psw_confirm
        echo ""
        if [ "$value_psw" = "$value_psw_confirm" ]; then
            break
        else
            echo -e "${RED}两次密码不一致，请重新输入${NC}"
        fi
    else
        echo -e "${RED}密码不能为空，请重新输入${NC}"
    fi
done

# 配置变量
RPC_USERNAME="opengl"
RPC_PORT="9091"
DOWNLOADS_DIR="/var/lib/transmission/downloads"
INCOMPLETE_DIR="/var/lib/transmission/incomplete"

echo -e "\n${BLUE}============================================================${NC}"
echo -e "${GREEN}开始安装和配置...${NC}\n"
echo -e "${YELLOW}配置摘要：${NC}"
echo -e "  用户名: ${GREEN}$RPC_USERNAME${NC}"
echo -e "  密码: ${GREEN}******${NC}"
echo -e "  白名单: ${GREEN}$WHITELIST${NC}"
echo -e "  白名单启用: ${GREEN}$WHITELIST_ENABLED${NC}"
echo -e "  端口: ${GREEN}$RPC_PORT${NC}"
echo -e "${BLUE}============================================================${NC}\n"

# --- 1. 完全卸载旧版本 ---
echo -e "${GREEN}[1/11] 完全卸载旧版本...${NC}"
systemctl stop transmission-daemon 2>/dev/null || true
sleep 2
killall -9 transmission-daemon 2>/dev/null || true
sleep 1

if dpkg -l | grep -q transmission-daemon; then
    apt remove --purge -y transmission-daemon transmission-common
    apt autoremove -y
fi

# 删除所有可能的配置目录
rm -rf /var/lib/transmission
rm -rf /var/lib/transmission-daemon
rm -rf /etc/transmission-daemon
rm -rf /etc/systemd/system/transmission-daemon.service.d
systemctl daemon-reload

echo -e "${GREEN}✓ 旧版本清理完成${NC}\n"

# --- 2. 安装 Transmission ---
echo -e "${GREEN}[2/11] 安装 Transmission...${NC}"
export DEBIAN_FRONTEND=noninteractive
apt update -qq
apt install -y transmission-daemon jq 2>&1 | grep -v "^Selecting\|^Preparing\|^Unpacking" || true
echo -e "${GREEN}✓ 安装完成${NC}\n"

# --- 3. 停止自动启动的服务 ---
echo -e "${GREEN}[3/11] 停止服务...${NC}"
systemctl stop transmission-daemon 2>/dev/null || true
sleep 2
killall -9 transmission-daemon 2>/dev/null || true
sleep 1
echo -e "${GREEN}✓ 服务已停止${NC}\n"

# --- 4. 创建目录结构 ---
echo -e "${GREEN}[4/11] 创建目录结构...${NC}"
mkdir -p /var/lib/transmission/.config/transmission-daemon
mkdir -p "$DOWNLOADS_DIR"
mkdir -p "$INCOMPLETE_DIR"
echo -e "${GREEN}✓ 目录创建完成${NC}\n"

# --- 5. 确保用户存在 ---
echo -e "${GREEN}[5/11] 确保系统用户存在...${NC}"
if ! id debian-transmission &>/dev/null; then
    useradd -r -s /usr/sbin/nologin debian-transmission
    echo -e "${GREEN}✓ 用户已创建${NC}\n"
else
    echo -e "${GREEN}✓ 用户已存在${NC}\n"
fi

# --- 6. 设置权限 ---
echo -e "${GREEN}[6/11] 设置目录权限...${NC}"
chown -R debian-transmission:debian-transmission /var/lib/transmission
chmod -R 755 /var/lib/transmission
chmod 755 /var/lib/transmission/.config/transmission-daemon
echo -e "${GREEN}✓ 权限设置完成${NC}\n"

# --- 7. 创建配置文件模板 ---
echo -e "${GREEN}[7/11] 创建配置文件...${NC}"

# 创建配置内容（使用变量）
CONFIG_CONTENT=$(cat <<EOF
{
    "alt-speed-down": 50,
    "alt-speed-enabled": false,
    "bind-address-ipv4": "0.0.0.0",
    "bind-address-ipv6": "::",
    "blocklist-enabled": false,
    "cache-size-mb": 4,
    "dht-enabled": true,
    "download-dir": "$DOWNLOADS_DIR",
    "download-queue-enabled": true,
    "download-queue-size": 500,
    "encryption": 1,
    "idle-seeding-limit": 30,
    "idle-seeding-limit-enabled": false,
    "incomplete-dir": "$INCOMPLETE_DIR",
    "incomplete-dir-enabled": true,
    "lpd-enabled": false,
    "message-level": 2,
    "peer-limit-global": 200,
    "peer-limit-per-torrent": 50,
    "peer-port": 51413,
    "peer-port-random-on-start": false,
    "pex-enabled": true,
    "port-forwarding-enabled": false,
    "preallocation": 1,
    "prefetch-enabled": true,
    "queue-stalled-enabled": true,
    "queue-stalled-minutes": 30,
    "ratio-limit": 2,
    "ratio-limit-enabled": false,
    "rename-partial-files": true,
    "rpc-authentication-required": true,
    "rpc-bind-address": "0.0.0.0",
    "rpc-enabled": true,
    "rpc-host-whitelist": "",
    "rpc-host-whitelist-enabled": false,
    "rpc-password": "$value_psw",
    "rpc-port": $RPC_PORT,
    "rpc-url": "/transmission/",
    "rpc-username": "$RPC_USERNAME",
    "rpc-whitelist": "$WHITELIST",
    "rpc-whitelist-enabled": $WHITELIST_ENABLED,
    "scrape-paused-torrents-enabled": true,
    "seed-queue-enabled": false,
    "seed-queue-size": 10,
    "speed-limit-down": 100,
    "speed-limit-down-enabled": false,
    "speed-limit-up": 0,
    "speed-limit-up-enabled": true,
    "start-added-torrents": true,
    "trash-original-torrent-files": false,
    "umask": 2,
    "upload-slots-per-torrent": 14,
    "utp-enabled": true
}
EOF
)

# 写入主配置文件
echo "$CONFIG_CONTENT" > /var/lib/transmission/.config/transmission-daemon/settings.json

# 验证 JSON 格式
if jq empty /var/lib/transmission/.config/transmission-daemon/settings.json 2>/dev/null; then
    echo -e "${GREEN}✓ 配置文件创建成功${NC}\n"
else
    echo -e "${RED}❌ JSON 格式错误${NC}"
    exit 1
fi

# --- 8. 配置 systemd 服务 ---
echo -e "${GREEN}[8/11] 配置 systemd 服务...${NC}"
mkdir -p /etc/systemd/system/transmission-daemon.service.d
cat > /etc/systemd/system/transmission-daemon.service.d/override.conf <<EOF
[Service]
Type=simple
Restart=on-failure
RestartSec=5s
TimeoutStartSec=30s
ExecStartPre=/bin/sleep 2
EOF
systemctl daemon-reload
echo -e "${GREEN}✓ systemd 配置完成${NC}\n"

# --- 9. 首次启动 ---
echo -e "${GREEN}[9/11] 首次启动服务...${NC}"
systemctl enable transmission-daemon > /dev/null 2>&1
systemctl start transmission-daemon

# 等待服务启动
for i in {1..10}; do
    if systemctl is-active --quiet transmission-daemon; then
        echo -e "${GREEN}✓ 服务已启动${NC}"
        break
    fi
    echo -e "  等待启动... $i/10 秒"
    sleep 1
done

if ! systemctl is-active --quiet transmission-daemon; then
    echo -e "${RED}❌ 服务启动失败${NC}"
    systemctl status transmission-daemon
    exit 1
fi

# 等待配置文件被 Transmission 处理（密码加密等）
echo -e "${YELLOW}等待 Transmission 初始化配置...${NC}"
sleep 5
echo ""

# --- 10. 检查并同步所有可能的配置文件位置 ---
echo -e "${GREEN}[10/11] 同步所有配置文件位置...${NC}"

# 停止服务以便修改配置
systemctl stop transmission-daemon
sleep 3

# 确认服务已完全停止
if systemctl is-active --quiet transmission-daemon; then
    echo -e "${YELLOW}⚠ 服务未完全停止，强制终止...${NC}"
    killall -9 transmission-daemon 2>/dev/null || true
    sleep 2
fi

# 获取主配置文件内容
MAIN_CONFIG="/var/lib/transmission/.config/transmission-daemon/settings.json"

# 强制更新白名单配置（确保不被 Transmission 改回去）
if jq --arg whitelist "$WHITELIST" --argjson enabled "$WHITELIST_ENABLED" \
   '.["rpc-whitelist"] = $whitelist | .["rpc-whitelist-enabled"] = $enabled | .["rpc-authentication-required"] = true' \
   "$MAIN_CONFIG" > /tmp/settings_final.json 2>/dev/null; then
    
    mv /tmp/settings_final.json "$MAIN_CONFIG"
    echo -e "${GREEN}✓ 主配置文件已更新${NC}"
else
    echo -e "${RED}❌ 更新配置失败，JSON 格式错误${NC}"
    exit 1
fi

# 检查系统中所有可能的配置文件位置并同步
POSSIBLE_CONFIGS=(
    "/etc/transmission-daemon/settings.json"
    "/var/lib/transmission-daemon/.config/transmission-daemon/settings.json"
)

for config_path in "${POSSIBLE_CONFIGS[@]}"; do
    config_dir=$(dirname "$config_path")
    if [ ! -d "$config_dir" ]; then
        mkdir -p "$config_dir"
        echo -e "${YELLOW}  创建目录: $config_dir${NC}"
    fi
    
    # 复制主配置到这些位置
    cp "$MAIN_CONFIG" "$config_path"
    echo -e "${YELLOW}  同步配置到: $config_path${NC}"
done

# 设置所有配置文件的权限
chown -R debian-transmission:debian-transmission /var/lib/transmission 2>/dev/null || true
chown -R debian-transmission:debian-transmission /var/lib/transmission-daemon 2>/dev/null || true
chown -R debian-transmission:debian-transmission /etc/transmission-daemon 2>/dev/null || true

find /var/lib/transmission -name "settings.json" -exec chmod 600 {} \; 2>/dev/null || true
find /var/lib/transmission-daemon -name "settings.json" -exec chmod 600 {} \; 2>/dev/null || true
find /etc/transmission-daemon -name "settings.json" -exec chmod 600 {} \; 2>/dev/null || true

echo -e "${GREEN}✓ 配置文件同步完成${NC}\n"

# --- 11. 最终启动 ---
echo -e "${GREEN}[11/11] 最终启动服务...${NC}"
systemctl start transmission-daemon

# 等待服务启动
for i in {1..10}; do
    if systemctl is-active --quiet transmission-daemon; then
        echo -e "${GREEN}✓ 服务已成功启动${NC}"
        break
    fi
    echo -e "  等待启动... $i/10 秒"
    sleep 1
done

sleep 3

# --- 验证安装 ---
echo -e "\n${BLUE}============================================================${NC}"

if systemctl is-active --quiet transmission-daemon; then
    SERVER_IP=$(hostname -I | awk '{print $1}')
    SERVER_PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo "无法获取")
    
    echo -e "${GREEN}🎉 安装成功！${NC}\n"
    
    echo -e "${YELLOW}=== 访问信息 ===${NC}"
    echo -e "  内网地址: ${GREEN}http://$SERVER_IP:$RPC_PORT${NC}"
    if [ "$SERVER_PUBLIC_IP" != "无法获取" ]; then
        echo -e "  公网地址: ${GREEN}http://$SERVER_PUBLIC_IP:$RPC_PORT${NC}"
    fi
    echo -e "  用户名: ${GREEN}$RPC_USERNAME${NC}"
    echo -e "  密码: ${GREEN}$value_psw${NC}"
    
    echo -e "\n${YELLOW}=== 安全配置 ===${NC}"
    echo -e "  密码认证: ${GREEN}已启用${NC}"
    if [ "$WHITELIST_ENABLED" = "true" ]; then
        echo -e "  IP 白名单: ${GREEN}已启用${NC}"
        echo -e "  允许的 IP: ${GREEN}$WHITELIST${NC}"
    else
        echo -e "  IP 白名单: ${YELLOW}已禁用（依赖密码保护）${NC}"
    fi
    
    echo -e "\n${YELLOW}=== 目录信息 ===${NC}"
    echo -e "  下载目录: ${GREEN}$DOWNLOADS_DIR${NC}"
    echo -e "  未完成目录: ${GREEN}$INCOMPLETE_DIR${NC}"
    echo -e "  主配置文件: ${GREEN}$MAIN_CONFIG${NC}"
    
    # 配置验证
    echo -e "\n${YELLOW}=== 配置验证 ===${NC}"
    CURRENT_WHITELIST=$(jq -r '.["rpc-whitelist"]' "$MAIN_CONFIG")
    CURRENT_WHITELIST_ENABLED=$(jq -r '.["rpc-whitelist-enabled"]' "$MAIN_CONFIG")
    CURRENT_AUTH=$(jq -r '.["rpc-authentication-required"]' "$MAIN_CONFIG")
    
    echo -e "  当前白名单: ${GREEN}$CURRENT_WHITELIST${NC}"
    echo -e "  白名单状态: ${GREEN}$CURRENT_WHITELIST_ENABLED${NC}"
    echo -e "  认证状态: ${GREEN}$CURRENT_AUTH${NC}"
    
    # 查找所有配置文件
    echo -e "\n${YELLOW}=== 系统中的配置文件 ===${NC}"
    find /etc /var -name "settings.json" 2>/dev/null | while read config_file; do
        echo -e "  ${GREEN}$config_file${NC}"
    done
    
    # 端口检查
    echo -e "\n${YELLOW}=== 网络状态 ===${NC}"
    if command -v netstat &>/dev/null; then
        if netstat -tlnp 2>/dev/null | grep -q ":$RPC_PORT"; then
            echo -e "  端口监听: ${GREEN}✓ 端口 $RPC_PORT 正常监听${NC}"
        else
            echo -e "  端口监听: ${RED}✗ 端口 $RPC_PORT 未监听${NC}"
        fi
    elif command -v ss &>/dev/null; then
        if ss -tlnp 2>/dev/null | grep -q ":$RPC_PORT"; then
            echo -e "  端口监听: ${GREEN}✓ 端口 $RPC_PORT 正常监听${NC}"
        else
            echo -e "  端口监听: ${RED}✗ 端口 $RPC_PORT 未监听${NC}"
        fi
    fi
    
    # 连接测试
    echo -e "\n${YELLOW}=== 连接测试 ===${NC}"
    LOCAL_TEST=$(curl -s -o /dev/null -w "%{http_code}" -u $RPC_USERNAME:$value_psw http://localhost:$RPC_PORT/transmission/rpc 2>/dev/null || echo "000")
    
    if [ "$LOCAL_TEST" = "409" ]; then
        echo -e "  本地连接: ${GREEN}✓ 成功 (HTTP 409 - 正常响应)${NC}"
    elif [ "$LOCAL_TEST" = "401" ]; then
        echo -e "  本地连接: ${YELLOW}⚠ HTTP 401 - 密码可能未生效${NC}"
    else
        echo -e "  本地连接: ${RED}✗ HTTP $LOCAL_TEST${NC}"
    fi
    
    # 公网测试（如果有公网IP）
    if [ "$SERVER_PUBLIC_IP" != "无法获取" ] && [ -n "$SERVER_PUBLIC_IP" ]; then
        PUBLIC_TEST=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://$SERVER_PUBLIC_IP:$RPC_PORT/ 2>/dev/null || echo "000")
        
        if [ "$PUBLIC_TEST" = "401" ]; then
            echo -e "  公网连接: ${GREEN}✓ 可访问 (HTTP 401 - 需要密码)${NC}"
        elif [ "$PUBLIC_TEST" = "403" ]; then
            echo -e "  公网连接: ${RED}✗ HTTP 403 - IP 被白名单拒绝${NC}"
            if [ "$WHITELIST_ENABLED" = "true" ]; then
                echo -e "    ${YELLOW}提示: 您启用了白名单，请确认您的公网 IP 在白名单中${NC}"
            fi
        elif [ "$PUBLIC_TEST" = "200" ] || [ "$PUBLIC_TEST" = "409" ]; then
            echo -e "  公网连接: ${GREEN}✓ 可访问${NC}"
        else
            echo -e "  公网连接: ${YELLOW}⚠ HTTP $PUBLIC_TEST 或超时${NC}"
        fi
    fi
    
    echo -e "\n${YELLOW}=== 常用命令 ===${NC}"
    echo -e "  查看状态: ${GREEN}systemctl status transmission-daemon${NC}"
    echo -e "  重启服务: ${GREEN}systemctl restart transmission-daemon${NC}"
    echo -e "  查看日志: ${GREEN}journalctl -xeu transmission-daemon -f${NC}"
    echo -e "  查看配置: ${GREEN}jq . $MAIN_CONFIG${NC}"
    
    if [ "$WHITELIST_ENABLED" = "true" ]; then
        echo -e "\n${YELLOW}=== 修改白名单 ===${NC}"
        echo -e "  ${GREEN}sudo systemctl stop transmission-daemon${NC}"
        echo -e "  ${GREEN}sudo jq '.\"rpc-whitelist\" = \"新IP,127.0.0.1,::1\"' $MAIN_CONFIG > /tmp/s.json${NC}"
        echo -e "  ${GREEN}sudo mv /tmp/s.json $MAIN_CONFIG${NC}"
        echo -e "  ${GREEN}sudo chown debian-transmission:debian-transmission $MAIN_CONFIG${NC}"
        echo -e "  ${GREEN}sudo systemctl start transmission-daemon${NC}"
    fi
    
    echo -e "\n${BLUE}============================================================${NC}"
    echo -e "${GREEN}✨ 安装完成！现在可以通过浏览器访问了！${NC}"
    echo -e "${BLUE}============================================================${NC}\n"
    
else
    echo -e "${RED}❌ 安装失败 - 服务未正常运行${NC}\n"
    echo -e "${YELLOW}请检查：${NC}"
    echo -e "  1. 服务状态: ${GREEN}systemctl status transmission-daemon${NC}"
    echo -e "  2. 查看日志: ${GREEN}journalctl -xeu transmission-daemon -n 50${NC}"
    exit 1
fi
