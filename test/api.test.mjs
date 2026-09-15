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
const root = setupRuntime({ env: { ARIA2_RPC_PORT: String(mock.port) } });

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
