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

test('默认隐藏：任务/成品/统计 里的文件名都是 ****', async () => {
  // 默认 false（不改设置）
  assert.equal(getSettings().showFileNames, false);

  const tasks = await json('/api/tasks?pageSize=50');
  const t = tasks.items.find((x) => x.id === task.id);
  assert.equal(t.title, '****', '任务名要隐藏');

  const files = await json('/api/files?pageSize=50');
  const f = files.items.find((x) => x.id === fileId);
  assert.equal(f.name, '****', '成品文件名要隐藏');
  assert.equal(f.title, '****', '成品标题要隐藏');

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
  assert.equal(f.name, 'abc123');
  assert.equal(f.title, secretTitle);
});

test('再关掉「眼睛」→ 立刻回到 ****（接口出口遮蔽）', async () => {
  await putSettings({ showFileNames: false });
  const files = await json('/api/files?pageSize=50');
  assert.equal(files.items.find((x) => x.id === fileId).title, '****');
  const tasks = await json('/api/tasks?pageSize=50');
  assert.equal(tasks.items.find((x) => x.id === task.id).title, '****');
});
