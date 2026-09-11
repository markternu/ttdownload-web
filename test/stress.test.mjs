/**
 * 压力测试：20 个任务同时入队，验证并发限制 / 队列 / 状态 / 进度
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime, startAria2Mock } from './helpers.mjs';

const mock = await startAria2Mock({ workDir: '/tmp' });
const root = setupRuntime({
  maxConcurrent: 3,
  reserveFreeBytes: 1024,
  env: { ARIA2_RPC_PORT: String(mock.port), MAX_CONCURRENT: '3' },
});

const { tasksRepo } = await import('../dist/core/db.js');
const { schedulerTick } = await import('../dist/core/scheduler.js');
const { updateSettings } = await import('../dist/services/settings.js');
const { pipelineTick } = await import('../dist/services/pipeline.js');
const { config } = await import('../dist/core/config.js');

test.after(async () => {
  await mock.close();
});

test('20 个任务入队：并发限制为 3，其余保持 waiting', async () => {
  // 全局并发 3；把 aria2 模块上限放宽，验证"全局并发"才是最终闸门
  updateSettings({ maxConcurrent: 3, moduleConcurrency: { transmission: 1, aria2: 10, webvideo: 2 } });
  const ids = [];
  for (let i = 0; i < 20; i += 1) {
    const t = tasksRepo.create({ module: 'aria2', title: `stress-${i}.bin`, platform: 'URL', url: `http://example.com/stress-${i}.bin` });
    ids.push(t.id);
  }
  // 跑几轮调度，让并发填满
  for (let i = 0; i < 3; i += 1) await schedulerTick();

  const running = tasksRepo.byStatus(['downloading', 'parsing']);
  const waiting = tasksRepo.byStatus(['waiting']);
  assert.equal(running.length, 3, `并发应限制为 3，实际 ${running.length}`);
  assert.equal(waiting.length, 17, `其余应等待，实际 ${waiting.length}`);
  assert.ok(running.every((t) => (t.payload ?? {}).gid), '运行中的任务都应有 gid');
});

test('全部完成后任务状态与文件都正确（20/20）', async () => {
  // 完成当前运行中的任务，并反复调度直到全部完成
  for (let round = 0; round < 40; round += 1) {
    const running = tasksRepo.byStatus(['downloading', 'parsing']);
    if (running.length === 0 && tasksRepo.byStatus(['waiting']).length === 0) break;
    for (const t of running) {
      const gid = String((t.payload ?? {}).gid ?? '');
      if (gid) mock.complete(gid);
    }
    await schedulerTick();
    await pipelineTick();
    await pipelineTick();
  }
  const completed = tasksRepo.list({ statuses: ['completed'], pageSize: 100 }).total;
  const failed = tasksRepo.list({ statuses: ['failed'], pageSize: 100 }).total;
  const leftovers = tasksRepo.byStatus(['waiting', 'downloading', 'parsing']).length;
  assert.equal(completed, 20, `应全部完成，实际 completed=${completed} failed=${failed} leftover=${leftovers}`);
  assert.equal(failed, 0);

  // 消费者目录文件数量与发布记录一致
  const filesOnDisk = fs.readdirSync(config.dirs.consumer).filter((f) => !f.startsWith('.'));
  const published = tasksRepo.list({ statuses: ['completed'], pageSize: 100 }).items.map((t) => t.publishedName);
  for (const name of published) {
    assert.ok(filesOnDisk.includes(name), `消费者目录应存在 ${name}`);
  }
});

test('压力下无临时文件残留（.tmp/.data 都被清理）', () => {
  const leftoverTmp = fs.readdirSync(config.dirs.archiveReady).filter((f) => f.startsWith('.tmp_') || f.endsWith('.data'));
  assert.deepEqual(leftoverTmp, [], `归档区不应残留临时文件: ${leftoverTmp.join(',')}`);
  const encTmp = fs.readdirSync(config.dirs.encryptTmp).filter((f) => f.endsWith('.data'));
  assert.deepEqual(encTmp, [], '加密临时区应已清空');
});
