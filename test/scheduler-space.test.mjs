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

test('下载中空间紧张 -> 自动暂停；空间释放 -> 自动恢复', async () => {
  const task = tasksRepo.list({ modules: ['aria2'], statuses: ['downloading'], pageSize: 1 }).items[0];
  // 模拟磁盘被其它任务/文件占满：把"保留空间"临时提高到超过总容量
  updateSettings({ reserveFreeBytes: Number.MAX_SAFE_INTEGER / 4 });
  await schedulerTick();
  const paused = tasksRepo.get(task.id);
  assert.equal(paused.status, 'paused', `空间压力应暂停，实际 ${paused.status}`);
  assert.equal(paused.payload.pausedBySpace, true);
  assert.match(String(paused.error), /磁盘空间不足/);

  // 空间释放后自动继续
  updateSettings({ reserveFreeBytes: 1024 });
  await schedulerTick();
  const resumed = tasksRepo.get(task.id);
  assert.equal(resumed.status, 'downloading', `空间恢复应继续，实际 ${resumed.status}`);
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
