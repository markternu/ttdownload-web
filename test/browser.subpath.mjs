/**
 * 子路径部署（nginx 反代 /ttdownload/）端到端测试
 *
 * 场景：远程服务器只开放 22/80/443，8080 外网不可达，于是用 nginx 把
 *       http://host/ttdownload/ 反代到 http://127.0.0.1:8080/（去掉前缀）。
 * 本测试用一个本地 Node 代理模拟 nginx：收到 /ttdownload/xxx → 转发到后端 /xxx。
 * 重点验证：前端在前缀下仍能正确请求 API（相对路径）与 SSE，刷新深层路由也能拿到 index.html。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setupRuntime, startAria2Mock } from './helpers.mjs';

const PREFIX = '/ttdownload';
const publicDir = path.resolve('public');
const hasBuild = fs.existsSync(path.join(publicDir, 'index.html'));

if (!hasBuild) {
  test('子路径部署测试（跳过：public/ 未构建）', { skip: true }, () => {});
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
  echo '{"title":"子路径测试视频","uploader":"作者","duration":60,"thumbnail":"http://x/t.jpg","formats":[{"format_id":"18","ext":"mp4","resolution":"360p","height":360,"vcodec":"avc1","acodec":"mp4a","filesize":1000}]}'
  exit 0
fi
OUT=""; prev=""
for a in "$@"; do if [ "$prev" = "-o" ]; then OUT="$a"; fi; prev="$a"; done
[ -z "$OUT" ] && exit 0
DIR=$(dirname "$OUT"); mkdir -p "$DIR"; echo "v" > "$DIR/subpath.mp4"; echo "PROG 100 100 0 NA"; exit 0
`,
    { mode: 0o755 },
  );
  process.env.YTDLP_BIN = fakeYtdlp;

  const { createApp } = await import('../dist/app.js');
  const app = http.createServer(createApp());
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const appPort = app.address().port;

  /** 模拟 nginx：/ttdownload/<rest> → 后端 /<rest>（去掉前缀） */
  const seen = { api: [], sse: 0, html: 0 };
  const proxy = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/other-site') {
      res.writeHead(200).end('别的站点');
      return;
    }
    if (!url.startsWith(`${PREFIX}/`) && url !== PREFIX) {
      res.writeHead(404).end('nope');
      return;
    }
    const rest = url.slice(PREFIX.length) || '/';
    if (rest.startsWith('/api/')) seen.api.push(rest);
    if (rest === '/api/events') seen.sse += 1;
    if (!rest.startsWith('/api/')) seen.html += 1;
    const upstream = http.request(
      { host: '127.0.0.1', port: appPort, path: rest, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', (e) => res.writeHead(502).end(String(e)));
    req.pipe(upstream);
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${proxy.address().port}`;

  const { chromium } = await import('playwright');
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (e) {
    console.warn('未找到 Chrome，跳过后端子路径测试：', e.message);
  }

  const pageErrors = [];

  test.after(async () => {
    if (browser) await browser.close();
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => app.close(r));
    await mock.close();
  });

  test('子路径下首页可打开，且 API/SSE 都带上前缀（不是打到根路径）', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/ERR_NAME_NOT_RESOLVED|Failed to load resource|net::ERR_/.test(m.text())) {
        pageErrors.push(m.text());
      }
    });
    const requests = [];
    page.on('request', (r) => requests.push(new URL(r.url()).pathname));

    await page.goto(`${base}${PREFIX}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=在线视频下载管理器', { timeout: 20000 });

    // 静态资源与 API 都必须走 /ttdownload 前缀（nginx 会把前缀去掉）
    const apiRequests = requests.filter((p) => p.includes('/api/'));
    assert.ok(apiRequests.length > 0, '应发出 API 请求');
    assert.ok(
      apiRequests.every((p) => p.startsWith(`${PREFIX}/api/`)),
      `所有 API 请求都应带 ${PREFIX} 前缀，实际：${[...new Set(apiRequests)].slice(0, 5).join(', ')}`,
    );
    // 关键：不能出现打到根路径的 /api/... （那会 404）
    assert.equal(
      requests.some((p) => p.startsWith('/api/')),
      false,
      '不允许出现不带前缀的 /api/ 请求',
    );
    // 数据真的加载出来了（说明请求 200）
    assert.ok(seen.api.length > 0, '代理应转发过 API 请求');
    assert.ok(seen.sse >= 1, 'SSE（/api/events）也应带前缀并建立连接');
    assert.deepEqual(pageErrors, [], `子路径下不应有 JS 报错：${pageErrors.join('; ')}`);
    await page.close();
  });

  test('子路径下的深层路由刷新（SPA fallback）与其它站点互不影响', async (t) => {
    if (!browser) return t.skip('无 Chrome');
    const page = await browser.newPage();
    const loaded = [];
    page.on('request', (r) => loaded.push(new URL(r.url()).pathname));
    // 直接刷新深层路由：nginx 会转发 /ttdownload/tasks → 后端 /tasks → 返回 index.html
    const res = await page.goto(`${base}${PREFIX}/tasks`, { waitUntil: 'networkidle' });
    assert.equal(res?.status(), 200);
    // 必须真的渲染出任务页（而不是被 BrowserRouter 当成未知路由显示 404）
    await page.waitForSelector('text=/任务列表|下载任务/', { timeout: 20000 });
    assert.equal(
      loaded.some((p) => p.includes('NotFoundPage')),
      false,
      '子路径下不应加载 NotFoundPage（说明 BrowserRouter 的 basename 没生效）',
    );
    assert.equal(await page.locator('text=页面不存在').count(), 0, '不应出现 404 页面');
    // 别的站点（根路径）不受影响
    const other = await fetch(`${base}/other-site`);
    assert.equal(other.status, 200);
    assert.equal(await other.text(), '别的站点');
    await page.close();
  });
}
