/**
 * 统一等待队列 + 10G 磁盘空间门控 测试
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime, startAria2Mock, tmpFile } from './helpers.mjs';

// 预留空间设置为超大 -> 任何任务都进不来
const mock = await startAria2Mock({ workDir: '/tmp' });
const root = setupRuntime({ reserveFreeBytes: Number.MAX_SAFE_INTEGER / 4, env: { ARIA2_RPC_PORT: String(mock.port) } });

const { tasksRepo } = await import('../dist/core/db.js');
const { schedulerTick } = await import('../dist/core/scheduler.js');
const { updateSettings } = await import('../dist/services/settings.js');

test.after(async () => {
  await mock.close();
});

test('空间不足时任务停留在 waiting（统一队列门控）', async () => {
  const task = tasksRepo.create({ module: 'aria2', title: 'space.bin', platform: 'URL', url: 'http://example.com/space.bin' });
  await schedulerTick();
  const after = tasksRepo.get(task.id);
  assert.equal(after.status, 'waiting', `空间不足应等待，实际 ${after.status}`);
});

test('空间恢复后自动开始下载', async () => {
  updateSettings({ reserveFreeBytes: 1024 });
  await schedulerTick();
  const task = tasksRepo.list({ modules: ['aria2'], statuses: ['downloading', 'parsing', 'waiting'], pageSize: 10 }).items[0];
  assert.equal(task.status, 'downloading', `空间足够应开始下载，实际 ${task.status}`);
});

test('空间紧张只暂停"多余的"任务，留一个继续跑（防死锁）', async () => {
  // 清掉前面测试留下的任务，保证只有本测试这两个在跑
  for (const t of tasksRepo.list({ pageSize: 500 }).items) tasksRepo.delete(t.id);
  updateSettings({ reserveFreeBytes: 1024 });
  // 先让两个任务正常开跑（走真实的 aria2 mock 拿到 gid），再制造空间压力
  const a = tasksRepo.create({ module: 'aria2', title: 'keep.bin', platform: 'URL', url: 'http://example.com/keep.bin' });
  const b = tasksRepo.create({ module: 'aria2', title: 'pause.bin', platform: 'URL', url: 'http://example.com/pause.bin' });
  await schedulerTick();
  const started = tasksRepo.byStatus(['downloading']);
  assert.equal(started.length, 2, `两个任务都该正常开跑，实际 ${started.length}`);

  // 制造空间压力：把"保留空间"临时提高到超过总容量
  updateSettings({ reserveFreeBytes: Number.MAX_SAFE_INTEGER / 4 });
  await schedulerTick();

  const running = tasksRepo.byStatus(['downloading']);
  const paused = tasksRepo.byStatus(['paused']).filter((t) => t.payload?.pausedBySpace);
  assert.equal(running.length, 1, `必须留 1 个继续跑，否则没人能下完、空间永远回不来（实际在跑 ${running.length}）`);
  assert.equal(paused.length, 1, `多余的 1 个应被暂停（实际暂停 ${paused.length}）`);
  assert.equal(Number(paused[0].id), Number(b.id), '先暂停最后加入的那个（新的先让位）');
  assert.match(String(paused[0].error), /磁盘空间不足/);

  // 空间释放后自动继续
  updateSettings({ reserveFreeBytes: 1024 });
  await schedulerTick();
  assert.equal(tasksRepo.get(b.id).status, 'downloading', '空间恢复后被暂停的任务应自动继续');
  assert.equal(tasksRepo.get(a.id).status, 'downloading', '原本在跑的那个不该被影响');
});

test('服务重启恢复：非 aria2 的中间态任务回到等待队列', async () => {
  const { recoverTasks } = await import('../dist/core/scheduler.js');
  const t = tasksRepo.create({ module: 'webvideo', title: 'stuck', platform: 'YouTube', url: 'https://youtu.be/x' });
  tasksRepo.update(t.id, { status: 'downloading' });
  await recoverTasks();
  const after = tasksRepo.get(t.id);
  assert.equal(after.status, 'waiting');
  assert.match(String(after.error), /重新排队/);
});
