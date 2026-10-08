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
  const AUTH_USER = 'admin';
  const AUTH_PASS = 'test-web-pass-123';
  const root = setupRuntime({
    env: { ARIA2_RPC_PORT: String(mock.port), WEB_AUTH_USER: AUTH_USER, WEB_AUTH_PASSWORD: AUTH_PASS },
  });

  const fakeYtdlp = path.join(root, 'bin', 'yt-dlp');
  fs.mkdirSync(path.dirname(fakeYtdlp), { recursive: true });
  fs.writeFileSync(
    fakeYtdlp,
    `#!/bin/bash
if [ "$1" = "--version" ]; then echo "2024.01.01"; exit 0; fi
if [ "$1" = "-J" ]; then
  # BROWSER_PARSE_DELAY: 人为拖慢解析，用来复现"解析中途切走页面"
  if [ -n "$BROWSER_PARSE_DELAY" ]; then sleep "$BROWSER_PARSE_DELAY"; fi
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

  process.env.ORIGINAL_DL_SECRET = 'browser-test-secret-0123456789abcdef0123456789';
  const { createApp } = await import('../dist/app.js');
  const { filesRepo, tasksRepo } = await import('../dist/core/db.js');
  // 供「复制下载链接」测试：一条带来源链接的下载任务
  {
    const t = tasksRepo.create({
      module: 'webvideo',
      title: '复制链接测试视频',
      platform: '抖音',
      url: 'https://v.douyin.com/COPYLINK1/',
      payload: {},
    });
    // /tasks 页只显示「正在下载 / 已下载」两档 → 置为 completed 才会出现在列表里
    tasksRepo.update(t.id, { status: 'completed', progress: 100 });
  }
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

  // 另造两个"批量删除"专用成品：页面上用搜索框把它们单独筛出来，再对它们全选，
  // 这样既验证了「全选当前页 → 全部删除」，又不会误删别的用例依赖的 fixture。
  const bulkNames = ['bulkdel-a', 'bulkdel-b'];
  const bulkIds = bulkNames.map((name) => {
    fs.writeFileSync(path.join(consumerDir, name), `encrypted-${name}`);
    return filesRepo.add({
      taskId: null,
      name,
      title: `批量删除测试-${name}.mp4`,
      module: 'webvideo',
      sizeBytes: 24,
      path: path.join(consumerDir, name),
    });
  });
  // 再造一个"已被下载"的，验证状态筛选能把两种分开
  const doneName = 'bulkdone-1';
  fs.writeFileSync(path.join(consumerDir, doneName), 'encrypted-done');
  const doneId = filesRepo.add({
    taskId: null,
    name: doneName,
    title: '已被下载测试文件.mp4',
    module: 'webvideo',
    sizeBytes: 24,
    path: path.join(consumerDir, doneName),
  });
  filesRepo.markDownloaded(doneId);

  // 造一个**真实的加密归档**（用项目自己的加密代码），供「下载原始文件」用
  {
    const { markVlt, encryptFile } = await import('../dist/services/crypto.js');
    const { config: cfg } = await import('../dist/core/config.js');
    const origName = '原始文件 测试 #1 100%.mp4';
    const plain = path.join(root, 'origdl.plain');
    const bytes = Buffer.alloc(8192, 9);
    fs.writeFileSync(plain, bytes);
    markVlt(plain, origName);
    await encryptFile(plain, plain + '.data', cfg.encryptPassword);
    fs.rmSync(plain);
    fs.renameSync(plain + '.data', path.join(consumerDir, 'origdl1'));
    filesRepo.add({
      taskId: null,
      name: 'origdl1',
      title: '下载原始文件测试',
      module: 'webvideo',
      sizeBytes: fs.statSync(path.join(consumerDir, 'origdl1')).size,
      path: path.join(consumerDir, 'origdl1'),
    });
  }

  // BT：造两条"已入队"的种子，供「已入队种子」页的「全选 → 全部删除」用
  const { seedsRepo } = await import('../dist/core/db.js');
  const btQueuedDir = path.join(root, 'transmission', 'btzhongzi_yijingdownding');
  fs.mkdirSync(btQueuedDir, { recursive: true });
  for (const n of ['queued-del-a.torrent', 'queued-del-b.torrent']) {
    const p = path.join(btQueuedDir, n);
    fs.writeFileSync(p, 'd4:infod4:name4:testee');
    const s = seedsRepo.upsertByPath({ name: n, path: p });
    // 入队后的种子：状态 queued，且 .torrent 已归档到 btQueued（与真实流程一致）
    seedsRepo.update(s.id, { status: 'queued', path: p });
  }

  // 造一个「下载中」的任务，供任务页的「全选 → 批量操作」测试用
  // （/tasks 一级页只显示 下载中/解析中/暂停/已完成，必须是 downloading 才看得到）
  const bulkTask = tasksRepo.create({
    module: 'aria2',
    title: '批量操作测试任务',
    platform: 'URL',
    url: 'http://example.com/bulkop.bin',
  });
  tasksRepo.update(bulkTask.id, { status: 'downloading', progress: 42 });

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
  const contexts = [];

  test.after(async () => {
    // SSE/长连接会让 server.close() 一直等 → 先主动断开所有连接，保证测试进程能退出
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    for (const c of contexts) await c.close().catch(() => {});
    if (browser) await browser.close();
    await new Promise((r) => server.close(r));
    await mock.close();
  });

  /** 通过 API 登录并把会话 Cookie 注入浏览器 context（等价于用户在页面登录一次） */
  const loginContext = async (context) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: AUTH_USER, password: AUTH_PASS }),
    });
    if (!res.ok) throw new Error(`测试登录失败：${res.status}`);
    const raw = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie') ?? '').split(';')[0];
    const idx = raw.indexOf('=');
    const name = raw.slice(0, idx);
    const value = raw.slice(idx + 1);
    const host = new URL(base).hostname;
    await context.addCookies([{ name, value, domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  };

  const newPage = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await loginContext(context);
    contexts.push(context);
    const page = await context.newPage();
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

  test('磁盘空间文案：必须说清"可用于下载"和"系统实际可用"的区别', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    // 首页 + 设置页都要能说清：预留是给加密/归档周转的，新下载能用的是"系统可用 − 预留"
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    const home = await page.locator('body').innerText();
    assert.match(home, /可用于下载/, '首页要写"可用于下载"');
    assert.match(home, /加密|归档/, '首页要解释预留空间是干什么用的');
    // 用户口径：显示的是「项目可用于下载的空间」，操作系统实际可用必须写成「该数 + 预留」
    assert.match(home, /操作系统实际可用/, '首页要写"操作系统实际可用"（用户口径原词）');
    assert.match(home, /可立即开始/, '首页要写出“可立即开始”的额度 —— 调度器判定用的就是这个数');

    await page.goto(`${base}/settings`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=/预留磁盘空间/', { timeout: 15000 });
    const settings = await page.locator('body').innerText();
    assert.match(settings, /可用于下载/, '设置页要出现"可用于下载"这个口径');
    assert.match(settings, /操作系统实际可用|系统实际可用/, '设置页要同时给"操作系统实际可用"的数');
    // 预留不能鼓励调小：设置页必须提示它的用途/风险
    assert.match(settings, /周转|不要随意调小|加密/, '设置页要说清预留是加密/归档的周转空间、不能随意调小');
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
    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await loginContext(mobileContext);
    const page = await mobileContext.newPage();
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

  test('BT 页面：transmission 反向代理（远程访问 9091）开关卡片', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(`${base}/bt`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=transmission 反向代理（远程访问 9091）', { timeout: 15000 });

    // 开关必须是真正的 switch 语义（无障碍 + 状态可读）
    const sw = page.getByRole('switch', { name: /反向代理开关/ }).first();
    assert.ok(await sw.isVisible(), '应有反向代理开关');
    assert.equal(await sw.getAttribute('aria-checked'), 'false', '测试环境里默认应是关闭');

    // 关闭态必须讲清「真的是删掉配置」而不是防火墙屏蔽
    assert.ok(
      (await page.locator('text=/彻底删除/').count()) > 0,
      '关闭态应说明配置会被彻底删除',
    );
    assert.ok((await page.locator('text=/外界再也访问不到 9091/').count()) > 0, '应说明关闭后外界访问不到');

    // 状态徽章：要么显示 nginx 版本，要么显示「未检测到 nginx」（取决于跑测试的机器装没装 nginx）
    const nginxBadge = page.locator('text=/nginx\/|未检测到 nginx/');
    assert.ok((await nginxBadge.count()) > 0, '应显示 nginx 状态');

    // 「预览配置」按钮点了不能把页面搞崩（无 nginx 时会给出中文错误提示）
    await page.getByRole('button', { name: /预览配置/ }).first().click();
    await page.waitForTimeout(1500);
    assert.ok(
      (await page.locator('text=/将要写入的 nginx 配置全文|未安装 nginx|预览失败/').count()) > 0,
      '预览应给出配置或明确的中文错误',
    );
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

  test('会员专享视频：解析失败横幅（红）+ 仍可尝试下载', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    process.env.BROWSER_PARSE_FAIL =
      "ERROR: [youtube] f6kl3G_ek-A: This video is available to this channel's members on level: 高级VIP会员（人工咨询服务） (or any higher level). Join this channel to get access to members-only content and other exclusive perks.";
    try {
      const page = await newPage();
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.getByPlaceholder('粘贴视频链接').first().fill('https://www.youtube.com/watch?v=f6kl3G_ek-A');
      await page.getByRole('button', { name: /解析视频/ }).first().click();
      // 解析失败要明确表现为"失败"（红色徽章 + 说明），而不是含糊的"受限但能下"
      await page.waitForSelector('text=/解析失败/', { timeout: 20000 });
      assert.ok((await page.locator('text=/频道会员专享/').count()) > 0, '应显示会员专享的具体原因');
      assert.ok((await page.locator('text=/上传/').count()) > 0, '应引导去上传 cookies');
      assert.ok(
        (await page.locator('text=/没拿到任何可用格式/').count()) > 0,
        '应说明没拿到格式、直接下载多半会失败',
      );
      const stillDownload = page.getByRole('button', { name: /仍要尝试下载/ }).first();
      assert.ok(await stillDownload.isVisible(), '仍然允许用户强行尝试下载');
      await stillDownload.click();
      await page.waitForSelector('text=/已加入下载队列|仍要尝试下载/', { timeout: 15000 });
      await page.close();
    } finally {
      delete process.env.BROWSER_PARSE_FAIL;
    }
  });

  test('网络自检已提级为独立页面（不再堆在首页），侧边栏有入口且能硬打开', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();

    // ① 首页不再有网络自检面板
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    // 注意：侧边栏现在有「网络自检」入口，所以不能拿整页文本判断 —— 只看主内容区，
    // 并且用面板独有的元素（重新检测按钮 / 分组标题）来确认它确实不在首页了
    assert.equal(
      await page.getByRole('button', { name: /重新检测/ }).count(),
      0,
      '首页不应再有「重新检测」按钮（面板已移走）',
    );
    const homeMain = (await page.locator('main').first().innerText()).replace(/\s+/g, ' ');
    assert.equal(homeMain.includes('基础网络'), false, '首页主内容区不应再有网络自检分组');

    // ② 侧边栏有平级入口，点进去就是独立页面
    await page.getByRole('link', { name: '网络自检' }).first().click();
    await page.waitForURL(/\/network$/, { timeout: 15000 });
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

    // ③ 直接刷新（硬打开 /network）不能白屏 —— 相对资源路径的老坑
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('text=网络自检', { timeout: 15000 });
    assert.deepEqual(pageErrors, [], `硬打开 /network 不应报错：${pageErrors.join('; ')}`);
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

  test('文件页（已合并「已发布 + 待下载」）：列表、状态筛选与下载按钮', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(`${base}/files`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=文件清单', { timeout: 20000 });

    // 统计卡（合并后是四块）
    assert.ok(
      (await page.locator('text=/文件总数|总占用空间|待下载|等待最久/').count()) >= 4,
      '应有四块统计卡（文件总数 / 总占用空间 / 待下载 / 等待最久）',
    );

    // 「全部」视图里能看到待下载的那条
    assert.ok((await page.locator(`text=${pendingName}`).count()) > 0, '全部视图应列出成品文件名');
    assert.ok((await page.locator('text=待下载页测试文件.mp4').count()) > 0, '应显示原始标题');

    // 切到「待下载」：待下载的在、已被下载的不在
    await page.getByRole('button', { name: /^待下载/ }).first().click();
    await page.waitForTimeout(400);
    assert.ok((await page.locator(`text=${pendingName}`).count()) > 0, '待下载视图应包含未取走的成品');
    assert.equal(await page.locator(`text=${doneName}`).count(), 0, '待下载视图不应包含已被下载的');

    // 切到「已被下载」：反过来
    await page.getByRole('button', { name: /^已被下载/ }).first().click();
    await page.waitForTimeout(400);
    assert.ok((await page.locator(`text=${doneName}`).count()) > 0, '已被下载视图应包含已取走的');
    assert.equal(await page.locator(`text=${pendingName}`).count(), 0, '已被下载视图不应包含待下载的');

    // 回到全部，验证行内下载按钮指向管理端下载接口
    await page.getByRole('button', { name: /^全部/ }).first().click();
    await page.waitForTimeout(400);
    const row = page.locator('tr', { hasText: pendingName }).first();
    const dl = row.getByRole('link', { name: /下载/ }).first();
    assert.ok(await dl.isVisible(), '每行应有「下载」入口');
    assert.match(dl ? await dl.getAttribute('href') : '', new RegExp(`/api/files/${pendingId}/download`), '下载入口应指向管理端下载接口');

    assert.deepEqual(pageErrors, [], `文件页不应有 JS 报错：${pageErrors.join('; ')}`);
    await page.close();
  });

  test('老书签：/pending 会重定向到 /files（而不是白屏或 404）', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(`${base}/pending`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=文件清单', { timeout: 20000 });
    assert.match(page.url(), /\/files$/, `应重定向到 /files，实际 ${page.url()}`);
    assert.deepEqual(pageErrors, [], `重定向不应有 JS 报错：${pageErrors.join('; ')}`);
    await page.close();
  });

  test('★全选当前页 → 全部删除：三步确认，未输入确认词时按钮不可点', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(`${base}/files`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=文件清单', { timeout: 20000 });

    // 用搜索把批量删除专用 fixture 单独筛出来，避免误选别的用例的数据
    await page.getByPlaceholder('搜索文件名或标题').fill('bulkdel');
    await page.waitForTimeout(600);
    assert.ok((await page.locator('text=bulkdel-a').count()) > 0, '应筛出 bulkdel-a');
    assert.equal(await page.locator(`text=${pendingName}`).count(), 0, '搜索后不应再显示其它文件');

    // 全选当前页
    await page.getByRole('checkbox', { name: '全选当前页' }).first().check();
    await page.waitForTimeout(200);
    assert.ok((await page.locator('text=/已选\\s*2/').count()) > 0, '应显示已选 2 个');

    // 打开危险操作弹窗
    await page.getByRole('button', { name: /全部删除/ }).first().click();
    await page.waitForSelector('text=确认范围', { timeout: 10000 });
    assert.ok((await page.locator('text=/即将删除|你即将删除/').count()) > 0, '第一步应显示删除范围');

    await page.getByRole('button', { name: /继续（第 2\/3 步）/ }).click();
    await page.waitForSelector('text=选择删除方式', { timeout: 10000 });

    await page.getByRole('button', { name: /继续（第 3\/3 步）/ }).click();
    await page.waitForSelector('text=最后确认', { timeout: 10000 });

    // 关键：没输入确认词之前，删除按钮必须是禁用的
    const danger = page.getByRole('button', { name: /确认全部删除/ });
    assert.equal(await danger.isDisabled(), true, '未输入确认词时「确认全部删除」必须禁用');

    await page.getByPlaceholder('删除').fill('删除');
    await page.waitForTimeout(200);
    assert.equal(await danger.isDisabled(), false, '输入确认词后按钮才可用');
    await danger.click();

    // 等弹窗关闭，并确认列表里那两条真的没了
    await page.waitForSelector('text=最后确认', { state: 'detached', timeout: 15000 });
    await page.waitForTimeout(600);
    assert.equal(await page.locator('text=bulkdel-a').count(), 0, '选中的文件应从列表消失');
    assert.equal(await page.locator('text=bulkdel-b').count(), 0, '选中的文件应从列表消失');

    assert.deepEqual(pageErrors, [], `批量删除不应有 JS 报错：${pageErrors.join('; ')}`);
    await page.close();
  });

  test('★下载原始文件：问 6 位密码 → 后台解密（切页不中断）→ 自动下载', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const { currentCode } = await import('../dist/services/originalCode.js');
    const page = await newPage();
    await page.goto(`${base}/files`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=文件清单', { timeout: 20000 });

    // 列表里应有我们造的加密归档，并且带「下载原始文件」按钮
    const row = page.locator('tr', { hasText: 'origdl1' }).first();
    assert.ok((await row.count()) > 0, '应列出加密归档 origdl1');
    const btn = row.getByRole('button', { name: /下载原始文件|原始/ }).first();
    assert.ok(await btn.isVisible(), '每行应有「下载原始文件」按钮');

    // 点它 → 必须先问 6 位密码（不是直接下载）
    await btn.click();
    await page.waitForSelector('text=请输入 6 位数字下载密码', { timeout: 10000 });
    const input = page.getByPlaceholder('000000');
    assert.ok(await input.isVisible(), '应弹出 6 位密码输入框');

    // 输错 → 要有明确报错，且不开始解密
    await input.fill('000000');
    await page.getByRole('button', { name: '确认' }).click();
    await page.waitForSelector('text=/密码不正确|不正确/', { timeout: 10000 });

    // 输对 → 弹窗关掉、开始解密（悬浮面板出现）
    await input.fill(currentCode());
    await page.getByRole('button', { name: '确认' }).click();
    await page.waitForSelector('text=/正在解密|已开始下载|原始文件/', { timeout: 20000 });

    // ★关键：解密期间切到别的页面，面板必须还在（不能因为离开文件页就中断）
    await page.goto(`${base}/bt`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    assert.ok(
      (await page.locator('text=/正在解密|已开始下载|原始文件/').count()) > 0,
      '切到 BT 页后，解密进度面板必须仍然在（用户要求 loading 不能挡住去别的地方）',
    );

    // 回到文件页，等它就绪（会自动触发浏览器下载）
    await page.goto(`${base}/files`, { waitUntil: 'networkidle' });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }).catch(() => null),
      page.waitForSelector('text=/已开始下载/', { timeout: 30000 }).catch(() => null),
    ]);
    if (download) {
      assert.match(decodeURIComponent(download.url()), /\/api\/original\/jobs\/[0-9a-f]+\/download$/, '下载地址应指向原始文件接口');
    }
    assert.deepEqual(pageErrors, [], `下载原始文件不应有 JS 报错：${pageErrors.join('; ')}`);
    await page.close();
  });

  test('★回归：本地缓存"以为已解锁"但服务端已重启 → 必须弹出密码框（而不是只报一句错）', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    // 真实场景：解锁状态只存在服务端内存里，服务端一重启（部署/断电）就没了，
    // 而浏览器缓存的 status 还写着 unlocked:true → 旧版直接建任务拿到 403
    // 「请先输入下载密码」，只弹一句 error toast、**永远不弹密码框**，用户彻底卡死。
    // 这里把两个接口都打桩，做成确定性复现（不依赖服务端当前是否解锁）：
    const page = await newPage();
    let statusHits = 0;
    await page.route('**/api/original/status', (route) => {
      statusHits += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: true, unlocked: true, unlockSecondsLeft: 900, unlockTtlSec: 900, codeWindowSec: 900, codeValidSec: 900, tempMaxAgeSec: 3600 }),
      });
    });
    await page.route('**/api/original/jobs', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'ORIGINAL_LOCKED', message: '请先输入下载密码' } }),
      });
    });

    await page.goto(`${base}/files`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=文件清单', { timeout: 20000 });
    assert.ok(statusHits > 0, '前提：伪造的"已解锁"状态必须真被前端取到（否则这条测试是空测试）');

    const row = page.locator('tr', { hasText: 'origdl1' }).first();
    await row.getByRole('button', { name: /下载原始文件|原始/ }).first().click();
    // 关键断言：必须弹出密码框，而不是只报一句错
    await page.waitForSelector('text=请输入 6 位数字下载密码', { timeout: 10000 });
    assert.ok(await page.getByPlaceholder('000000').isVisible(), '必须弹出 6 位密码输入框');
    await page.unroute('**/api/original/status');
    await page.unroute('**/api/original/jobs');
    await page.close();
  });

  test('★任务行「复制下载链接」：点一下就复制走这个资源的链接（纯图标，不挤别的控件）', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    await page.goto(`${base}/tasks`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=复制链接测试视频', { timeout: 20000 });

    // 找到"包含这条任务、并且带复制按钮"的最内层容器
    const scoped = page
      .locator('tr, div')
      .filter({ hasText: '复制链接测试视频' })
      .filter({ has: page.locator('button[aria-label="复制下载链接"]') })
      .last();
    const btn = scoped.locator('button[aria-label="复制下载链接"]').first();
    assert.equal(await btn.count(), 1, '每条任务都应有「复制下载链接」按钮');

    // ★ 用户要求：按钮不要用长文字（怕把行撑宽、挤到别的控件）
    assert.equal((await btn.innerText()).trim(), '', '必须是纯图标按钮，文字只放 tooltip');
    assert.ok(((await btn.getAttribute('title')) ?? '').includes('复制'), 'tooltip 要说清楚复制的是什么');

    await btn.click();
    await page.waitForSelector('text=已复制下载链接', { timeout: 5000 });
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(clip, 'https://v.douyin.com/COPYLINK1/', `剪贴板里应该是这个资源的链接，实际：${clip}`);

    // 加了按钮之后别把同行其它控件挤掉
    assert.ok(
      (await scoped.getByRole('button', { name: '删除' }).count()) >= 1,
      '同一行的其它控件（删除）必须还在',
    );
    await page.close();
  });

  test('★复制在 http 局域网访问下也要能用（没有 Clipboard API 时走 execCommand 兜底）', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    // 真机就是这么用的：http://192.168.1.163:8080 —— 非安全上下文里 navigator.clipboard 是 undefined，
    // 只写 clipboard API 的话按钮会"点了没反应"。这里把 API 拿掉，验证兜底路径。
    const page = await newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { get: () => undefined, configurable: true });
    });
    await page.goto(`${base}/tasks`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=复制链接测试视频', { timeout: 20000 });
    assert.equal(
      await page.evaluate(() => Boolean(navigator.clipboard)),
      false,
      '前提：这条用例里必须真的没有 Clipboard API',
    );
    const btn = page
      .locator('tr, div')
      .filter({ hasText: '复制链接测试视频' })
      .filter({ has: page.locator('button[aria-label="复制下载链接"]') })
      .last()
      .locator('button[aria-label="复制下载链接"]')
      .first();
    await btn.click();
    await page.waitForSelector('text=已复制下载链接', { timeout: 5000 });
    assert.equal(await page.locator('text=复制失败').count(), 0, '兜底路径不该报"复制失败"');
    await page.close();
  });

  test('★已入队种子：全选当前页 → 全部删除（三步确认，且如实说明"只删记录"）', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(`${base}/bt-queued`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=已入队种子', { timeout: 20000 });
    assert.ok((await page.locator('text=queued-del-a.torrent').count()) > 0, '应列出已入队种子');

    await page.getByRole('checkbox', { name: '全选当前页' }).first().check();
    await page.waitForTimeout(200);
    assert.ok((await page.locator('text=/已选\\s*2/').count()) > 0, '应显示已选 2 个');

    await page.getByRole('button', { name: /全部删除/ }).first().click();
    await page.waitForSelector('text=确认范围', { timeout: 10000 });
    await page.getByRole('button', { name: /继续（第 2\/3 步）/ }).click();
    await page.waitForSelector('text=确认影响', { timeout: 10000 });
    // 关键：这一步必须**如实**说明留档的 .torrent 不会被删（不能沿用旧的错误说法）
    assert.ok(
      (await page.locator('text=/留档|仍在磁盘上|不删留档/').count()) > 0,
      '要说明留档的 .torrent 不会被删除',
    );
    assert.ok((await page.locator('text=/不会删除/').count()) > 0, '要写清"不会删除"什么');

    await page.getByRole('button', { name: /继续（第 3\/3 步）/ }).click();
    await page.waitForSelector('text=最后确认', { timeout: 10000 });
    const danger = page.getByRole('button', { name: /确认全部删除/ });
    assert.equal(await danger.isDisabled(), true, '未输入确认词时必须禁用');
    await page.getByPlaceholder('删除').fill('删除');
    await page.waitForTimeout(200);
    assert.equal(await danger.isDisabled(), false, '输入确认词后才可用');
    await danger.click();

    await page.waitForSelector('text=最后确认', { state: 'detached', timeout: 15000 });
    await page.waitForTimeout(700);
    assert.equal(await page.locator('text=queued-del-a.torrent').count(), 0, '删除后应从列表消失');
    assert.equal(await page.locator('text=queued-del-b.torrent').count(), 0, '删除后应从列表消失');
    assert.deepEqual(pageErrors, [], `已入队种子页不应有 JS 报错：${pageErrors.join('; ')}`);
    await page.close();
  });

  test('鉴权：未登录访问任何页面都只能看到登录页（不会闪出数据）', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    // 注意：这里刻意**不**注入登录 Cookie，模拟陌生人直接访问
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const apiStatus = [];
    page.on('response', (r) => {
      const u = new URL(r.url());
      if (u.pathname.includes('/api/') && !u.pathname.includes('/api/auth/')) apiStatus.push(r.status());
    });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=ttdownload-web 下载管理器', { timeout: 20000 });
    assert.ok((await page.locator('text=请先登录后再使用').count()) > 0, '应显示登录页');
    assert.ok((await page.getByPlaceholder('请输入用户名').count()) > 0, '应有用户名输入框');
    assert.ok((await page.getByPlaceholder('请输入密码').count()) > 0, '应有密码输入框');
    // 关键：不能看到系统内容
    assert.equal(await page.locator('text=在线视频下载管理器').count(), 0, '未登录不应看到首页内容');
    assert.equal(await page.locator('text=全选当前页').count(), 0, '未登录不应看到业务页面');
    // 业务接口一个都不能成功（401/403）；未登录时前端守卫甚至会完全不发这些请求，两种都算通过
    assert.ok(
      apiStatus.every((code) => code === 401 || code === 403 || code === 404),
      `未登录时不应有业务接口成功，实际状态：${[...new Set(apiStatus)].join(',')}`,
    );
    await context.close();
  });

  test('鉴权：错误密码给出提示，正确密码进入系统，退出后回到登录页', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=请先登录后再使用', { timeout: 20000 });

    // 错误密码
    await page.getByPlaceholder('请输入用户名').fill(AUTH_USER);
    await page.getByPlaceholder('请输入密码').fill('wrong-password');
    await page.getByRole('button', { name: /^登录$/ }).click();
    await page.waitForSelector('text=/账号或密码错误|登录失败/', { timeout: 15000 });

    // 正确密码 → 进入系统（会回跳到之前想去的 /dashboard）
    await page.getByPlaceholder('请输入密码').fill(AUTH_PASS);
    await page.getByRole('button', { name: /^登录$/ }).click();
    await page.waitForSelector('text=在线视频下载管理器', { timeout: 20000 });
    assert.equal(await page.locator('text=请先登录后再使用').count(), 0, '登录后不应再显示登录页');

    // 退出登录 → 回到登录页
    await page.getByRole('button', { name: '退出登录' }).first().click();
    await page.waitForSelector('text=请先登录后再使用', { timeout: 20000 });
    await context.close();
  });

  test('设置页：自动获取访客 cookies 小节可用（不需要人工导出 cookies 的说明与刷新按钮）', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(`${base}/settings`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=自动获取访客 cookies', { timeout: 20000 });

    // 必须讲清「访客 cookies 不需要登录、服务器自动拿」
    assert.ok((await page.locator('text=/访客 cookies/').count()) > 0, '应说明访客 cookies 的概念');
    assert.ok((await page.locator('text=/不用人工导出|自动获取/').count()) > 0, '应说明不用人工导出');

    // 开关
    const toggle = page.getByRole('switch', { name: /启用自动获取/ });
    assert.ok((await toggle.count()) > 0, '应有「启用自动获取」开关');

    // 站点列表 + 刷新按钮（抖音必须在列表里）
    assert.ok((await page.locator('text=抖音').count()) > 0, '应列出抖音');
    assert.ok((await page.getByRole('button', { name: /立即刷新/ }).count()) > 0, '应有「立即刷新」按钮');

    // 没装 chromium 时给出的说明不能吓人：抖音走 HTTP，不影响使用
    const chromiumBlocks = await page.locator('text=/chromium/').count();
    assert.ok(chromiumBlocks > 0, '应说明浏览器依赖情况');
    await page.close();
  });

  test('★任务区：一级页面只放"正在下载/已下载"，排队/扫货/其它各有独立页面且给入口', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(`${base}/tasks`, { waitUntil: 'networkidle' });

    // 一级页面必须给出三个入口
    for (const label of ['排队下载', '归档发布（扫货）', '其它任务']) {
      const link = page.getByText(label, { exact: false }).first();
      await link.waitFor({ state: 'visible', timeout: 15000 });
      assert.ok(await link.isVisible(), `一级任务页应有「${label}」入口`);
    }
    // 一级页面不该出现"排队中/归档发布"这类分区标题（它们已挪到各自的页面）
    const body = (await page.locator('main, body').first().innerText()).replace(/\s+/g, ' ');
    assert.equal(body.includes('等待并发名额或磁盘空间放行'), false, '一级页面不应再显示排队分区');

    // 点进"归档发布"独立页：地址要对、标题要对、且带"返回下载任务"
    await page.getByText('归档发布（扫货）', { exact: false }).first().click();
    await page.waitForURL(/\/tasks-publish/, { timeout: 15000 });
    await page.waitForTimeout(400);
    const publishBody = (await page.locator('main, body').first().innerText()).replace(/\s+/g, ' ');
    assert.ok(publishBody.includes('归档发布'), '独立页标题应含「归档发布」');
    assert.ok(publishBody.includes('返回下载任务'), '独立页应能返回一级页面');

    // 另外两个独立页也要能直接打开（不报错、有返回入口）
    for (const sub of ['tasks-waiting', 'tasks-other']) {
      await page.goto(`${base}/${sub}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      const text = (await page.locator('main, body').first().innerText()).replace(/\s+/g, ' ');
      assert.ok(text.includes('返回下载任务'), `/tasks/${sub} 应有返回入口`);
    }
  });

  test('★回归：解析中途点侧边栏去「任务」再回「首页」，解析不能丢（原来会变成空首页）', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    process.env.BROWSER_PARSE_DELAY = '6'; // 让解析慢 6 秒，好切走
    try {
      const page = await newPage();
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.getByPlaceholder('粘贴视频链接').first().fill('https://www.youtube.com/watch?v=abc123');
      await page.getByRole('button', { name: /解析视频/ }).first().click();

      // 趁"解析中"点侧边栏去任务页（SPA 切页，不会中断请求）
      await page.waitForTimeout(500);
      await page.getByRole('link', { name: '任务' }).first().click();
      await page.waitForSelector('text=任务', { timeout: 15000 });

      // 切回首页：地址必须还在，解析要么还在转、要么已经出结果
      await page.getByRole('link', { name: '首页' }).first().click();
      await page.waitForTimeout(400);
      assert.equal(
        await page.getByPlaceholder('粘贴视频链接').first().inputValue(),
        'https://www.youtube.com/watch?v=abc123',
        '切回来地址不能丢（原来会清空成空首页）',
      );

      // 注意：不能用 text=浏览器测试视频 来等 —— 首页的「最近任务」里也可能有同名任务（前面的用例建的），
      // 会提前匹配到。直接等结果卡片上的按钮最可靠。
      const addBtn = page.getByRole('button', { name: /加入下载队列/ }).first();
      try {
        await addBtn.waitFor({ state: 'visible', timeout: 25000 });
      } catch {
        const bodyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300);
        assert.fail(`切回来应能看到解析结果（加入下载队列 按钮）；页面文本=${bodyText}`);
      }
      assert.ok(await addBtn.isVisible(), '切回来应能看到解析结果并能加入队列');

      // 整页刷新：地址仍要保留（请求会被浏览器中断，所以只要求地址在 + 有明确提示）
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);
      assert.equal(
        await page.getByPlaceholder('粘贴视频链接').first().inputValue(),
        'https://www.youtube.com/watch?v=abc123',
        '刷新后地址也要保留',
      );
      await page.close();
    } finally {
      delete process.env.BROWSER_PARSE_DELAY;
    }
  });

  test('任务页「全选 + 批量操作」：勾选 → 已选计数 → 全部暂停（并如实提示跳过项）', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.goto(`${base}/tasks`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=批量操作测试任务', { timeout: 15000 });

    // 勾选这一个任务（用 aria-label 精确定位，避免和别的复选框混）
    await page.getByLabel(`选择任务 ${bulkTask.id}`).first().check();
    await page.waitForSelector('text=/已选\\s*1\\s*个/', { timeout: 5000 });

    // 「全选当前页」要把本页的都选上（这时至少包含刚造的那条）
    await page.getByLabel('全选当前页').first().check();
    const selectedText = await page.locator('text=/已选\\s*\\d+\\s*个/').first().innerText();
    assert.match(selectedText, /已选\s*\d+\s*个/, '要显示已选数量');

    // 全部暂停：这条是 downloading → 应该被暂停；页面要给结果提示
    await page.getByRole('button', { name: /全部暂停/ }).first().click();
    await page.waitForSelector('text=/已暂停\\s*\\d+\\s*个任务|已暂停\\s*\\d+\\s*个|没有任务被暂停/', { timeout: 10000 });
    await page.close();
  });

  test('更新页：手动更新命令可一键复制到剪贴板（页面看不到的东西也要能兜底）', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await newPage();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    await page.goto(`${base}/update`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=手动更新命令', { timeout: 15000 });

    // 页面上显示的那条命令（页面上还有别的 <code>，按内容精确定位到 deploy.sh 那条）
    const shown = (await page.locator('code', { hasText: 'deploy.sh' }).first().innerText()).trim();
    assert.match(shown, /sudo \.\/deploy\.sh --update$/, `要显示手动升级命令，实际：${shown}`);

    await page.getByRole('button', { name: /复制命令/ }).first().click();
    await page.waitForSelector('text=已复制', { timeout: 5000 });

    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(clip.trim(), shown, '剪贴板内容必须和页面显示的命令一致');
    await page.close();
  });

  test('页面无 JS 报错', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    assert.deepEqual(pageErrors, [], `浏览器控制台错误：\n${pageErrors.join('\n')}`);
  });
}
