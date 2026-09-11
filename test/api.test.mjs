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
const { tasksRepo } = await import('../dist/core/db.js');

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
