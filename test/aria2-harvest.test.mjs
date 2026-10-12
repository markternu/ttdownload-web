/**
 * aria2 孤儿收割：把"下完没归档"的文件重新送进「文件」。
 * 真机：downd_aria2_path 里有下好的 mp4 却没出现在「文件」，任务清空了还占 30G。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime, startAria2Mock } from './helpers.mjs';

const root = setupRuntime();
const aria2Dir = path.join(root, 'downd_aria2_path');
fs.mkdirSync(aria2Dir, { recursive: true });
const mock = await startAria2Mock({ workDir: aria2Dir });
process.env.ARIA2_RPC_PORT = String(mock.port);

const { config } = await import('../dist/core/config.js');
const { tasksRepo } = await import('../dist/core/db.js');
const { harvestOrphanAria2 } = await import('../dist/services/aria2Harvest.js');
const { pipelineTick } = await import('../dist/services/pipeline.js');

const old = (ms) => new Date(Date.now() - ms);
const mk = (dir, name, content = 'x') => {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
};
const isArchiving = (p) => tasksRepo.byStatus(['archiving', 'encrypting']).some((t) => {
  const dp = t.payload?.downloadedPaths;
  return Array.isArray(dp) && dp.some((f) => path.resolve(f) === path.resolve(p));
});

test.after(async () => {
  await mock.close();
});

test('下完没归档的文件（无 .aria2、不在实时任务里）会被送进归档流水线', async () => {
  const orphan = mk(config.dirs.aria2, 'forgotten.mp4', 'complete-mp4-data');
  fs.utimesSync(orphan, old(10 * 60_000), old(10 * 60_000));

  const r = await harvestOrphanAria2();
  assert.equal(r.archived, 1, `应把孤儿文件送进归档（实际 ${JSON.stringify(r)}）`);
  assert.ok(isArchiving(orphan), '要建一个归档任务并指向这个文件');
});

test('不误收：有 .aria2 控制文件（还在下）的、以及实时任务里的文件，都不送归档', async () => {
  // 还在下的：带 .aria2 控制文件
  const inProgress = mk(config.dirs.aria2, 'downloading.mp4', 'partial');
  mk(config.dirs.aria2, 'downloading.mp4.aria2', 'ctl');
  fs.utimesSync(inProgress, old(30 * 60_000), old(30 * 60_000));

  // 实时任务里的（aria2 RPC 里能查到，且文件真的在下载区里）
  const liveTask = tasksRepo.create({ module: 'aria2', title: 'live.bin', platform: 'URL', url: 'https://x/live.bin' });
  const { aria2Module } = await import('../dist/modules/aria2.js');
  await aria2Module.start(liveTask);
  const gid = String(tasksRepo.get(liveTask.id).payload.gid);
  const liveFile = mock.state.tasks.get(gid).file;
  fs.writeFileSync(liveFile, 'still-downloading');
  fs.utimesSync(liveFile, old(30 * 60_000), old(30 * 60_000));

  const r = await harvestOrphanAria2();
  assert.equal(r.archived, 0, '本次不该再收任何东西');
  assert.equal(isArchiving(inProgress), false, '还在下（有 .aria2）的不能送归档');
  assert.equal(isArchiving(liveFile), false, '实时任务里的文件不能送归档');
});

test('刚下完（<5 分钟）的文件先不动，让 poll 自己去处理', async () => {
  const fresh = mk(config.dirs.aria2, 'just-done.mp4', 'fresh');
  const r = await harvestOrphanAria2();
  assert.equal(r.archived, 0);
  assert.equal(isArchiving(fresh), false);
});

test('aria2 RPC 不可用时整体跳过（不敢乱动下载区）', async () => {
  mock.state.rpcDown = true;
  try {
    const r = await harvestOrphanAria2();
    assert.equal(r.archived, 0);
    assert.ok(r.errors.length >= 1 && /RPC 不可用/.test(r.errors[0]), '要明确说"RPC 不可用"');
  } finally {
    mock.state.rpcDown = false;
  }
});

test('收割之后走完整流水线，成品最终出现在消费者目录（=「文件」）', async () => {
  const file = mk(config.dirs.aria2, 'finale.mp4', 'final-video-bytes');
  fs.utimesSync(file, old(10 * 60_000), old(10 * 60_000));
  await harvestOrphanAria2();
  const { filesRepo } = await import('../dist/core/db.js');
  const before = filesRepo.list({ pageSize: 1 }).total;
  for (let i = 0; i < 15; i += 1) {
    await pipelineTick();
    if (filesRepo.list({ pageSize: 1 }).total > before) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  // 归档后成品会被随机前缀命名（发布成品的正常行为），所以断言"多了一条成品记录"
  const after = filesRepo.list({ pageSize: 1 }).total;
  assert.ok(after > before, '孤儿文件归档后应生成一条成品记录（「文件」页能看到了）');
  const got = filesRepo.list({ pageSize: 10 }).rows.find((r) => r.title === 'finale.mp4');
  assert.ok(got, '成品记录的标题应是原文件名 finale.mp4');
});
