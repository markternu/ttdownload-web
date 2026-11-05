/**
 * 文件名隐私开关（设置页「眼睛」）：
 *   · 默认隐藏：所有页面接口里的下载文件名字统一返回 ****；
 *   · 设置页打开 showFileNames 后返回真实名字；
 *   · 开关必须真正落盘（PUT /api/settings 白名单）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setupRuntime, tmpFile } from './helpers.mjs';

const root = setupRuntime();
const { createApp } = await import('../dist/app.js');
const { tasksRepo, filesRepo } = await import('../dist/core/db.js');
const { getSettings } = await import('../dist/services/settings.js');

// 造数据：一个任务 + 一个成品文件
const secretTitle = '秘密视频-不可见.mp4';
const task = tasksRepo.create({ module: 'aria2', title: secretTitle, platform: 'URL', url: null });
const realPath = tmpFile(root, 'consumer/abc123', 'x');
const fileId = filesRepo.add({ taskId: task.id, name: 'abc123', title: secretTitle, module: 'aria2', sizeBytes: 1, path: realPath });

const server = http.createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function putSettings(patch) {
  const res = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  assert.equal(res.status, 200, `保存设置失败 ${res.status}`);
  return res.json();
}
const json = async (p) => (await fetch(`${base}${p}`)).json();

test.after(async () => {
  await new Promise((r) => server.close(r));
});

test('默认隐藏：任务是 ****；成品只隐藏原始名，加密归档名始终可见', async () => {
  // 默认 false（不改设置）
  assert.equal(getSettings().showFileNames, false);

  const tasks = await json('/api/tasks?pageSize=50');
  const t = tasks.items.find((x) => x.id === task.id);
  assert.equal(t.title, '****', '任务名要隐藏');

  const files = await json('/api/files?pageSize=50');
  const f = files.items.find((x) => x.id === fileId);
  assert.equal(f.name, 'abc123', '加密归档名（随机前缀）一直可见，不能隐藏');
  assert.equal(f.title, '****', '只有原始下载名要隐藏');

  const stats = await json('/api/stats');
  const rt = (stats.recentTasks ?? []).find((x) => x.id === task.id);
  if (rt) assert.equal(rt.title, '****', '仪表盘最近任务也要隐藏');
});

test('设置页打开「眼睛」后返回真实名字（且开关真的落盘）', async () => {
  await putSettings({ showFileNames: true });
  assert.equal(getSettings().showFileNames, true, '白名单必须包含 showFileNames，否则永远存不进去');

  const tasks = await json('/api/tasks?pageSize=50');
  assert.equal(tasks.items.find((x) => x.id === task.id).title, secretTitle);

  const files = await json('/api/files?pageSize=50');
  const f = files.items.find((x) => x.id === fileId);
  assert.equal(f.name, 'abc123', '加密归档名永远可见');
  assert.equal(f.title, secretTitle, '打开眼睛后原始名也可见');
});

test('再关掉「眼睛」→ 立刻回到 ****（接口出口遮蔽）', async () => {
  await putSettings({ showFileNames: false });
  const files = await json('/api/files?pageSize=50');
  assert.equal(files.items.find((x) => x.id === fileId).title, '****');
  const tasks = await json('/api/tasks?pageSize=50');
  assert.equal(tasks.items.find((x) => x.id === task.id).title, '****');
});

test('SSE 事件也不能漏真名（任务页"一闪一闪"的根因）', async () => {
  const { bus } = await import('../dist/core/events.js');
  const res = await fetch(`${base}/api/events`);
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const readUntil = async (needle, timeoutMs = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes(needle)) return true;
    }
    return false;
  };
  try {
    // 先等连接建立
    assert.equal(await readUntil('retry:'), true, 'SSE 应建立');
    // 推一条"真名"任务事件
    bus.emitTask({ id: 9999, module: 'aria2', title: '真名泄漏.mp4', status: 'downloading' });
    assert.equal(await readUntil('event: task'), true, '应收到 task 事件');
    assert.match(buf, /"title":"\*\*\*\*"/, 'SSE 任务事件里的名字必须被遮蔽成 ****');
    assert.doesNotMatch(buf, /真名泄漏/, '绝不能把真名通过 SSE 推给浏览器');
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
});

test('SSE stats 里的 recentTasks 名字也要遮蔽', async () => {
  const { bus } = await import('../dist/core/events.js');
  const res = await fetch(`${base}/api/events`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const readUntil = async (needle, timeoutMs = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes(needle)) return true;
    }
    return false;
  };
  try {
    await readUntil('retry:');
    bus.emitStats({ recentTasks: [{ id: 1, title: '统计里的真名.mp4' }], totalTasks: 1 });
    assert.equal(await readUntil('event: stats'), true, '应收到 stats 事件');
    assert.match(buf, /"title":"\*\*\*\*"/, 'stats 里的任务名也要遮蔽');
    assert.doesNotMatch(buf, /统计里的真名/, 'stats 不能泄漏真名');
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
});


test('「下载原始文件」面板里的原始名也遮蔽（真正下载的文件名仍用真名，由服务端 Content-Disposition 设置）', async () => {
  const { updateSettings } = await import('../dist/services/settings.js');
  const { publicJob } = await import('../dist/services/originalDownload.js');
  const job = {
    id: 'j1',
    fileId: 1,
    srcPath: '',
    originalName: '真名视频.mp4',
    tempPath: '',
    contentBytes: 1,
    expectedBytes: 1,
    state: 'ready',
    progress: 100,
    error: null,
    createdAt: Date.now(),
    readyAt: Date.now(),
    streaming: 0,
    finished: false,
    startedBy: 'k',
  };
  updateSettings({ showFileNames: false });
  assert.equal(publicJob(job).originalName, '****', '面板里的原始名要隐藏');
  updateSettings({ showFileNames: true });
  assert.equal(publicJob(job).originalName, '真名视频.mp4', '打开眼睛后可见');
});
