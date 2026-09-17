/**
 * 任务计数的口径回归（用户报的：侧边栏一个数、任务页另一个数，且跟种子数对不上）
 *
 * 真相：BT 的「扫货 → 归档 → 加密 → 发布」会为每个下好的目录**再建一个任务**
 * （module 同样是 transmission，payload.harvest 标记）。于是 14 个种子在任务页显示成 23 条，
 * 用户以为计数坏了。列表与统计必须能把这两类分开、并且用**同一套筛选条件**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupRuntime } from './helpers.mjs';

const root = setupRuntime();
const { tasksRepo } = await import('../dist/core/db.js');
const { createPublishTask } = await import('../dist/services/pipeline.js');

test('summary 能把"种子下载任务"和"归档发布子任务"分开，且与 total 同源', () => {
  for (const t of tasksRepo.list({ pageSize: 500 }).items) tasksRepo.delete(t.id);

  // 14 个种子下载任务（模拟用户那台机器）
  for (let i = 1; i <= 14; i += 1) {
    tasksRepo.create({ module: 'transmission', title: `seed-${i}`, platform: 'BT', status: i <= 4 ? 'downloading' : 'completed', expectBytes: 1024, payload: { torrentId: i }, meta: { files: [] } });
  }
  // 9 个扫货产生的发布子任务（都已完成）
  for (let i = 1; i <= 9; i += 1) {
    const id = createPublishTask({
      module: 'transmission',
      title: `publish-${i}`,
      platform: 'BT',
      files: [`/tmp/x/file${i}.mp4`],
      originalName: `file${i}.mp4`,
      sizeBytes: 1024,
      parentTaskId: i,
      harvest: { dir: `/tmp/x/dir${i}`, files: [`/tmp/x/file${i}.mp4`] },
    });
    tasksRepo.update(id, { status: 'completed' });
  }

  const { total } = tasksRepo.list({ pageSize: 500 });
  const summary = tasksRepo.summary({});
  assert.equal(total, 23, '数据库里一共 23 条');
  assert.equal(summary.download, 14, '其中 14 条是种子下载任务（= 用户的种子数）');
  assert.equal(summary.publish, 9, '另外 9 条是归档发布子任务');
  assert.equal(summary.download + summary.publish, total, '两类相加必须等于 total（口径自洽）');
  assert.equal(summary.byStatus.downloading, 4);
  assert.equal(summary.byStatus.completed, 19);

  // 按状态筛选时，统计也要跟着筛选走（否则头部数字又会和列表对不上）
  const only = tasksRepo.summary({ statuses: ['downloading'] });
  assert.equal(Object.values(only.byStatus).reduce((a, b) => a + b, 0), 4, '筛下载中就只有 4 条');
  assert.equal(only.download + only.publish, 4);
});

test('GET /api/tasks 返回 summary（页面头部就靠它解释 total）', async () => {
  const { createApp } = await import('../dist/app.js');
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks?pageSize=5`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.items));
    assert.equal(typeof body.total, 'number');
    assert.ok(body.summary, '响应里必须带 summary');
    assert.equal(body.summary.download + body.summary.publish, body.total, 'sum 必须能解释 total');
    assert.ok(body.items.length <= 5, '分页仍然是 5');
  } finally {
    server.close();
  }
});

test('computeStats 也不能把发布子任务混进"任务数/完成数/下载中"', async () => {
  const { computeStats } = await import('../dist/core/db.js');
  const s = computeStats();
  assert.equal(s.downloadTasks, 14, '下载任务数 = 种子数');
  assert.equal(s.publishTasks, 9, '发布子任务单独统计');
  assert.equal(s.downloadTasks + s.publishTasks, s.totalTasks, '两类相加 = 总行数（口径自洽）');
  // 归档/加密中的任务不能算进"下载中"
  const { tasksRepo: repo } = await import('../dist/core/db.js');
  const arch = repo.list({ pageSize: 500 }).items.find((x) => (x.payload ?? {}).harvest);
  repo.update(arch.id, { status: 'archiving' });
  const s2 = computeStats();
  assert.equal(s2.publishing, 1, '归档中的发布子任务算 publishing');
  assert.equal(s2.downloading, 4, '不能把归档中的算成"下载中"（以前这里会变成 5）');
  repo.update(arch.id, { status: 'completed' });
});
