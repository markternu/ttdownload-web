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
const { schedulerTick } = await import('../dist/core/scheduler.js');
const { freeBytes } = await import('../dist/core/disk.js');
const { updateSettings } = await import('../dist/services/settings.js');

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

test('BT: 入队 -> 启动 -> 只要核心内容(视频) -> 完成后归档发布', async () => {
  const seed = seedsRepo.all()[0];
  const task = bt.enqueueSeed(seed);
  assert.equal(task.module, 'transmission');
  assert.equal(seedsRepo.get(seed.id).status, 'queued');

  await bt.transmissionModule.prepare(tasksRepo.get(task.id));
  await bt.transmissionModule.start(tasksRepo.get(task.id));
  const started = tasksRepo.get(task.id);
  assert.equal(started.status, 'downloading');
  assert.equal(started.payload.torrentId, 7);
  // mock 种子含 video.mp4(1000) + cover.jpg(100) + readme.txt(50)
  // 新规则：有视频时图片按"宣传图/封面"排除，非视频/图片扩展名一律不要 -> 只要 video.mp4
  assert.equal(started.expectBytes, 1000, '只统计核心内容(视频)大小');
  assert.deepEqual(started.meta.files, ['video.mp4']);
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
  assert.equal(p2.done.files.length, 1, '只归档核心内容：readme.txt(扩展名) 与 cover.jpg(有视频时的图片) 都被排除');
  assert.ok(p2.done.files[0].endsWith('video.mp4'), '留下的是视频: ' + p2.done.files[0]);
  assert.ok(Array.isArray(p2.done.units) && p2.done.units.length === 1, '单个文件 -> 一个成品');
  assert.equal(p2.done.cleanupBtDirs, true, 'BT 任务要标"发布完成后清理下载目录"');

  handoffToArchive(task.id, p2.done.files, p2.done.originalName, p2.done.sizeBytes, {
    units: p2.done.units,
    torrentName: p2.done.torrentName,
    cleanupBtDirs: p2.done.cleanupBtDirs,
  });
  await pipelineTick();
  await pipelineTick();
  const doneTask = tasksRepo.get(task.id);
  assert.equal(doneTask.status, 'completed', doneTask.error ?? '');
  assert.equal(fs.existsSync(path.join(config.dirs.consumer, doneTask.publishedName)), true);
  assert.equal(seedsRepo.get(seed.id).status, 'done');
});

test('BT: 种子内没有核心内容时给出明确错误（并说明排除了什么）', async () => {
  mock.state.files = [{ name: 'readme.txt', length: 10, bytesCompleted: 0 }];
  const fakeTorrent = tmpFile(root, 'src/only_txt.torrent', 'd8:announce11:http://x/ye');
  fs.copyFileSync(fakeTorrent, path.join(config.dirs.btPending, 'only_txt.torrent'));
  bt.registerPendingSeeds();
  const seed = seedsRepo.all().find((s) => s.name === 'only_txt.torrent');
  const task = bt.enqueueSeed(seed);
  await assert.rejects(() => bt.transmissionModule.prepare(tasksRepo.get(task.id)), /没有可下载的核心内容/);
});

test('BT 早交付：单个大文件一下完就单独建发布任务（并标 unwanted 防重下）', async () => {
  const BIG = 600 * 1024 ** 2; // ≥ 默认单独发布阈值 500MB
  const SMALL = 10 * 1024 ** 2;
  mock.state.complete = false;
  mock.state.percent = 0.4;
  mock.state.files = [
    { name: 'big.mp4', length: BIG, bytesCompleted: BIG }, // 这个文件已经下完
    { name: 'small.mp4', length: SMALL, bytesCompleted: 0 },
  ];
  mock.state.wanted = [1, 1];
  mock.state.torrentSets.length = 0;

  const fakeTorrent = tmpFile(root, 'src/early.torrent', 'd8:announce11:http://x/ye');
  fs.copyFileSync(fakeTorrent, path.join(config.dirs.btPending, 'early.torrent'));
  bt.registerPendingSeeds();
  const seed = seedsRepo.all().find((s) => s.name === 'early.torrent');
  const task = bt.enqueueSeed(seed);
  await bt.transmissionModule.prepare(tasksRepo.get(task.id));
  await bt.transmissionModule.start(tasksRepo.get(task.id));
  const started = tasksRepo.get(task.id);

  // 把 big.mp4 真的放到"我们自己指定的下载目录"里（真机上 transmission 就是往这里写）
  const ourDir = String(started.payload.downloadDir);
  fs.mkdirSync(ourDir, { recursive: true });
  fs.writeFileSync(path.join(ourDir, 'big.mp4'), Buffer.alloc(2048, 7));

  const tasksBefore = tasksRepo.list({ pageSize: 200 }).items.length;
  const p = await bt.transmissionModule.poll(started);
  assert.equal(p.done, undefined, '整个种子还没下完');

  // ① 大文件被标 unwanted（否则移走后 transmission 会重新校验/重下）
  const unset = mock.state.torrentSets.find((a) => Array.isArray(a['files-unwanted']));
  assert.ok(unset, '应该调用过 files-unwanted');
  assert.deepEqual(unset['files-unwanted'], [0], '只把索引 0（big.mp4）标成不要');

  // ② 多出一个"归档中"的发布子任务
  const all = tasksRepo.list({ pageSize: 200 }).items;
  assert.equal(all.length, tasksBefore + 1, '应该多出一个发布任务');
  const child = all.find((t) => (t.payload ?? {}).earlyHandoff);
  assert.ok(child, '子任务带 earlyHandoff 标记');
  assert.equal(child.status, 'archiving', '子任务直接进入归档，不用再下载');
  assert.equal(Number((child.payload ?? {}).parentTaskId), task.id, '记住父任务');
  assert.deepEqual((child.payload ?? {}).downloadedPaths, [path.join(ourDir, 'big.mp4')]);

  // ③ 再 poll 一次不会重复交付
  await bt.transmissionModule.poll(tasksRepo.get(task.id));
  const again = tasksRepo.list({ pageSize: 200 }).items.filter((t) => (t.payload ?? {}).earlyHandoff);
  assert.equal(again.length, 1, '同一个文件不会重复交付');

  // 子任务能被流水线正常做完（走归档->加密->发布）
  await pipelineTick();
  await pipelineTick();
  assert.equal(tasksRepo.get(child.id).status, 'completed', tasksRepo.get(child.id).error ?? '');
  assert.ok(fs.existsSync(path.join(config.dirs.consumer, tasksRepo.get(child.id).publishedName)), '子任务成品已发布');
});

test('BT 下载目录防撞名：同名种子不会共用同一个目录', async () => {
  const { pickUniqueDirName } = await import('../dist/services/btSelect.js');
  const used = new Set(['/root/dl/Demo']);
  const existing = new Set(['/root/dl/Other']);
  const name = pickUniqueDirName(
    'Demo',
    used,
    (abs) => existing.has(abs),
    () => false,
    (n) => `/root/dl/${n}`,
    99,
  );
  assert.equal(name, 'Demo-2', '已占用的名字要自动加后缀，绝不能共用目录');
  const name2 = pickUniqueDirName('Other', used, (abs) => existing.has(abs), () => false, (n) => `/root/dl/${n}`, 99);
  assert.equal(name2, 'Other-2', '磁盘上已存在的非空目录也要避开');
  const name3 = pickUniqueDirName('Fresh', used, (abs) => existing.has(abs), () => false, (n) => `/root/dl/${n}`, 99);
  assert.equal(name3, 'Fresh', '没冲突就用原名');
  const name4 = pickUniqueDirName('Other', used, (abs) => existing.has(abs), () => true, (n) => `/root/dl/${n}`, 99);
  assert.equal(name4, 'Other', '空目录可以复用（不留空壳）');
});

test('【真事故回归】空间不够时 BT 任务必须"备好但不下"，不能拿 expectBytes=0 蒙过去', async () => {
  // 事故现场：以前 transmission 的 prepare 是空壳，加种子/算大小全在 start 里，
  // 于是调度器准入时看到的是 expectBytes=0 ——"需要 0 字节"永远放行，
  // 十来个种子一起下、把磁盘撑爆越过预留，接着触发"空间不足全暂停"→ 永久死锁。
  const GB = 1024 ** 3;
  const BIG = 5 * GB;
  mock.state.complete = false;
  mock.state.percent = 0;
  mock.state.running = false;
  mock.state.files = [{ name: 'huge.mp4', length: BIG, bytesCompleted: 0 }];
  mock.state.wanted = [1];

  const fakeTorrent = tmpFile(root, 'src/huge.torrent', 'd8:announce11:http://x/ye');
  fs.copyFileSync(fakeTorrent, path.join(config.dirs.btPending, 'huge.torrent'));
  bt.registerPendingSeeds();
  const seed = seedsRepo.all().find((s) => s.name === 'huge.torrent');
  const task = bt.enqueueSeed(seed);

  // 只给 3G 可用（小于这个种子要的 5G）
  updateSettings({ reserveFreeBytes: Math.max(0, freeBytes() - 3 * GB) });
  await schedulerTick();

  const after = tasksRepo.get(task.id);
  assert.equal(after.status, 'waiting', `空间不够就不该开下，实际 ${after.status}：${after.error ?? ''}`);
  assert.match(String(after.error ?? ''), /磁盘空间不足/);
  assert.ok(
    Number(after.expectBytes) >= BIG * 0.99,
    `准入时必须已经知道真实大小（≈5G），实际 ${((Number(after.expectBytes) || 0) / GB).toFixed(2)}G`,
  );
  assert.equal(mock.state.running, false, '种子在 transmission 里必须是暂停的（一个字节都不能下）');

  // 空间够了以后再 tick，就应该正常放行
  updateSettings({ reserveFreeBytes: 1024 });
  await schedulerTick();
  assert.equal(tasksRepo.get(task.id).status, 'downloading', '空间够了应放行开下');
  assert.equal(mock.state.running, true, '这时才真正开始下载');
});
