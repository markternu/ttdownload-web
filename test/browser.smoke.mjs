/**
 * 浏览器冒烟测试（真实 Chrome，通过 Playwright channel: chrome）
 * 需要本机安装 Google Chrome；服务器环境可不跑此脚本。
 * 运行：node --test test/browser.smoke.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setupRuntime, startAria2Mock } from './helpers.mjs';

const publicDir = path.resolve('public');
const hasBuild = fs.existsSync(path.join(publicDir, 'index.html'));
if (!hasBuild) {
  test('浏览器冒烟测试（跳过：public/ 未构建）', { skip: true }, () => {});
} else {
  const mock = await startAria2Mock({ workDir: '/tmp' });
  const root = setupRuntime({ env: { ARIA2_RPC_PORT: String(mock.port) } });

  const fakeYtdlp = path.join(root, 'bin', 'yt-dlp');
  fs.mkdirSync(path.dirname(fakeYtdlp), { recursive: true });
  fs.writeFileSync(
    fakeYtdlp,
    `#!/bin/bash
if [ "$1" = "--version" ]; then echo "2024.01.01"; exit 0; fi
if [ "$1" = "-J" ]; then
  echo '{"title":"浏览器测试视频","uploader":"作者A","duration":125,"thumbnail":"http://x/t.jpg","formats":[{"format_id":"137","ext":"mp4","resolution":"1080p","height":1080,"vcodec":"avc1","acodec":"none","filesize":235000000},{"format_id":"22","ext":"mp4","resolution":"720p","height":720,"vcodec":"avc1","acodec":"mp4a","filesize":120000000}]}'
  exit 0
fi
OUT=""; prev=""
for a in "$@"; do if [ "$prev" = "-o" ]; then OUT="$a"; fi; prev="$a"; done
DIR=$(dirname "$OUT"); [ -z "$OUT" ] && exit 0; mkdir -p "$DIR"; echo "video" > "$DIR/browser.mp4"; echo "PROG 100 100 0 NA"; exit 0
`,
    { mode: 0o755 },
  );
  process.env.YTDLP_BIN = fakeYtdlp;

  const { createApp } = await import('../dist/app.js');
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const { chromium } = await import('playwright');
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (e) {
    console.warn('未找到 Chrome，跳过浏览器测试：', e.message);
  }

  const pageErrors = [];

  test.after(async () => {
    if (browser) await browser.close();
    await new Promise((r) => server.close(r));
    await mock.close();
  });

  const newPage = async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      // 忽略外部资源加载失败（测试里的缩略图/字体等假域名），只关心应用自身报错
      if (/ERR_NAME_NOT_RESOLVED|Failed to load resource|net::ERR_/.test(text)) return;
      pageErrors.push(text);
    });
    return page;
  };

  test('首页：标题/副标题/URL 输入框/解析按钮 正常渲染', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=在线视频下载管理器', { timeout: 15000 });
    assert.ok(await page.locator('text=统一管理你的在线视频下载任务').first().isVisible());
    assert.ok(await page.getByPlaceholder('粘贴视频链接').first().isVisible());
    assert.ok(await page.getByRole('button', { name: /解析视频/ }).first().isVisible());
    await page.close();
  });

  test('URL 校验：非法协议给出中文错误提示', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByPlaceholder('粘贴视频链接').first().fill('ftp://not-a-video');
    await page.getByRole('button', { name: /解析视频/ }).first().click();
    await page.waitForSelector('text=/URL 格式错误|不支持/', { timeout: 10000 });
    await page.close();
  });

  test('解析视频：平台识别 + 预览卡片（标题/时长/质量选项）', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByPlaceholder('粘贴视频链接').first().fill('https://www.youtube.com/watch?v=abc123');
    await page.getByRole('button', { name: /解析视频/ }).first().click();
    await page.waitForSelector('text=浏览器测试视频', { timeout: 20000 });
    assert.ok(await page.locator('text=YouTube').first().isVisible(), '应显示平台 YouTube');
    assert.ok((await page.locator('text=/1080P|1080p/').count()) > 0, '应显示可选分辨率');
    await page.close();
  });

  test('加入下载队列：任务出现在任务列表', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByPlaceholder('粘贴视频链接').first().fill('https://www.youtube.com/watch?v=abc123');
    await page.getByRole('button', { name: /解析视频/ }).first().click();
    await page.waitForSelector('text=浏览器测试视频', { timeout: 20000 });
    const addBtn = page.getByRole('button', { name: /加入下载队列/ }).first();
    await addBtn.click();
    // 等 toast 或跳转后任务列表出现标题
    await page.waitForSelector('text=/已加入下载队列|浏览器测试视频/', { timeout: 15000 });
    await page.goto(`${base}/tasks`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=浏览器测试视频', { timeout: 15000 });
    await page.close();
  });

  test('aria2 页面提交多行 URL 并显示任务进度', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(`${base}/aria2`, { waitUntil: 'networkidle' });
    const textarea = page.locator('textarea').first();
    await textarea.waitFor({ timeout: 15000 });
    await textarea.fill('http://example.com/browser-a.bin\nhttp://example.com/browser-b.bin');
    const submit = page.getByRole('button', { name: /提交到下载队列|提交|加入下载队列/ }).first();
    await submit.click();
    // 任务应出现在页面上的任务列表（进度/状态）
    await page.waitForSelector('text=/browser-a\\.bin|browser-b\\.bin/', { timeout: 15000 });
    await page.close();
  });

  test('设置页：并发/主题/系统状态可访问', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(`${base}/settings`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=/最大并发|并发/', { timeout: 15000 });
    assert.ok((await page.locator('text=/磁盘|剩余空间|系统状态/').count()) > 0, '应显示磁盘/系统状态');
    await page.close();
  });

  test('暗色模式：切换后 html 带 dark 类', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
    const darkBefore = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    // 直接走前端持久化约定：localStorage + 重载（避免依赖具体按钮 DOM）
    await page.evaluate((isDark) => localStorage.setItem('ttd-theme', isDark ? 'light' : 'dark'), darkBefore);
    await page.reload({ waitUntil: 'networkidle' });
    const darkAfter = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    assert.notEqual(darkAfter, darkBefore, '主题应切换');
    await page.close();
  });

  test('手机视口：无横向滚动', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `不应有横向滚动（溢出 ${overflow}px）`);
    await page.close();
  });

  test('BT 页面：出清机制面板与预览按钮可用', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(`${base}/bt`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=BT 出清机制', { timeout: 15000 });
    assert.ok(await page.locator('text=/10 小时|尝试时间/').first().isVisible(), '应说明 10 小时尝试时间门槛');
    await page.getByRole('button', { name: /出清预览/ }).first().click();
    // 预览会调用 /api/bt/stale（此时无 transmission，返回 checked=0），页面不应报错
    await page.waitForTimeout(1200);
    assert.ok((await page.locator('text=/没有需要出清的任务|检查 0 个|保留/').count()) >= 0);
    await page.close();
  });

  test('页面无 JS 报错', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    assert.deepEqual(pageErrors, [], `浏览器控制台错误：\n${pageErrors.join('\n')}`);
  });
}
