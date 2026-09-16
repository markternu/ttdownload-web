/**
 * transmission（BT）模块测试
 *
 * 核心约定（都是真机事故换来的）：
 *   · 加种子时**绝不覆盖 download-dir**（transmission 用自己的两个目录；我们以前改成
 *     /ttdownload/...(root 所有)，它下完搬不过去 → Permission denied，每个种子都失败）
 *   · 只勾选视频（大小写不敏感的扩展名），不做任何广告识别
 *   · prepare 阶段就把真实大小算出来给调度器排队用（否则"需要 0 字节"永远放行 → 撑爆磁盘）
 *   · 交给 transmission 后只读进度，不干涉；下完的货由"扫货"(btHarvest) 处理
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

test.after(async () => {
  await mock.close();
});

test('zip 上传 -> 解压 -> 种子入库（并删除 zip）', async () => {
  const fakeTorrent = tmpFile(root, 'src/demo.torrent', 'd8:announce11:http://x/ye');
  execFileSync('zip', ['-j', '-q', path.join(config.dirs.btZip, 'upload1.zip'), fakeTorrent]);
  const extracted = await bt.scanZipUploads();
  assert.equal(extracted, 1);
  assert.equal(fs.existsSync(path.join(config.dirs.btZip, 'upload1.zip')), false, 'zip 应被删除');
  assert.equal(fs.existsSync(path.join(config.dirs.btPending, 'demo.torrent')), true, '种子应进入待下载目录');
  bt.registerPendingSeeds();
  assert.equal(seedsRepo.all().length, 1);
});

test('prepare：只勾视频 + 算出真实大小 + **绝不覆盖 download-dir**', async () => {
  mock.state.torrentAdds.length = 0;
  mock.state.torrentSets.length = 0;
  mock.state.wanted = [1, 1, 1];
  // mock 种子：video.mp4(1000) + cover.jpg(100) + readme.txt(50)
  const seed = seedsRepo.all()[0];
  const task = bt.enqueueSeed(seed);
  await bt.transmissionModule.prepare(tasksRepo.get(task.id));
  const after = tasksRepo.get(task.id);

  // ① 绝不覆盖 download-dir（否则 transmission 以 debian-transmission 身份搬文件会 EACCES）
  const addArgs = mock.state.torrentAdds[0];
  assert.ok(addArgs, '应该调用过 torrent-add');
  assert.equal(addArgs['download-dir'], undefined, '不能给 torrent-add 传 download-dir！要用 transmission 自己的目录');
  assert.equal(addArgs.paused, true, '先以暂停状态加入（选好片、算好大小再开）');

  // ② 只勾视频
  assert.equal(after.expectBytes, 1000, 'expectBytes 必须是视频真实大小（调度器排队的依据）');
  assert.deepEqual(after.meta.files, ['video.mp4'], '只勾选视频');
  const unset = mock.state.torrentSets.find((a) => Array.isArray(a['files-unwanted']));
  assert.deepEqual(unset['files-unwanted'].sort(), [1, 2], '图片和 txt 都要标成不要');

  // ③ 记住唯一 ID（hash）和 transmission 的目录，供扫货用
  assert.equal(after.payload.btHash, 'abc', '要记录种子的唯一 hash');
  assert.equal(after.payload.btDownloadDir, downloadDir, '记录 transmission 报告的目录');
});

test('start：只做 torrent-start，并记录"什么时候交给 transmission 的"', async () => {
  const task = tasksRepo.list({ modules: ['transmission'], statuses: ['parsing', 'waiting'], pageSize: 1 }).items[0];
  await bt.transmissionModule.start(tasksRepo.get(task.id));
  const after = tasksRepo.get(task.id);
  assert.equal(after.status, 'downloading');
  assert.ok(after.payload.btHandedAt, '要记录交给 transmission 的时间（8 小时策略的起点）');
  assert.equal(mock.state.running, true, '种子应该被放行开下');
});

test('poll：只读进度，不返回 done（完成由扫货处理，8 小时内不干涉）', async () => {
  const task = tasksRepo.list({ modules: ['transmission'], statuses: ['downloading'], pageSize: 1 }).items[0];
  mock.state.complete = false;
  mock.state.percent = 0.5;
  const p = await bt.transmissionModule.poll(tasksRepo.get(task.id));
  assert.equal(Math.round(p.progress), 50);
  assert.equal(p.done, undefined, 'poll 不该自己交付（交给扫货）');
  assert.equal(p.error, undefined);
});

test('种子里一个视频都没有 -> 明确报错并跳过（只下视频）', async () => {
  mock.state.files = [{ name: 'readme.txt', length: 10, bytesCompleted: 0 }];
  mock.state.wanted = [1];
  const fakeTorrent = tmpFile(root, 'src/only_txt.torrent', 'd8:announce11:http://x/ye');
  fs.copyFileSync(fakeTorrent, path.join(config.dirs.btPending, 'only_txt.torrent'));
  bt.registerPendingSeeds();
  const seed = seedsRepo.all().find((s) => s.name === 'only_txt.torrent');
  const task = bt.enqueueSeed(seed);
  await assert.rejects(() => bt.transmissionModule.prepare(tasksRepo.get(task.id)), /没有视频文件/);
});

test('【事故回归】空间不够时：备好但一个字节都不下，且 expectBytes 已是真实值', async () => {
  const GB = 1024 ** 3;
  const { schedulerTick } = await import('../dist/core/scheduler.js');
  const { freeBytes } = await import('../dist/core/disk.js');
  const { updateSettings } = await import('../dist/services/settings.js');

  mock.state.complete = false;
  mock.state.percent = 0;
  mock.state.running = false;
  mock.state.files = [{ name: 'huge.mp4', length: 5 * GB, bytesCompleted: 0 }];
  mock.state.wanted = [1];
  for (const t of tasksRepo.list({ pageSize: 500 }).items) tasksRepo.delete(t.id);

  const fakeTorrent = tmpFile(root, 'src/huge.torrent', 'd8:announce11:http://x/ye');
  fs.copyFileSync(fakeTorrent, path.join(config.dirs.btPending, 'huge.torrent'));
  bt.registerPendingSeeds();
  const seed = seedsRepo.all().find((s) => s.name === 'huge.torrent');
  const task = bt.enqueueSeed(seed);

  updateSettings({ reserveFreeBytes: Math.max(0, freeBytes() - 3 * GB) });
  await schedulerTick();
  const after = tasksRepo.get(task.id);
  assert.equal(after.status, 'waiting', `空间不够就不该开下，实际 ${after.status}`);
  assert.match(String(after.error ?? ''), /磁盘空间不足/);
  assert.ok(Number(after.expectBytes) >= 5 * GB * 0.99, '准入时必须已知真实大小（≈5G）');
  assert.equal(mock.state.running, false, '种子必须保持暂停（一个字节都不能下）');

  updateSettings({ reserveFreeBytes: 1024 });
  await schedulerTick();
  assert.equal(tasksRepo.get(task.id).status, 'downloading', '空间够了应放行');
  assert.equal(mock.state.running, true);
});
