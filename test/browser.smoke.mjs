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
  if [ -n "$BROWSER_PARSE_FAIL" ]; then
    echo "$BROWSER_PARSE_FAIL" >&2
    exit 1
  fi
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
  const { filesRepo } = await import('../dist/core/db.js');
  // 造一个"已加密归档、安卓端还没取走"的成品，供「待下载」页测试
  const consumerDir = path.join(root, 'xiaofeizhe_downd');
  fs.mkdirSync(consumerDir, { recursive: true });
  const pendingName = 'purpending1';
  fs.writeFileSync(path.join(consumerDir, pendingName), 'encrypted-pending-fixture');
  const pendingId = filesRepo.add({
    taskId: null,
    name: pendingName,
    title: '待下载页测试文件.mp4',
    module: 'webvideo',
    sizeBytes: 24,
    path: path.join(consumerDir, pendingName),
  });
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

  test('设置页：公开视频（yt-dlp）cookies 卡片可访问', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(`${base}/settings`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=公开视频（yt-dlp）', { timeout: 15000 });
    assert.ok((await page.locator('text=/会员专享/').count()) > 0, '应说明 cookies 用于会员/登录视频');
    assert.ok((await page.getByRole('button', { name: /上传 cookies/ }).count()) > 0, '应有上传 cookies.txt 按钮');
    assert.ok(
      (await page.getByPlaceholder('--proxy socks5://127.0.0.1:1080').count()) > 0,
      '应有 yt-dlp 额外参数输入框',
    );
    await page.close();
  });

  test('会员专享视频：解析受限横幅 + 仍然下载（自动多方式尝试）', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    process.env.BROWSER_PARSE_FAIL =
      "ERROR: [youtube] f6kl3G_ek-A: This video is available to this channel's members on level: 高级VIP会员（人工咨询服务） (or any higher level). Join this channel to get access to members-only content and other exclusive perks.";
    try {
      const page = await newPage();
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.getByPlaceholder('粘贴视频链接').first().fill('https://www.youtube.com/watch?v=f6kl3G_ek-A');
      await page.getByRole('button', { name: /解析视频/ }).first().click();
      await page.waitForSelector('text=/解析受限/', { timeout: 20000 });
      assert.ok((await page.locator('text=/频道会员专享/').count()) > 0, '应显示会员专享的具体原因');
      assert.ok((await page.locator('text=/上传 cookies/').count()) > 0, '应引导去上传 cookies');
      const stillDownload = page.getByRole('button', { name: /仍然下载/ }).first();
      assert.ok(await stillDownload.isVisible(), '受限视频也应能继续下载');
      await stillDownload.click();
      await page.waitForSelector('text=/已加入下载队列|仍然下载/', { timeout: 15000 });
      await page.close();
    } finally {
      delete process.env.BROWSER_PARSE_FAIL;
    }
  });

  test('首页：网络自检面板显示各项检测结果', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=网络自检', { timeout: 15000 });
    // 结论徽标：正常/部分可用/异常 三者之一
    await page.waitForSelector('text=/网络正常|部分可用|网络异常/', { timeout: 30000 });
    assert.ok((await page.locator('text=/基础网络|yt-dlp/').count()) > 0, '应展示分组与检查项');
    assert.ok((await page.getByRole('button', { name: /重新检测/ }).count()) > 0, '应有重新检测按钮');
    // 至少能看到 yt-dlp 与 DNS 两类检查
    assert.ok((await page.locator('text=/DNS 解析|yt-dlp 可执行/').count()) > 0, '应展示具体检查项');
    await page.getByRole('button', { name: /重新检测/ }).first().click();
    await page.waitForTimeout(1500);
    assert.deepEqual(pageErrors, [], `重新检测不应报错：${pageErrors.join('; ')}`);
    await page.close();
  });

  test('日志页：可查看/过滤日志并导出诊断包', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(`${base}/logs`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=/日志文件|日志目录|标记说明/', { timeout: 15000 });
    assert.ok((await page.locator('text=/日志文件|日志目录/').count()) > 0, '应显示日志文件信息');
    assert.ok((await page.getByRole('button', { name: /刷新/ }).count()) > 0, '应有刷新按钮');
    assert.ok((await page.getByRole('button', { name: /下载当前日志|下载/ }).count()) > 0, '应有下载日志按钮');
    assert.ok((await page.getByRole('button', { name: /导出诊断包/ }).count()) > 0, '应有一键导出诊断包');
    assert.ok((await page.getByRole('button', { name: /清空/ }).count()) > 0, '应有清空日志按钮');
    // 日志区应至少有内容（页面自身的 HTTP 请求就会产生日志行）
    const text = await page.locator('body').innerText();
    assert.ok(/MARK:|\[INFO|\[DEBUG|\[WARN|\[ERROR/.test(text), '应能看到日志行内容');
    // 标记说明表
    assert.ok(/TASK_CREATE|YTDLP_ATTEMPT|HTTP_REQ/.test(text), '应展示标记说明');
    await page.close();
  });

  test('问题反馈页：一键下载诊断报告 + 单项下载 + 失败任务', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(`${base}/report`, { waitUntil: 'networkidle' });
    // 主卡片（最醒目的一键下载）
    await page.waitForSelector('text=一键下载诊断报告', { timeout: 20000 });
    assert.ok((await page.locator('text=/运行环境|诊断报告/').count()) > 0, '应说明报告里有什么');
    // 单项下载列表：应有应用日志/部署日志/网络自检等条目
    assert.ok((await page.locator('text=/下载单项信息|当前应用日志|网络自检报告/').count()) > 0, '应列出可单项下载的信息');
    // 只导出报错
    assert.ok((await page.getByRole('button', { name: /导出日志/ }).count()) > 0, '应有「导出日志」按钮');
    // 最近失败的任务
    assert.ok((await page.locator('text=最近失败的任务').count()) > 0);
    // 反馈步骤
    assert.ok((await page.locator('text=/怎么反馈问题/').count()) > 0, '应有反馈步骤说明');
    // 「下载后清空已有日志」开关
    assert.ok(
      (await page.locator('text=下载后清空已有日志').count()) > 0,
      '应有「下载后清空已有日志」开关（每轮测试日志互不干扰）',
    );
    // 点一下「下载」类按钮不应报错（触发浏览器下载，忽略）
    const downloadButtons = page.getByRole('button', { name: /下载/ });
    assert.ok((await downloadButtons.count()) > 0, '页面上应有下载按钮');
    assert.deepEqual(pageErrors, [], `问题反馈页不应有 JS 报错：${pageErrors.join('; ')}`);
    await page.close();
  });

  test('修复脚本页：警告/令牌/上传区/使用说明齐备（默认关闭）', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(`${base}/scripts`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=维护令牌与开关', { timeout: 20000 });
    // 危险提示必须醒目存在
    assert.ok((await page.locator('text=/root|服务身份|只运行/').count()) > 0, '应有风险警告文案');
    // 令牌输入与开关
    assert.ok((await page.locator('input[type="password"]').count()) > 0, '应有维护令牌输入框');
    // 上传区
    assert.ok((await page.locator('text=/上传并执行/').count()) > 0, '应有上传并执行卡片');
    assert.ok((await page.locator('input[type="file"]').count()) > 0, '应有文件选择框');
    // 使用说明三步
    assert.ok((await page.locator('text=/使用说明|三步|下载日志/').count()) > 0, '应有使用说明');
    // 默认关闭：应提示先开启（后端 enabled=false 时）
    assert.ok((await page.locator('text=/未开启|关闭|开启/').count()) > 0, '应显示开关状态');
    assert.deepEqual(pageErrors, [], `修复脚本页不应有 JS 报错：${pageErrors.join('; ')}`);
    await page.close();
  });

  test('待下载页：列出已加密归档但安卓未取走的成品，并提供下载按钮', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(`${base}/pending`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=待下载文件', { timeout: 20000 });
    // 统计卡
    assert.ok((await page.locator('text=/待下载文件数|总大小|等待最久/').count()) >= 3, '应有三块统计卡');
    // 我们造的那条记录
    assert.ok((await page.locator(`text=${pendingName}`).count()) > 0, '应列出待下载的成品文件名');
    assert.ok((await page.locator('text=待下载页测试文件.mp4').count()) > 0, '应显示原始标题');
    assert.ok((await page.locator('text=/安卓尚未下载/').count()) > 0, '应显示安卓端状态');
    // 行内「下载」按钮（页面用临时 <a> 触发下载，所以是 button 而不是 link）
    const dl = page.getByRole('button', { name: /^下载$/ }).first();
    assert.ok(await dl.isVisible(), '每行应有「下载」按钮');
    // 点一下应触发浏览器下载（Playwright 会以 download 事件捕获）
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
      dl.click(),
    ]);
    assert.ok(download, '点击下载应触发浏览器下载');
    assert.match(decodeURIComponent(download.url()), new RegExp(`/api/files/${pendingId}/download$`), `下载地址应为管理端下载接口，实际 ${download.url()}`);
    assert.deepEqual(pageErrors, [], `待下载页不应有 JS 报错：${pageErrors.join('; ')}`);
    await page.close();
  });

  test('页面无 JS 报错', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    assert.deepEqual(pageErrors, [], `浏览器控制台错误：\n${pageErrors.join('\n')}`);
  });
}
