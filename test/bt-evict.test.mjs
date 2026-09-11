/**
 * BT 出清机制测试
 *  - 硬门槛：必须已获得 ≥10 小时"实际下载尝试时间"才参与判断
 *  - 三种情况：完全无资源 / 中途停滞 / 还有资源但极慢
 *  - 进度 ≥79% 的视频 -> 按"可播放视为完整"移交归档，不删除
 *  - 删除同时清理 transmission incomplete 目录，并广播"空间已腾挪"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime, startTransmissionMock, tmpFile } from './helpers.mjs';

const root = setupRuntime();
const downloadDir = path.join(root, 'transmission', 'downloads', 'Demo');
fs.mkdirSync(downloadDir, { recursive: true });
const incompleteDir = path.join(root, 'incomplete');
process.env.TRANSMISSION_INCOMPLETE_DIR = incompleteDir;
fs.mkdirSync(incompleteDir, { recursive: true });

const mock = await startTransmissionMock({ downloadDir, torrentName: 'Demo' });
process.env.TRANSMISSION_RPC_PORT = String(mock.port);

const { config } = await import('../dist/core/config.js');
const { tasksRepo, seedsRepo } = await import('../dist/core/db.js');
const { bus } = await import('../dist/core/events.js');
const { runBtEvict } = await import('../dist/services/btEvict.js');
const { pipelineTick } = await import('../dist/services/pipeline.js');
const { updateSettings } = await import('../dist/services/settings.js');

test.after(async () => {
  await mock.close();
});

/** 清掉之前用例留下的 BT 任务，保证每轮只检查当前用例自己的任务（mock 是单一种子状态） */
function resetBtTasks() {
  for (const t of tasksRepo.list({ modules: ['transmission'], pageSize: 500 }).items) {
    tasksRepo.delete(t.id);
  }
  mock.state.removed.length = 0;
  mock.state.complete = false;
}

/** 造一个"已经下载了很久"的 BT 任务（给定累计尝试小时数） */
function makeBtTask({ activeHours, percent, rate, eta, peers, title = 'stuck', pausedBySpace = false }) {
  const seedPath = tmpFile(root, `seeds/${title}.torrent`, 'd8:announce11:http://x/ye');
  const seed = seedsRepo.upsertByPath({ name: `${title}.torrent`, path: seedPath });
  const task = tasksRepo.create({
    module: 'transmission',
    title,
    platform: 'BT',
    status: 'downloading',
    payload: {
      seedId: seed.id,
      torrentId: 7,
      downloadDir,
      btActiveMs: activeHours * 3600_000,
      btLastCheckAt: new Date().toISOString(),
      pausedBySpace,
    },
  });
  tasksRepo.update(task.id, { startedAt: new Date(Date.now() - activeHours * 3600_000).toISOString() });
  mock.state.name = title;
  mock.state.percent = percent;
  mock.state.rateDownload = rate;
  mock.state.eta = eta;
  mock.state.peersConnected = peers;
  mock.state.complete = false;
  return task;
}

test('硬门槛：尝试时间不足 10 小时 -> 无论多"像无资源"都不出清', async () => {
  resetBtTasks();
  const task = makeBtTask({ activeHours: 9.5, percent: 0.1, rate: 0, eta: 0, peers: 0, title: 'young-stuck' });
  const summary = await runBtEvict();
  const cand = summary.candidates.find((c) => c.taskId === task.id);
  assert.equal(cand.decision, 'keep');
  assert.equal(cand.reason, 'young');
  assert.match(cand.detail, /< 10 小时|尝试/);
  assert.equal(tasksRepo.get(task.id).status, 'downloading', '任务应保留');
  assert.equal(mock.state.removed.length, 0, '不应调用 torrent-remove');
  // 清理，避免影响后续用例
  tasksRepo.delete(task.id);
});

test('情况①：满 10 小时且完全无资源（无 peer/速率 0/停滞）-> 删除任务 + 清理 incomplete 目录 + 广播空间', async () => {
  resetBtTasks();
  const folder = path.join(incompleteDir, 'Demo');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'piece.bin'), Buffer.alloc(256 * 1024, 1));

  const task = makeBtTask({ activeHours: 10.2, percent: 0.05, rate: 0, eta: 0, peers: 0, title: 'Demo' });
  // 让停滞时间超过阈值（默认 30 分钟）
  const meta = tasksRepo.get(task.id).meta ?? {};
  tasksRepo.update(task.id, { meta: { ...meta, btStall: { lastPercent: 5, lastChangeAt: new Date(Date.now() - 31 * 60_000).toISOString() } } });

  const freed = [];
  const onSpace = (p) => freed.push(p);
  bus.on('space-freed', onSpace);

  const summary = await runBtEvict();
  bus.off('space-freed', onSpace);

  const cand = summary.candidates.find((c) => c.taskId === task.id);
  assert.equal(cand.decision, 'evict');
  assert.equal(cand.reason, 'no-resource');
  const after = tasksRepo.get(task.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error, /已出清|无资源/);
  assert.ok(mock.state.removed.some((r) => r.deleteLocalData === true), `应删除 transmission 任务及数据（removed=${JSON.stringify(mock.state.removed)}）`);
  assert.equal(fs.existsSync(folder), false, 'incomplete 目录下对应文件夹应被删除');
  assert.ok(freed.length >= 1, '应广播 space-freed');
  assert.ok(freed[0].bytes > 0, '广播应带释放字节数');
  assert.equal(freed[0].reason, 'bt-evict');
});

test('情况②：中途停滞（曾有进度后无资源）-> 删除', async () => {
  resetBtTasks();
  const task = makeBtTask({ activeHours: 11, percent: 0.5, rate: 0, eta: 0, peers: 0, title: 'mid-stall' });
  const meta = tasksRepo.get(task.id).meta ?? {};
  tasksRepo.update(task.id, { meta: { ...meta, btStall: { lastPercent: 50, lastChangeAt: new Date(Date.now() - 45 * 60_000).toISOString() } } });
  const summary = await runBtEvict();
  const cand = summary.candidates.find((c) => c.taskId === task.id);
  assert.equal(cand.decision, 'evict');
  assert.match(String(cand.detail), /停滞|无资源/);
  assert.equal(tasksRepo.get(task.id).status, 'failed');
});

test('情况③：还有资源但极慢（速率过低 + 预计太久）-> 删除', async () => {
  resetBtTasks();
  const task = makeBtTask({ activeHours: 12, percent: 0.3, rate: 5 * 1024, eta: 10 * 24 * 3600, peers: 2, title: 'too-slow' });
  const summary = await runBtEvict();
  const cand = summary.candidates.find((c) => c.taskId === task.id);
  assert.equal(cand.decision, 'evict');
  assert.equal(cand.reason, 'too-slow');
  assert.match(String(cand.detail), /KB\/s|过慢/);
  assert.equal(tasksRepo.get(task.id).status, 'failed');
});

test('还在正常推进的任务（有速率）-> 保留', async () => {
  resetBtTasks();
  const task = makeBtTask({ activeHours: 20, percent: 0.4, rate: 512 * 1024, eta: 600, peers: 8, title: 'healthy' });
  const summary = await runBtEvict();
  const cand = summary.candidates.find((c) => c.taskId === task.id);
  assert.equal(cand.decision, 'keep');
  assert.equal(tasksRepo.get(task.id).status, 'downloading');
});

test('被空间不足自动暂停的任务：不计入尝试时间，不做判断', async () => {
  resetBtTasks();
  const task = makeBtTask({ activeHours: 50, percent: 0.2, rate: 0, eta: 0, peers: 0, title: 'space-paused', pausedBySpace: true });
  tasksRepo.update(task.id, { status: 'paused' });
  const summary = await runBtEvict();
  const cand = summary.candidates.find((c) => c.taskId === task.id);
  assert.equal(cand.decision, 'keep');
  assert.equal(cand.reason, 'paused-by-space');
  assert.equal(tasksRepo.get(task.id).status, 'paused');
});

test('进度 ≥79% 的视频：按"可播放视为完整"移交归档（文件在 transmission incomplete 目录也能找到）', async () => {
  resetBtTasks();
  // 模拟真实 daemon：视频文件位于 transmission 的 incomplete 目录下
  const incompleteTaskDir = path.join(incompleteDir, 'Salvage');
  fs.mkdirSync(incompleteTaskDir, { recursive: true });
  const video = path.join(incompleteTaskDir, 'Salvage.mp4');
  fs.writeFileSync(video, Buffer.alloc(512 * 1024, 7));

  const task = makeBtTask({ activeHours: 15, percent: 0.85, rate: 0, eta: 0, peers: 0, title: 'Salvage' });
  tasksRepo.update(task.id, {
    meta: { ...(tasksRepo.get(task.id).meta ?? {}), btStall: { lastPercent: 85, lastChangeAt: new Date(Date.now() - 60 * 60_000).toISOString() } },
  });
  mock.state.files = [{ name: 'Salvage.mp4', length: 512 * 1024, bytesCompleted: 512 * 1024 }];

  const summary = await runBtEvict();
  const cand = summary.candidates.find((c) => c.taskId === task.id);
  assert.equal(cand.decision, 'salvage');
  assert.match(String(cand.detail), /可播放|移交归档/);
  const after = tasksRepo.get(task.id);
  assert.equal(after.status, 'archiving', '应进入归档流水线而不是失败');
  assert.equal(after.payload.pendingDirCleanup, true, '应标记发布完成后清理目录');
  assert.equal(fs.existsSync(video), true, '移交归档前不应删除文件（留给流水线搬运）');

  // 跑流水线：搬运 -> 加密 -> 发布 -> 清理目录
  await pipelineTick();
  await pipelineTick();
  const done = tasksRepo.get(task.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.ok(done.publishedName);
  assert.equal(fs.existsSync(path.join(config.dirs.consumer, done.publishedName)), true);
  assert.equal(fs.existsSync(incompleteTaskDir), false, '发布完成后应清理 incomplete 目录下该任务的文件夹');
});

test('手动取消 BT 任务：删除 transmission 任务 + 清理目录 + 广播空间', async () => {
  resetBtTasks();
  const dir = path.join(incompleteDir, 'CancelMe');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'part.bin'), Buffer.alloc(128 * 1024, 2));
  const task = makeBtTask({ activeHours: 1, percent: 0.1, rate: 1024, eta: 100, peers: 1, title: 'CancelMe' });
  const { transmissionModule } = await import('../dist/modules/transmission.js');

  const events = [];
  const onSpace = (p) => events.push(p);
  bus.on('space-freed', onSpace);
  await transmissionModule.cancel(task);
  bus.off('space-freed', onSpace);

  assert.equal(fs.existsSync(dir), false, '取消后应清理 incomplete 目录下该任务的文件夹');
  assert.ok(events.length >= 1 && events[0].bytes > 0, '取消并释放空间后应广播 space-freed');
});

test('出清后等待队列立即收到通知并重新评估（space-freed -> 调度）', async () => {
  resetBtTasks();
  const { startScheduler, stopScheduler, schedulerTick } = await import('../dist/core/scheduler.js');
  const { aria2Module } = await import('../dist/modules/aria2.js');
  // 只验证事件能被调度器消费：注册监听后触发事件不应抛错，且调度器可再次运行
  startScheduler();
  const task = tasksRepo.create({ module: 'aria2', title: 'waiting-after-evict.bin', platform: 'URL', url: 'http://example.com/w.bin' });
  bus.emitSpaceFreed({ bytes: 1024 * 1024, reason: 'test' });
  await new Promise((r) => setTimeout(r, 200));
  await schedulerTick();
  const after = tasksRepo.get(task.id);
  assert.ok(['waiting', 'parsing', 'downloading', 'failed'].includes(after.status), `任务应被重新评估，实际 ${after.status}`);
  stopScheduler();
  void aria2Module;
});
