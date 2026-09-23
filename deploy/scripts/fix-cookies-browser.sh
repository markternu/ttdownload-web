#!/usr/bin/env bash
# =============================================================================
#  安装「自动获取 cookies 用的无头浏览器」
#
#  为什么需要：抖音/TikTok 这类站点的网页接口要求浏览器 JS 挑战生成的签名 cookie
#  （__ac_signature / ttwid 等），而且几小时就过期 —— 人工导出 cookies 根本跟不上。
#  服务器上装了 chromium 之后，程序就能自动获取并定期续期，不用人管。
#
#  用法（本机 root）：
#      sudo bash deploy/scripts/fix-cookies-browser.sh
#  （网页版「修复脚本」上传通道已移除，本脚本只能在服务器上以 root 执行。）
# =============================================================================
set -u
log()  { printf '[fix-cookies] %s\n' "$*"; }
warn() { printf '[fix-cookies][warn] %s\n' "$*" >&2; }

log "1. 检查现有浏览器"
FOUND=""
for b in chromium chromium-browser google-chrome google-chrome-stable; do
  if command -v "$b" >/dev/null 2>&1; then FOUND="$(command -v "$b")"; break; fi
done
if [ -n "$FOUND" ]; then
  log "✅ 已经有可用的浏览器：$FOUND"
  "$FOUND" --version 2>&1 | head -1 || true
else
  log "没有找到 chromium，开始安装 ..."
  export DEBIAN_FRONTEND=noninteractive
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq 2>/dev/null || true
    apt-get install -y chromium 2>/dev/null || apt-get install -y chromium-browser 2>/dev/null || true
  fi
  for b in chromium chromium-browser; do
    if command -v "$b" >/dev/null 2>&1; then FOUND="$(command -v "$b")"; break; fi
  done
fi

log "2. 检查 playwright（Node 侧驱动）"
if [ -d node_modules/playwright ] || [ -d /home/*/ttdownload-web/node_modules/playwright ]; then
  log "✅ playwright 已安装"
else
  warn "没找到 node_modules/playwright：请在项目目录执行 npm ci（或 sudo ./deploy.sh --update）"
fi

log "3. 实测抓一次抖音 cookies"
if [ -n "$FOUND" ] && command -v node >/dev/null 2>&1; then
  PROJ="$(cd "$(dirname "$0")/../.." && pwd)"
  if [ -d "$PROJ/node_modules/playwright" ]; then
    (cd "$PROJ" && CHROMIUM_PATH="$FOUND" node -e '
      (async () => {
        const { chromium } = await import("playwright");
        const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
        const ctx = await b.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", locale: "zh-CN" });
        const p = await ctx.newPage();
        await p.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
        await p.waitForTimeout(8000);
        const c = await ctx.cookies();
        console.log("拿到 cookie " + c.length + " 条: " + c.map(x => x.name).join(", "));
        const need = ["__ac_signature", "ttwid"];
        console.log(need.every(n => c.some(x => x.name === n)) ? "✅ 关键 cookie（__ac_signature/ttwid）齐全，抖音可以自动获取" : "⚠️ 关键 cookie 不齐，抖音可能仍失败");
        await b.close();
      })().catch(e => { console.log("❌ 失败: " + e.message); process.exit(1); });
    ') && log "✅ 自动获取链路可用" || warn "抓取测试失败（可稍后看日志 [MARK:COOKIE_HARVEST]）"
  fi
fi
log "完成。"
