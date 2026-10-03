/**
 * HTTP API 集成测试：任务/设置/三模块入口/文件/安卓通信/SSE
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { setupRuntime, startAria2Mock, tmpFile } from './helpers.mjs';

const mock = await startAria2Mock({ workDir: '/tmp' });
const root = setupRuntime({
  env: {
    ARIA2_RPC_PORT: String(mock.port),
    // 「下载原始文件」的密码种子（6 位密码由它 + 15 分钟窗口算出来）
    ORIGINAL_DL_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  },
});

// 假 yt-dlp
const fakeYtdlp = path.join(root, 'bin', 'yt-dlp');
fs.mkdirSync(path.dirname(fakeYtdlp), { recursive: true });
fs.writeFileSync(
  fakeYtdlp,
  `#!/bin/bash
if [ "$1" = "--version" ]; then echo "2024.01.01"; exit 0; fi
if [ "$1" = "-J" ]; then
  if [ -n "$API_PARSE_FAIL" ]; then
    echo "$API_PARSE_FAIL" >&2
    exit 1
  fi
  echo '{"title":"API 测试视频","uploader":"作者","duration":10,"thumbnail":"http://x/t.jpg","formats":[{"format_id":"18","ext":"mp4","resolution":"360p","height":360,"vcodec":"avc1","acodec":"mp4a","filesize":1000}]}'
  exit 0
fi
OUT=""; prev=""
for a in "$@"; do if [ "$prev" = "-o" ]; then OUT="$a"; fi; prev="$a"; done
DIR=$(dirname "$OUT"); [ -z "$OUT" ] && exit 0; mkdir -p "$DIR"; echo "fake" > "$DIR/api.mp4"; echo "PROG 100 100 0 NA"; exit 0
`,
  { mode: 0o755 },
);
process.env.YTDLP_BIN = fakeYtdlp;

const { createApp } = await import('../dist/app.js');
const { handoffToArchive, pipelineTick } = await import('../dist/services/pipeline.js');
const { tasksRepo, filesRepo } = await import('../dist/core/db.js');

const server = http.createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const token = 'test-token';

async function get(p, init = {}) {
  const res = await fetch(base + p, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text, headers: res.headers };
}

test.after(async () => {
  const { stopScheduler } = await import('../dist/core/scheduler.js');
  const { stopPipeline } = await import('../dist/services/pipeline.js');
  stopScheduler();
  stopPipeline();
  await new Promise((r) => server.close(r));
  await mock.close();
});

test('GET /api/health 与 /api/system', async () => {
  const h = await get('/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.ok, true);
  const sys = await get('/api/system');
  assert.equal(sys.status, 200);
  assert.ok(sys.json.dirs.root);
  assert.ok('ytdlp' in sys.json.tools);
});

test('aria2 多行 URL 提交：逐条校验 + 去重', async () => {
  const res = await get('/api/aria2/urls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: 'http://example.com/a.bin\nnot-a-url\nhttp://example.com/a.bin\nhttp://example.com/b.bin' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.created, 2, '两个合法且不重复的 URL');
  const reasons = res.json.skipped.map((s) => s.reason).join('|');
  assert.match(reasons, /格式错误/);
  assert.match(reasons, /重复/);

  // 再次提交同一个 URL -> 全部跳过
  const again = await get('/api/aria2/urls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: 'http://example.com/a.bin' }),
  });
  assert.equal(again.json.created, 0);
  assert.match(again.json.skipped[0].reason, /已在队列中/);
});

test('webvideo 解析 + 入队', async () => {
  const meta = await get('/api/webvideo/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc' }),
  });
  assert.equal(meta.status, 200);
  assert.equal(meta.json.title, 'API 测试视频');
  assert.equal(meta.json.platform, 'YouTube');

  const created = await get('/api/webvideo/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc', formatId: '18' }),
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.task.module, 'webvideo');

  // 重复入队应返回同一任务
  const dup = await get('/api/webvideo/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc', formatId: '18' }),
  });
  assert.equal(dup.json.duplicated, true);
  assert.equal(dup.json.task.id, created.json.task.id);
});

test('非法 URL / 缺少参数 返回 400 与中文错误', async () => {
  const bad = await get('/api/webvideo/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'ftp://x/y' }),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error.message, /URL 格式错误/);

  const missing = await get('/api/aria2/urls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: '' }),
  });
  assert.equal(missing.status, 400);
});

test('任务列表 / 单任务 / 操作（暂停/继续/重试/删除）', async () => {
  const list = await get('/api/tasks?pageSize=50');
  assert.equal(list.status, 200);
  assert.ok(list.json.total >= 2);

  const task = tasksRepo.create({ module: 'aria2', title: 'actions.bin', platform: 'URL', url: 'http://example.com/actions.bin' });
  const one = await get(`/api/tasks/${task.id}`);
  assert.equal(one.json.id, task.id);

  const pause = await get(`/api/tasks/${task.id}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pause' }),
  });
  assert.equal(pause.json.ok, true);
  assert.equal(tasksRepo.get(task.id).status, 'paused');

  const retry = await get(`/api/tasks/${task.id}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'retry' }),
  });
  assert.equal(retry.json.ok, true);
  assert.equal(tasksRepo.get(task.id).status, 'waiting');

  const del = await get(`/api/tasks/${task.id}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete' }),
  });
  assert.equal(del.json.ok, true);
  assert.equal(tasksRepo.get(task.id), null);

  const notFound = await get('/api/tasks/999999');
  assert.equal(notFound.status, 404);
});

test('设置读取/更新 + 工具连通性测试', async () => {
  const s = await get('/api/settings');
  assert.equal(s.status, 200);
  assert.equal(s.json.encryptPassword, '******');

  const upd = await get('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxConcurrent: 5, theme: 'dark' }),
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.maxConcurrent, 5);
  assert.equal(upd.json.theme, 'dark');

  // 回归：公开视频 cookies / 额外参数必须能保存（PUT 白名单曾漏掉这三个字段）
  const cookiesPath = '/ttdownload/state/cookies.txt';
  const wv = await get('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webvideoCookiesFile: cookiesPath,
      webvideoCookiesFromBrowser: 'chrome',
      webvideoExtraArgs: '--proxy socks5://127.0.0.1:1080',
    }),
  });
  assert.equal(wv.status, 200);
  assert.equal(wv.json.webvideoCookiesFile, cookiesPath);
  assert.equal(wv.json.webvideoCookiesFromBrowser, 'chrome');
  assert.equal(wv.json.webvideoExtraArgs, '--proxy socks5://127.0.0.1:1080');
  const reread = await get('/api/settings');
  assert.equal(reread.json.webvideoCookiesFile, cookiesPath, '重新读取设置应保留 cookies 路径');
  assert.equal(reread.json.webvideoExtraArgs, '--proxy socks5://127.0.0.1:1080');
  // 还原，避免影响后续用例（cookies 接口测试用的是默认路径）
  await get('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webvideoCookiesFile: '', webvideoCookiesFromBrowser: '', webvideoExtraArgs: '' }),
  });

  const test1 = await get('/api/settings/test-connection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'aria2' }),
  });
  assert.equal(test1.json.ok, true, test1.json.message);
});

test('安卓接口：鉴权 / 清单 / 下载(Range) / 上报删除', async () => {
  // 无 token -> 401
  const noToken = await get('/api/android/files');
  assert.equal(noToken.status, 401);

  // 造一个已发布文件
  const src = tmpFile(root, 'android/movie.mp4', 'A'.repeat(4096));
  const task = tasksRepo.create({ module: 'webvideo', title: '安卓消费测试.mp4', platform: 'YouTube', url: 'https://youtu.be/zzz' });
  handoffToArchive(task.id, [src], '安卓消费测试.mp4', 4096);
  await pipelineTick();
  await pipelineTick();

  const files = await get('/api/android/files', { headers: { 'X-Auth-Token': token } });
  assert.equal(files.status, 200);
  assert.equal(files.json.total, 1);
  const item = files.json.items[0];
  assert.ok(item.name);
  assert.ok(item.url.includes('/api/android/download/'));
  assert.equal(files.json.freeBytes > 0, true);

  // 下载（全量）
  const dl = await fetch(base + item.downloadUrl, { headers: { 'X-Auth-Token': token } });
  assert.equal(dl.status, 200);
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.equal(buf.length > 0, true);

  // 下载（Range 断点续传）
  const range = await fetch(`${base}${item.downloadUrl}?x=1`, { headers: { 'X-Auth-Token': token, Range: 'bytes=0-99' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-99/${buf.length}`);

  // query token 也可用（便于 aria2 直接下载）
  const viaQuery = await fetch(`${base}${item.url.replace('/api/android/download/', '/api/android/download/')}`);
  assert.equal(viaQuery.status, 200);

  // 上报完成 -> 删除文件
  const done = await get('/api/android/done', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
    body: JSON.stringify({ ids: [item.id] }),
  });
  assert.equal(done.status, 200);
  assert.equal(done.json.deleted, 1);
  assert.equal(done.json.freedBytes > 0, true);

  const publishedPath = path.join(root, 'xiaofeizhe_downd', item.name);
  assert.equal(fs.existsSync(publishedPath), false, '文件应被删除');

  const filesAfter = await get('/api/android/files', { headers: { 'X-Auth-Token': token } });
  assert.equal(filesAfter.json.total, 0);
});

test('局域网测速端点：不读硬盘吐满 N MB / 需 token / 页面可用', async () => {
  // 无 token -> 401（测速口不能被公网随便刷流量）
  const noTok = await fetch(`${base}/api/android/speedtest/data?mb=1`);
  assert.equal(noTok.status, 401);
  const noTokPage = await fetch(`${base}/api/android/speedtest?mb=1`);
  assert.equal(noTokPage.status, 401);

  // 吐满指定字节数，且带 Content-Length（浏览器才能算速率）
  const r = await fetch(`${base}/api/android/speedtest/data?mb=2`, { headers: { 'X-Auth-Token': token } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('content-length'), String(2 * 1024 * 1024));
  const body = Buffer.from(await r.arrayBuffer());
  assert.equal(body.length, 2 * 1024 * 1024);
  // 伪随机（不是全 0），走压缩代理也不会被压小
  assert.ok(body.subarray(0, 1024).some((b) => b !== 0), '内容不应全为 0');

  // 上限保护：mb 再大也不能被拿来打服务端（只验头部，然后立刻中断，别真拉 500MB）
  const ac = new AbortController();
  const big = await fetch(`${base}/api/android/speedtest/data?mb=99999`, { headers: { 'X-Auth-Token': token }, signal: ac.signal });
  assert.equal(big.headers.get('content-length'), String(500 * 1024 * 1024));
  ac.abort();
  await new Promise((r) => setTimeout(r, 50)); // 让服务端走到 close 分支，确认不会挂住

  // 手机浏览器直接打开的测速页
  const page = await fetch(`${base}/api/android/speedtest?mb=10&token=${token}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  const html = await page.text();
  assert.match(html, /局域网测速/);
  assert.match(html, /speedtest\/data/);
});

test('管理端文件列表 / 删除记录与删除文件区分', async () => {
  const src = tmpFile(root, 'admin/keep.mp4', 'K'.repeat(1024));
  const task = tasksRepo.create({ module: 'aria2', title: '管理端测试.mp4', platform: 'URL', url: 'http://example.com/keep.mp4' });
  handoffToArchive(task.id, [src], '管理端测试.mp4', 1024);
  await pipelineTick();
  await pipelineTick();

  const list = await get('/api/files');
  assert.ok(list.json.total >= 1);
  const file = list.json.items.find((f) => f.title === '管理端测试.mp4');
  const diskPath = path.join(root, 'xiaofeizhe_downd', file.name);

  // 只删记录，不删文件
  const delRecord = await get(`/api/files/${file.id}?withFile=0`, { method: 'DELETE' });
  assert.equal(delRecord.json.ok, true);
  assert.equal(delRecord.json.deletedFile, false);
  assert.equal(fs.existsSync(diskPath), true, '只删记录时文件必须保留');

  const orphans = await get('/api/files/orphans');
  assert.ok(orphans.json.orphans.includes(file.name));
});

const MEMBERS_ERROR =
  "ERROR: [youtube] f6kl3G_ek-A: This video is available to this channel's members on level: 高级VIP会员（人工咨询服务） (or any higher level). Join this channel to get access to members-only content and other exclusive perks.";

test('解析受限（会员专享/需登录）：不再返回 400，而是 degraded 结果且仍可入队', async () => {
  process.env.API_PARSE_FAIL = MEMBERS_ERROR;
  try {
    const res = await get('/api/webvideo/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=f6kl3G_ek-A' }),
    });
    assert.equal(res.status, 200, '不应再直接 400 拒绝');
    assert.equal(res.json.degraded, true);
    assert.match(res.json.parseError, /频道会员专享/);
    assert.match(res.json.parseError, /cookies/);
    assert.deepEqual(res.json.formats, []);
    assert.equal(res.json.platform, 'YouTube');

    // 解析受限也允许入队（下载时自动多方式尝试）
    const created = await get('/api/webvideo/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=f6kl3G_ek-A', title: res.json.title }),
    });
    assert.equal(created.status, 200);
    assert.equal(created.json.task.module, 'webvideo');
  } finally {
    process.env.API_PARSE_FAIL = '';
  }
});

test('cookies 查询 / 上传（JSON 与 multipart）/ 删除', async () => {
  await get('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webvideoCookiesFile: '' }),
  });
  const before = await get('/api/webvideo/cookies');
  assert.equal(before.status, 200);
  assert.equal(before.json.exists, false);
  assert.match(before.json.defaultPath, /cookies\.txt$/);

  const body = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc\n';
  const uploaded = await get('/api/webvideo/cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: body }),
  });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.json.exists, true);
  assert.ok(uploaded.json.sizeBytes > 0);
  assert.ok(uploaded.json.updatedAt);

  // 前端走的是 multipart/form-data（字段名 file）
  const form = new FormData();
  form.append('file', new Blob([body + '# extra\n'], { type: 'text/plain' }), 'cookies.txt');
  const viaForm = await fetch(`${base}/api/webvideo/cookies`, { method: 'POST', body: form });
  assert.equal(viaForm.status, 200);
  const viaFormJson = await viaForm.json();
  assert.equal(viaFormJson.exists, true);
  assert.ok(viaFormJson.sizeBytes > uploaded.json.sizeBytes);

  // 再传一次：应自动备份上一份（避免"新导出的其实是没登录的残缺文件"时无从回退）
  const second = await get('/api/webvideo/cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t9999999999\tPREF\ty\n' }),
  });
  assert.equal(second.status, 200);
  assert.equal(second.json.backup.exists, true, '第二次上传应留下 .bak 备份');
  assert.ok(second.json.backup.sizeBytes > 0);
  const recheck = await get('/api/webvideo/cookies');
  assert.equal(recheck.json.backup.exists, true, '状态查询里应能看到备份');

  const removed = await get('/api/webvideo/cookies', { method: 'DELETE' });
  assert.equal(removed.json.exists, false);

  const empty = await get('/api/webvideo/cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '   ' }),
  });
  assert.equal(empty.status, 400);
});

test('策略预览接口返回「尽力下载」的方式清单', async () => {
  const res = await get('/api/webvideo/attempts?url=https://www.youtube.com/watch?v=abc');
  assert.equal(res.status, 200);
  assert.ok(res.json.attempts.length >= 8);
  assert.ok(res.json.attempts.some((a) => a.includes('多客户端')));
  assert.ok(res.json.attempts.includes('仅音频（保底）'));
});

test('SSE /api/events 返回事件流', async () => {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /text\/event-stream/);
  const reader = res.body.getReader();
  const chunk = await Promise.race([
    reader.read(),
    new Promise((r) => setTimeout(() => r({ value: new TextEncoder().encode('retry: 3000\n\n') }), 1500)),
  ]);
  assert.ok(chunk.value);
  ac.abort();
});

/* ------------------------------------------------------------------ */
/* 待下载清单（已加密归档、安卓还没取走的成品）                          */
/* ------------------------------------------------------------------ */

test('待下载清单：发布后出现在 /api/files/pending，网页下载只计网页次数', async () => {
  const consumers = path.join(root, 'xiaofeizhe_downd');
  fs.mkdirSync(consumers, { recursive: true });
  const filePath = path.join(consumers, 'pend1');
  fs.writeFileSync(filePath, 'encrypted-fixture-content');

  const id = filesRepo.add({
    taskId: null,
    name: 'pend1',
    title: '待下载测试视频.mp4',
    module: 'webvideo',
    sizeBytes: 24,
    path: filePath,
  });

  // 1) 出现在待下载清单里
  let pending = await get('/api/files/pending');
  assert.equal(pending.status, 200);
  const item = pending.json.items.find((f) => f.id === id);
  assert.ok(item, '新发布的文件应出现在待下载清单');
  assert.equal(item.name, 'pend1');
  assert.equal(item.module, 'webvideo');
  assert.equal(item.downloadUrl, `/api/files/${id}/download`, '管理端下载地址应指向 /api/files/:id/download');
  assert.equal(item.androidDownloadUrl, `/api/android/download/${id}`, '安卓端下载地址也应给出');
  assert.equal(item.downloaded, false);
  assert.equal(item.androidDownloads, 0, '还没被安卓取走');
  assert.ok(typeof item.waitingSec === 'number' && item.waitingSec >= 0, '应给出已等待秒数');
  assert.ok(pending.json.total >= 1);
  assert.ok(pending.json.totalBytes >= 24);

  // 2) 网页端下载 → 只增加网页计数，安卓计数不变，仍在待下载清单里
  const webDl = await get(`/api/files/${id}/download`);
  assert.equal(webDl.status, 200);
  assert.equal(webDl.text, 'encrypted-fixture-content');
  pending = await get('/api/files/pending');
  let after = pending.json.items.find((f) => f.id === id);
  assert.equal(after.webDownloads, 1, '网页端下载次数应为 1');
  assert.equal(after.androidDownloads, 0, '网页端下载不应算作安卓已取走');
  assert.ok(after.lastWebDownloadAt, '应记录网页端最后下载时间');
  assert.equal(after.downloaded, false);

  // 3) 安卓端下载（带 token）→ 安卓计数 +1，但**仍是待下载**（没上报完成不能算已消费）
  const anDl = await get(`/api/android/download/${id}`, { headers: { 'X-Auth-Token': token } });
  assert.equal(anDl.status, 200);
  pending = await get('/api/files/pending');
  after = pending.json.items.find((f) => f.id === id);
  assert.equal(after.androidDownloads, 1, '安卓端下载次数应为 1');
  assert.ok(after.lastAndroidDownloadAt, '应记录安卓端最后下载时间');
  assert.equal(after.downloaded, false, '未上报完成前不应标记为已下载');
  assert.ok(pending.json.items.some((f) => f.id === id), '取走但未上报的文件仍应留在待下载清单');

  // 4) 安卓上报完成 → 从待下载清单消失
  const done = await get('/api/android/done', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
    body: JSON.stringify({ ids: [id] }),
  });
  assert.equal(done.status, 200);
  pending = await get('/api/files/pending');
  assert.equal(pending.json.items.some((f) => f.id === id), false, '上报完成后应从待下载清单移除');
});

test('待下载清单支持搜索，且旧的 /api/files 列表也带上跟踪字段', async () => {
  const all = await get('/api/files?pageSize=50');
  assert.equal(all.status, 200);
  for (const f of all.json.items) {
    assert.ok(typeof f.androidDownloads === 'number', 'items 应带 androidDownloads');
    assert.ok(typeof f.webDownloads === 'number', 'items 应带 webDownloads');
    assert.ok(f.downloadUrl.startsWith('/api/files/'), 'items 应带管理端下载地址');
  }
  const noMatch = await get('/api/files/pending?q=绝对不存在的文件名zzz');
  assert.equal(noMatch.json.items.length, 0);
  assert.equal(noMatch.json.total, 0);
});

test('任务状态操作：不可暂停/不可继续时给 409 + 中文原因（而不是 500 服务器内部错误）', async () => {
  const created = await get('/api/webvideo/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
    body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc123' }),
  });
  const id = created.json?.task?.id;
  assert.ok(id, `应能创建任务：${created.text.slice(0, 200)}`);

  // 直接把它置为完成态，制造"不可暂停"的场景
  const { tasksRepo } = await import('../dist/core/db.js');
  tasksRepo.update(id, { status: 'completed' });

  const act = (action) =>
    get(`/api/tasks/${id}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
      body: JSON.stringify({ action }),
    });

  const paused = await act('pause');
  assert.equal(paused.status, 409, `已完成任务暂停应为 409，实际 ${paused.status}：${paused.text.slice(0, 160)}`);
  assert.equal(paused.json?.error?.code, 'TASK_NOT_PAUSABLE');
  assert.match(String(paused.json?.error?.message ?? ''), /不能暂停|不可暂停/, '要给出中文原因（原来只说"服务器内部错误"）');

  const resumed = await act('resume');
  assert.equal(resumed.status, 409);
  assert.equal(resumed.json?.error?.code, 'TASK_NOT_RESUMABLE');

  const missing = await get('/api/tasks/999999/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
    body: JSON.stringify({ action: 'pause' }),
  });
  assert.equal(missing.status, 404, '不存在的任务应为 404');
});

test('已发布文件：磁盘文件被删后必须标记 available=false（前端据此置灰下载按钮）', async () => {
  const fs = await import('node:fs');
  const { filesRepo } = await import('../dist/core/db.js');
  const { config } = await import('../dist/core/config.js');

  // 造一个"已发布但磁盘文件已被删除"的记录（安卓下载完成后就是这个状态）
  const id = filesRepo.add({
    taskId: null,
    name: 'gone1',
    title: '已被安卓取走并删除的文件.mp4',
    module: 'webvideo',
    sizeBytes: 1234,
    path: `${config.dirs.consumer}/gone1`,
  });
  filesRepo.trackDownload(id, 'android');

  const res = await get('/api/files', { headers: { 'X-Auth-Token': token } });
  assert.equal(res.status, 200);
  const item = (res.json?.items ?? []).find((f) => f.id === id);
  assert.ok(item, '应能查到这条记录（记录保留作历史）');
  assert.equal(item.available, false, '磁盘上没有文件时必须 available=false');
  assert.ok(item.androidDownloads >= 1, '应记录安卓下载次数');

  // 文件真的存在时 available 必须是 true
  fs.writeFileSync(`${config.dirs.consumer}/gone1`, 'x');
  const res2 = await get('/api/files', { headers: { 'X-Auth-Token': token } });
  const item2 = (res2.json?.items ?? []).find((f) => f.id === id);
  assert.equal(item2.available, true, '文件存在时 available=true');

  fs.rmSync(`${config.dirs.consumer}/gone1`, { force: true });
  filesRepo.remove(id);
});

/* ------------------------------------------------------------------ */
/* 「已发布」与「待下载」合并成一个列表：状态筛选 + 批量删除              */
/* ------------------------------------------------------------------ */

/** 造一个成品记录（可选标记"已被下载"）；返回 { id, path } */
function makePublished(name, { downloaded = false } = {}) {
  const consumers = path.join(root, 'xiaofeizhe_downd');
  fs.mkdirSync(consumers, { recursive: true });
  const filePath = path.join(consumers, name);
  fs.writeFileSync(filePath, `content-${name}`);
  const id = filesRepo.add({
    taskId: null,
    name,
    title: `标题-${name}`,
    module: 'webvideo',
    sizeBytes: fs.statSync(filePath).size,
    path: filePath,
  });
  if (downloaded) filesRepo.markDownloaded(id);
  return { id, path: filePath };
}

test('★状态筛选：合并后的列表能用 status 分开「待下载 / 已被下载」，并给出各状态计数', async () => {
  const pendingOne = makePublished('merge-pending-1');
  const doneOne = makePublished('merge-done-1', { downloaded: true });

  const all = await get('/api/files?pageSize=500&status=all');
  assert.equal(all.status, 200);
  assert.ok(all.json.items.some((f) => f.id === pendingOne.id));
  assert.ok(all.json.items.some((f) => f.id === doneOne.id));

  const pending = await get('/api/files?pageSize=500&status=pending');
  assert.ok(pending.json.items.some((f) => f.id === pendingOne.id), '待下载视图应包含未取走的');
  assert.equal(pending.json.items.some((f) => f.id === doneOne.id), false, '待下载视图不应包含已被下载的');

  const downloaded = await get('/api/files?pageSize=500&status=downloaded');
  assert.ok(downloaded.json.items.some((f) => f.id === doneOne.id), '已被下载视图应包含已取走的');
  assert.equal(downloaded.json.items.some((f) => f.id === pendingOne.id), false, '已被下载视图不应包含待下载的');

  // 三个视图必须与 /pending 老接口口径一致（同一份数据，别再出现两套数）
  const legacy = await get('/api/files/pending?pageSize=500');
  assert.deepEqual(
    pending.json.items.map((f) => f.id).sort((a, b) => a - b),
    legacy.json.items.map((f) => f.id).sort((a, b) => a - b),
    'status=pending 必须与 /api/files/pending 完全一致',
  );

  // 计数：all = pending + downloaded；且 oldestPendingAt 取全量最早的那个
  const c = all.json.counts;
  assert.ok(c, '列表接口应返回 counts');
  assert.equal(c.all, c.pending + c.downloaded, 'all 必须等于 pending + downloaded');
  assert.ok(c.pending >= 1 && c.downloaded >= 1);
  assert.ok(c.oldestPendingAt, '有待下载时应给出最早的待下载时间');
  assert.ok(Date.parse(c.oldestPendingAt) > 0, 'oldestPendingAt 应是可解析的 ISO 时间');
});

test('★批量删除：删掉所选记录，默认不动磁盘文件', async () => {
  const a = makePublished('bulk-a');
  const b = makePublished('bulk-b');
  const keep = makePublished('bulk-keep');

  const res = await get('/api/files/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [a.id, b.id] }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.deleted, 2);
  assert.equal(res.json.failed.length, 0);
  assert.equal(res.json.withFile, false);
  assert.equal(res.json.deletedFiles, 0, '默认只删记录，不删磁盘文件');

  assert.equal(filesRepo.get(a.id), null, '记录应被删除');
  assert.equal(filesRepo.get(b.id), null);
  assert.ok(filesRepo.get(keep.id), '没选中的记录不能被动到');
  assert.ok(fs.existsSync(a.path), '默认不删磁盘文件（空间不释放）');
  assert.ok(fs.existsSync(b.path));
});

test('★批量删除：withFile=1 时连磁盘文件一起删（真正释放空间）', async () => {
  const a = makePublished('bulk-file-a');
  const b = makePublished('bulk-file-b');

  const res = await get('/api/files/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [a.id, b.id], withFile: true }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.deleted, 2);
  assert.equal(res.json.deletedFiles, 2, '应报告删掉了 2 个磁盘文件');
  assert.equal(fs.existsSync(a.path), false, '磁盘文件应被删除');
  assert.equal(fs.existsSync(b.path), false);
});

test('★批量删除：单个失败不影响其它（不存在的 id 逐条回报，而不是整批失败）', async () => {
  const ok = makePublished('bulk-partial-ok');
  const res = await get('/api/files/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [ok.id, 999999] }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, false, '有失败项时 ok 应为 false');
  assert.equal(res.json.deleted, 1, '存在的那条应被删掉');
  assert.equal(res.json.failed.length, 1);
  assert.equal(res.json.failed[0].id, 999999);
  assert.ok(res.json.failed[0].error, '失败要给出原因');
  assert.equal(filesRepo.get(ok.id), null);
});

test('★批量删除：参数校验（空列表 / 非法值 / 超上限）都必须被挡住', async () => {
  const empty = await get('/api/files/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [] }),
  });
  assert.equal(empty.status, 400, '空列表应 400');

  const invalid = await get('/api/files/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ['abc', -1, 0, null] }),
  });
  assert.equal(invalid.status, 400, '全是非法值时应 400（而不是静默删 0 个）');

  // 去重 + 忽略非法项：['1','1',-5] → 只处理 1 个
  const dedup = await get('/api/files/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ['999998', '999998', -5, 'x'] }),
  });
  assert.equal(dedup.status, 200);
  assert.equal(dedup.json.requested, 1, '同一个 id 重复出现只算一次');

  const tooMany = await get('/api/files/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: Array.from({ length: 501 }, (_, i) => i + 1) }),
  });
  assert.equal(tooMany.status, 400, '超过上限应 400');
  assert.match(tooMany.json?.error?.message ?? tooMany.text, /最多/, '应说明上限');
});

test('★批量删除：拒绝删除消费者目录之外的文件（安全护栏不能只靠前端）', async () => {
  const outside = path.join(root, 'not-consumer', 'sneaky');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, 'should-not-be-deleted');
  const id = filesRepo.add({
    taskId: null,
    name: 'sneaky',
    title: '越界文件',
    module: 'webvideo',
    sizeBytes: 20,
    path: outside,
  });

  const res = await get('/api/files/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [id], withFile: true }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.deleted, 0, '越界文件不应被删除');
  assert.equal(res.json.failed.length, 1);
  assert.match(res.json.failed[0].error, /消费者目录/, '要给出真实原因');
  assert.ok(fs.existsSync(outside), '磁盘文件必须原封不动');
  assert.ok(filesRepo.get(id), '记录也应保留（避免"记录没了文件还在"的半截状态）');
});

/* ------------------------------------------------------------------ */
/* 「已入队种子」批量删除（列表页 全选 → 全部删除）                       */
/* ------------------------------------------------------------------ */

test('★已入队种子批量删除：一次删多条记录，逐条回报结果（不存在的 id 不影响其它）', async () => {
  const { seedsRepo } = await import('../dist/core/db.js');
  const { config } = await import('../dist/core/config.js');
  fs.mkdirSync(config.dirs.btPending, { recursive: true });
  fs.mkdirSync(config.dirs.btQueued, { recursive: true });

  // ① 还在「待入队」目录的种子：删除时应连 .torrent 一起删（既有行为）
  const pendingPath = path.join(config.dirs.btPending, 'queue-bulk-pending.torrent');
  fs.writeFileSync(pendingPath, 'd4:infod4:name4:testee');
  const pendingSeed = seedsRepo.upsertByPath({ name: 'queue-bulk-pending.torrent', path: pendingPath });

  // ② 已经入队、.torrent 归档到 btQueued 的种子（入队时 moveSeedToQueued 会更新 seed.path）
  const queuedPaths = ['queue-bulk-a.torrent', 'queue-bulk-b.torrent'].map((n) => {
    const p = path.join(config.dirs.btQueued, n);
    fs.writeFileSync(p, 'd4:infod4:name4:testee');
    const s = seedsRepo.upsertByPath({ name: n, path: p });
    seedsRepo.update(s.id, { status: 'queued', path: p });
    return { seed: seedsRepo.get(s.id) ?? s, path: p };
  });

  const ids = [pendingSeed.id, ...queuedPaths.map((x) => x.seed.id), 999999];

  const res = await get('/api/bt/seeds/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, action: 'delete' }),
  });
  assert.equal(res.status, 200);

  // 每条都有结果；不存在的那个明确失败，但**不影响**其它条目
  const results = res.json.results;
  assert.equal(results.length, ids.length, '每个 id 都应有一条结果');
  assert.equal(results.filter((r) => r.ok).length, 3, '三条真实记录都应删除成功');
  const missing = results.find((r) => r.id === 999999);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /不存在/);

  // 记录都没了
  for (const id of ids.slice(0, 3)) {
    assert.equal(seedsRepo.get(id), null, `种子 #${id} 的记录应被删除`);
  }
  // 待入队目录里的 .torrent 被删（既有行为）
  assert.equal(fs.existsSync(pendingPath), false, '仍在待入队目录的 .torrent 应被删除');
  // 已入队留档的 .torrent **不会**被删（当前行为：只删记录）—— 这一条锁住现状，
  // 将来若改成"连留档一起删"，这个断言会红，提醒同步更新页面文案与这里。
  for (const x of queuedPaths) {
    assert.equal(fs.existsSync(x.path), true, '留档目录的 .torrent 当前不会被删除（只删记录）');
  }
});

test('已入队种子批量删除：空 ids 必须被挡住（不能让"全选"空选时误清空）', async () => {
  const res = await get('/api/bt/seeds/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [], action: 'delete' }),
  });
  assert.equal(res.status, 400);
});

/* ------------------------------------------------------------------ */
/* 「下载原始文件」：6 位轮换密码 + 临时解密 + 下载完立刻删临时文件        */
/* ------------------------------------------------------------------ */

/** POST 便捷方法 */
const post = (p, body, init = {}) =>
  get(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    ...init,
  });

/** 造一个真实的加密归档文件（用项目自己的加密代码，保证格式一致），返回 { id, path, content } */
async function makeEncryptedArchive(name, originalName, contentBytes = 4096) {
  const { markVlt, encryptFile } = await import('../dist/services/crypto.js');
  const { config } = await import('../dist/core/config.js');
  const content = Buffer.alloc(contentBytes, 7);
  const plain = path.join(root, `plain-${name}`);
  fs.writeFileSync(plain, content);
  markVlt(plain, originalName);
  const enc = plain + '.data';
  await encryptFile(plain, enc, config.encryptPassword);
  fs.rmSync(plain);
  const finalPath = path.join(config.dirs.consumer, name);
  fs.mkdirSync(config.dirs.consumer, { recursive: true });
  fs.renameSync(enc, finalPath);
  const id = filesRepo.add({
    taskId: null,
    name,
    title: `标题-${name}`,
    module: 'webvideo',
    sizeBytes: fs.statSync(finalPath).size,
    path: finalPath,
  });
  return { id, path: finalPath, content };
}

test('★下载原始文件：没输密码时不许解（401），密码对了才放行', async () => {
  const { currentCode } = await import('../dist/services/originalCode.js');
  const a = await makeEncryptedArchive('origlock1', '锁定测试.mp4');

  const denied = await post('/api/original/jobs', { fileId: a.id });
  // ⚠️ 必须是 403 而不是 401：前端把"非登录接口的 401"当成会话过期会跳回登录页
  assert.equal(denied.status, 403, '没解锁时不许开始解密（403）');
  assert.equal(denied.json.error.code, 'ORIGINAL_LOCKED');

  const wrong = await post('/api/original/unlock', { code: '000000' });
  assert.equal(wrong.status, 403, '错误密码必须被拒（403，别用 401 免得被当成会话过期）');
  assert.match(wrong.json.error.message, /不正确/, '要给出"密码不正确"的中文原因');

  const right = await post('/api/original/unlock', { code: currentCode() });
  assert.equal(right.status, 200, `当前密码应被接受（${currentCode()}）`);
  assert.ok(right.json.unlockSecondsLeft > 0);

  // 解锁后 15 分钟内不再问：状态接口应显示 unlocked
  const st = await get('/api/original/status');
  assert.equal(st.json.enabled, true);
  assert.equal(st.json.unlocked, true);
  assert.equal(st.json.unlockTtlSec, 900, '免问时长应为 15 分钟');
  assert.equal(st.json.codeWindowSec, 900, '密码每 15 分钟换一次');
});

test('★下载原始文件：解密出来就是原文件（字节一致），文件名按 RFC5987 百分号转义，下完立刻删临时文件', async () => {
  const { config } = await import('../dist/core/config.js');
  const { currentCode } = await import('../dist/services/originalCode.js');
  const { getJob, tempDir } = await import('../dist/services/originalDownload.js');

  // 文件名故意放空格、#、%、中文、以及 RFC5987 的保留字符 ' ( ) *
  const originalName = "我的 视频 #1 100% 'ok' (测试)*.mp4";
  const a = await makeEncryptedArchive('origdl1', originalName);

  await post('/api/original/unlock', { code: currentCode() });
  const started = await post('/api/original/jobs', { fileId: a.id });
  assert.equal(started.status, 200);
  const jobId = started.json.job.id;

  // 轮询到 ready（解密 4KB 很快，但给足时间）
  let job = null;
  for (let i = 0; i < 60; i += 1) {
    const r = await get(`/api/original/jobs/${jobId}`);
    if (r.status !== 200) break;
    job = r.json.job;
    if (job.state === 'ready' || job.state === 'failed') break;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  assert.ok(job, '应能查到任务');
  assert.equal(job.state, 'ready', `解密应成功，实际：${JSON.stringify(job)}`);
  assert.equal(job.originalName, originalName, '原始文件名必须从 FKY996 标记里原样读回');
  assert.equal(job.contentBytes, a.content.length, '还原出来的内容长度应与原始一致');

  // 临时文件在下载前确实存在
  const t = tempDir();
  const tempBefore = fs.readdirSync(t).length;
  assert.ok(tempBefore >= 1, '应有临时文件');

  // 下载
  const res = await fetch(`${base}/api/original/jobs/${jobId}/download`);
  assert.equal(res.status, 200);
  const got = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(got, a.content, '下载到的字节必须与原始文件完全一致');

  const cd = res.headers.get('content-disposition') ?? '';
  assert.match(cd, /filename\*=UTF-8''/, '必须给 filename*（RFC 5987）');
  // 空格 → %20；中文 → UTF-8 百分号编码；' ( ) * 必须被转义
  assert.ok(cd.includes('%20'), '空格必须转义成 %20');
  assert.ok(cd.includes('%E6%88%91'), '中文应做 UTF-8 百分号编码');
  assert.ok(cd.includes('%27') && cd.includes('%28') && cd.includes('%29') && cd.includes('%2A'), "' ( ) * 必须额外转义（RFC5987 的 attr-char 不含它们）");
  assert.ok(!/filename="[^"]*[\u4e00-\u9fa5]/.test(cd), 'filename= 兜底里不能塞非 ASCII');

  // 响应写完 → 立刻删临时文件
  await new Promise((r2) => setTimeout(r2, 300));
  assert.equal(fs.existsSync(path.join(t, `${jobId}.part`)), false, '下载完成后临时文件必须被删除');
  const after = await get(`/api/original/jobs/${jobId}`);
  assert.equal(after.status, 404, '任务记录也应被清掉');
});

test('★下载原始文件：临时文件有两条兜底清理（1 小时超时 + 开机清空）', async () => {
  const { sweepOnce, tempDir, getJob, TEMP_MAX_AGE_MS } = await import('../dist/services/originalDownload.js');
  const { currentCode } = await import('../dist/services/originalCode.js');
  const a = await makeEncryptedArchive('origdl2', '超时清理.mp4');

  await post('/api/original/unlock', { code: currentCode() });
  const started = await post('/api/original/jobs', { fileId: a.id });
  const jobId = started.json.job.id;

  let job = null;
  for (let i = 0; i < 60; i += 1) {
    job = getJob(jobId);
    if (!job || job.state === 'ready' || job.state === 'failed') break;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  assert.equal(getJob(jobId)?.state, 'ready', '先要解出来');
  const t = tempDir();
  assert.ok(fs.existsSync(path.join(t, `${jobId}.part`)), '临时文件应在');

  // 模拟"没能确认下载完成、已经放了 1 小时以上" → 清理线程必须删掉它
  const live = getJob(jobId);
  live.readyAt = Date.now() - TEMP_MAX_AGE_MS - 1000;
  sweepOnce();
  assert.equal(fs.existsSync(path.join(t, `${jobId}.part`)), false, '超过 1 小时的临时文件必须被清理');
  assert.equal(getJob(jobId), undefined, '任务记录也要清掉');

  // 开机清空：往临时目录里丢文件，purgeTempOnBoot 应清干净
  const stray = path.join(t, 'stray-from-power-loss.part');
  fs.writeFileSync(stray, 'leftover');
  const { purgeTempOnBoot } = await import('../dist/services/originalDownload.js');
  const r = purgeTempOnBoot();
  assert.ok(r.removed >= 1, '开机应清掉遗留文件');
  assert.equal(fs.existsSync(stray), false, '断电遗留的临时文件必须被清掉');
});

test('★下载原始文件：6 位密码的窗口语义（当前窗口有效、上个窗口容忍、更早的作废）', async () => {
  const { CODE_WINDOW_MS, codeForWindow, currentCode, secondsLeftInWindow, verifyCode, windowIndexOf } = await import(
    '../dist/services/originalCode.js'
  );
  const secret = process.env.ORIGINAL_DL_SECRET;
  const now = Date.now();
  const w = windowIndexOf(now);

  assert.match(currentCode(now), /^\d{6}$/, '必须是 6 位数字（含前导零）');
  assert.equal(currentCode(now), codeForWindow(secret, w), '当前密码应等于本窗口的推导值');
  assert.ok(secondsLeftInWindow(now) > 0 && secondsLeftInWindow(now) <= CODE_WINDOW_MS / 1000);

  // 换窗口必须换号（同一个窗口内必须稳定）
  assert.equal(currentCode(now + 1000), currentCode(now), '同一窗口内密码不变');
  assert.notEqual(currentCode(now + CODE_WINDOW_MS), currentCode(now), '跨窗口密码必须变');

  assert.equal(verifyCode(currentCode(now), now), true, '当前窗口应通过');
  assert.equal(verifyCode(codeForWindow(secret, w - 1), now), true, '上一个窗口应容忍（用户看到后切过来可能已跨窗口）');
  assert.equal(verifyCode(codeForWindow(secret, w - 2), now), false, '更早的窗口必须作废');
  assert.equal(verifyCode('12345', now), false, '不是 6 位必须拒');
  assert.equal(verifyCode('abcdef', now), false, '非数字必须拒');
});

test('★下载原始文件：同一个文件重复点不再重复解密（复用已有任务）', async () => {
  const { currentCode } = await import('../dist/services/originalCode.js');
  const a = await makeEncryptedArchive('origdl3', '复用任务.mp4', 200000);
  await post('/api/original/unlock', { code: currentCode() });
  const first = await post('/api/original/jobs', { fileId: a.id });
  const second = await post('/api/original/jobs', { fileId: a.id });
  assert.equal(second.json.job.id, first.json.job.id, '同一个文件应复用同一个任务，不重复解密');
  // 收尾：取消掉，别影响后面的用例
  await get(`/api/original/jobs/${first.json.job.id}`, { method: 'DELETE' });
});
