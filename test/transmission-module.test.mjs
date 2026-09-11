/**
 * transmission（BT 种子）模块 测试：zip 解压入种子库、只挑视频/图片、完成归档
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupRuntime, startTransmissionMock, tmpFile } from './helpers.mjs';

const root = setupRuntime();
const downloadDir = path.join(root, 'transmission', 'downloads', 'Demo');
fs.mkdirSync(downloadDir, { recursive: true });
const mock = await startTransmissionMock({ downloadDir, torrentName: 'Demo' });
process.env.TRANSMISSION_RPC_PORT = String(mock.port);

const { config } = await import('../dist/core/config.js');
const { seedsRepo, tasksRepo } = await import('../dist/core/db.js');
const bt = await import('../dist/modules/transmission.js');
const { handoffToArchive, pipelineTick } = await import('../dist/services/pipeline.js');

test.after(async () => {
  await mock.close();
});

test('zip 上传 -> 解压 -> 种子入库（并删除 zip）', async () => {
  const fakeTorrent = tmpFile(root, 'src/demo.torrent', 'd8:announce11:http://x/ye');
  const zipDir = path.join(root, 'zipwork');
  fs.mkdirSync(zipDir, { recursive: true });
  execFileSync('zip', ['-j', '-q', path.join(config.dirs.btZip, 'upload1.zip'), fakeTorrent]);
  const extracted = await bt.scanZipUploads();
  assert.equal(extracted, 1);
  assert.equal(fs.existsSync(path.join(config.dirs.btZip, 'upload1.zip')), false, 'zip 应被删除');
  assert.equal(fs.existsSync(path.join(config.dirs.btPending, 'demo.torrent')), true, '种子应进入待下载目录');

  const added = bt.registerPendingSeeds();
  assert.equal(added, 1);
  const seeds = seedsRepo.all();
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].status, 'pending');
});

test('BT: 入队 -> 启动 -> 只选中视频/图片 -> 完成后归档发布', async () => {
  const seed = seedsRepo.all()[0];
  const task = bt.enqueueSeed(seed);
  assert.equal(task.module, 'transmission');
  assert.equal(seedsRepo.get(seed.id).status, 'queued');

  await bt.transmissionModule.start(tasksRepo.get(task.id));
  const started = tasksRepo.get(task.id);
  assert.equal(started.status, 'downloading');
  assert.equal(started.payload.torrentId, 7);
  // mock 种子含 video.mp4(1000) + cover.jpg(100) + readme.txt(50) -> 只算前两个
  assert.equal(started.expectBytes, 1100, '只统计视频+图片大小');
  assert.deepEqual(started.meta.files.sort(), ['cover.jpg', 'video.mp4'].sort());
  assert.equal(fs.existsSync(path.join(config.dirs.btQueued, 'demo.torrent')), true, '种子应移到已下载目录');

  // 未完成：进度 50%
  const p1 = await bt.transmissionModule.poll(tasksRepo.get(task.id));
  assert.equal(Math.round(p1.progress), 50);
  assert.equal(p1.done, undefined);

  // 生成真实文件并标记完成
  fs.writeFileSync(path.join(downloadDir, 'video.mp4'), Buffer.alloc(1000, 3));
  fs.writeFileSync(path.join(downloadDir, 'cover.jpg'), Buffer.alloc(100, 4));
  mock.state.complete = true;

  const p2 = await bt.transmissionModule.poll(tasksRepo.get(task.id));
  assert.ok(p2.done, '完成时应返回 done');
  assert.equal(p2.done.files.length, 2, '只归档视频+图片，readme.txt 被排除');

  handoffToArchive(task.id, p2.done.files, p2.done.originalName, p2.done.sizeBytes);
  await pipelineTick();
  await pipelineTick();
  const doneTask = tasksRepo.get(task.id);
  assert.equal(doneTask.status, 'completed', doneTask.error ?? '');
  assert.equal(fs.existsSync(path.join(config.dirs.consumer, doneTask.publishedName)), true);
  assert.equal(seedsRepo.get(seed.id).status, 'done');
});

test('BT: 种子内没有视频/图片时给出明确错误', async () => {
  mock.state.files = [{ name: 'readme.txt', length: 10, bytesCompleted: 0 }];
  const fakeTorrent = tmpFile(root, 'src/only_txt.torrent', 'd8:announce11:http://x/ye');
  fs.copyFileSync(fakeTorrent, path.join(config.dirs.btPending, 'only_txt.torrent'));
  bt.registerPendingSeeds();
  const seed = seedsRepo.all().find((s) => s.name === 'only_txt.torrent');
  const task = bt.enqueueSeed(seed);
  await assert.rejects(() => bt.transmissionModule.start(tasksRepo.get(task.id)), /没有视频或图片/);
});
