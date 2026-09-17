/**
 * BT 流程安全回归（每个用例对应审查里抓到的一个真 bug）
 *
 * 这些都不是"风格问题"，是会真出事的行为：
 *   1. incomplete（还在下的种子）里把**已下完的文件**交出去后，收尾阶段**绝不能**删
 *      transmission 任务、绝不能删目录 —— 否则还没下完的部分永远下不完。
 *   2. "共用目录只删自己的"曾经会把**别的任务正在归档的源文件**删掉（BT 下载任务的
 *      meta.files 恰好就是那些文件）→ 打包失败 / 内容丢失。
 *   3. incomplete 的重复发布：发布任务 completed 之后不在 in-flight 里，若只靠"下载任务
 *      的 harvestedFiles"记账，一旦找不到下载任务就会每个 tick 重新发布一遍。
 *   4. 空间回血恢复任务时，usable 必须在循环里递减，否则会一次性放行所有暂停任务
 *      （合计远超可用空间）→ 抖动，甚至撑爆磁盘。
 *   5. 归档打 zip 遇到同名文件（CD1/movie.mp4 + CD2/movie.mp4）会 "cannot repeat names"
 *      永久失败，而扫货每 2 分钟重建任务 → 无限失败循环。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupRuntime, startTransmissionMock } from './helpers.mjs';

const root = setupRuntime();
const completeDir = path.join(root, 'transmission', 'downloads');
const incompleteDir = path.join(root, 'transmission', 'incomplete');
process.env.BT_DOWNLOAD_DIR = completeDir;
process.env.TRANSMISSION_INCOMPLETE_DIR = incompleteDir;
fs.mkdirSync(completeDir, { recursive: true });
fs.mkdirSync(incompleteDir, { recursive: true });

const mock = await startTransmissionMock({ downloadDir: completeDir, torrentName: 'Demo' });
process.env.TRANSMISSION_RPC_PORT = String(mock.port);

const { config } = await import('../dist/core/config.js');
const { tasksRepo } = await import('../dist/core/db.js');
const { btHarvestTick } = await import('../dist/services/btHarvest.js');
const { pipelineTick } = await import('../dist/services/pipeline.js');
const { cleanupBtTaskDirs } = await import('../dist/services/btCleanup.js');
const { archiveTaskFiles } = await import('../dist/services/archive.js');
const { schedulerTick } = await import('../dist/core/scheduler.js');
const { updateSettings } = await import('../dist/services/settings.js');

test.after(async () => {
  await mock.close();
});

const TORRENT = 'SAFETYTORRENT1';
const TORRENT2 = 'SAFETYTORRENT2';

function writeFile(p, bytes) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
}

function resetTasks() {
  for (const t of tasksRepo.list({ pageSize: 500 }).items) tasksRepo.delete(t.id);
}

function resetDirs() {
  fs.rmSync(completeDir, { recursive: true, force: true });
  fs.rmSync(incompleteDir, { recursive: true, force: true });
  fs.mkdirSync(completeDir, { recursive: true });
  fs.mkdirSync(incompleteDir, { recursive: true });
}

test.beforeEach(() => {
  resetTasks();
  resetDirs();
  mock.state.torrents = [];
  mock.state.removed.length = 0;
  mock.state.torrentSets.length = 0;
  updateSettings({ btSelect: { smallFileMaxBytes: 100000 }, btPolicy: { checkAfterHours: 8, minProgressPercent: 60, graceHours: 4 }, reserveFreeBytes: 0 });
});

/* ------------------------------------------------------------------ */
/* 1 + 3 + 5(incomplete unwanted)：incomplete 交接只取货，不动任务/目录  */
/* ------------------------------------------------------------------ */

test('incomplete 交接：不删 transmission 任务、不删目录，且不会每个 tick 重复发布', async () => {
  const dir = path.join(incompleteDir, TORRENT);
  // 两个已下完的视频（多文件 → 走 zip 分支，源文件会留在原地）+ 一个没下完的
  writeFile(path.join(dir, 'done1.mp4'), 50);
  writeFile(path.join(dir, 'done2.mp4'), 50);
  writeFile(path.join(dir, 'half.mp4'), 30);
  mock.state.torrents = [
    {
      id: 7,
      name: TORRENT,
      hashString: 'h1',
      percentDone: 0.5,
      files: [
        { name: 'done1.mp4', length: 50, bytesCompleted: 50 },
        { name: 'done2.mp4', length: 50, bytesCompleted: 50 },
        { name: 'half.mp4', length: 100, bytesCompleted: 10 },
      ],
    },
  ];

  const s1 = await btHarvestTick();
  assert.equal(s1.published, 1, '应该把已下完的交接出去');

  // 交接时要在 transmission 里把它们标成 unwanted（否则搬走后会被重新下载）
  const unset = mock.state.torrentSets.find((a) => Array.isArray(a['files-unwanted']));
  assert.ok(unset, '交接前应调用 torrent-set files-unwanted');
  assert.deepEqual([...unset['files-unwanted']].sort((a, b) => a - b), [0, 1], '两个已下完的文件索引');

  // 走完流水线
  await pipelineTick();
  await pipelineTick();
  const pub = tasksRepo.list({ pageSize: 500 }).items.find((t) => (t.payload ?? {}).harvest);
  assert.equal(pub.status, 'completed', pub.error ?? '流水线应发布完成');

  // 收尾：只记账，一个字节都不动
  mock.state.removed.length = 0;
  const s2 = await btHarvestTick();
  assert.equal(mock.state.removed.length, 0, '【真 bug 回归】incomplete 的种子绝不能被移除（它还在下）');
  assert.equal(fs.existsSync(dir), true, 'incomplete 目录必须保留');
  assert.equal(fs.existsSync(path.join(dir, 'half.mp4')), true, '还没下完的文件必须保留');

  // 同一批文件不能再被发布一次（发布任务已完成、不再 in-flight）
  const s3 = await btHarvestTick();
  assert.equal(s3.published, 0, '【真 bug 回归】已交接过的文件不能重复发布');
  assert.equal(
    tasksRepo.list({ pageSize: 500 }).items.filter((t) => (t.payload ?? {}).harvest).length,
    1,
    '不该为同一批文件再建发布任务',
  );
});

/* ------------------------------------------------------------------ */
/* 2：共用目录里，别的任务正在用的文件一个都不许删                       */
/* ------------------------------------------------------------------ */

test('共用目录：不删别的活跃任务正在归档的源文件', () => {
  const dir = path.join(completeDir, TORRENT2);
  const movie = path.join(dir, 'movie.mp4');
  writeFile(movie, 1000);

  // A：另一个任务正在归档这个文件（BT 下载任务的 meta.files 恰好也会指向它）
  const other = tasksRepo.create({
    module: 'transmission',
    title: 'other-publish',
    platform: 'BT',
    status: 'archiving',
    url: null,
    priority: 0,
    expectBytes: 1000,
    payload: { downloadedPaths: [movie] },
    meta: { files: ['movie.mp4'] },
  });
  // 我：下载任务，目录里也是同一个目录，meta.files 是同名相对路径
  const me = tasksRepo.create({
    module: 'transmission',
    title: TORRENT2,
    platform: 'BT',
    status: 'downloading',
    url: null,
    priority: 0,
    expectBytes: 1000,
    payload: { downloadDir: dir },
    meta: { files: ['movie.mp4'] },
  });

  const freed = cleanupBtTaskDirs(tasksRepo.get(me.id), TORRENT2, 'test');
  assert.equal(fs.existsSync(movie), true, '【真 bug 回归】别人正在归档的源文件不能被删');
  assert.equal(freed, 0, '没删任何东西就不该报告释放了空间');

  tasksRepo.update(other.id, { status: 'completed' });
});

/* ------------------------------------------------------------------ */
/* 4：空间回血恢复任务时不能一次性全放行                                 */
/* ------------------------------------------------------------------ */

test('空间回血：可用空间只够一个时，只恢复一个暂停任务', async () => {
  resetTasks();
  const { freeBytes } = await import('../dist/core/disk.js');
  const free = freeBytes();
  const need = Math.floor(free * 0.6);

  // 一个正在跑的 BT 任务（让 nothingRunning=false，走正常准入而不是防死锁分支）
  tasksRepo.create({
    module: 'transmission',
    title: 'running',
    platform: 'BT',
    status: 'downloading',
    url: null,
    priority: 0,
    expectBytes: 1024,
    payload: { torrentId: 7, btHandedAt: new Date().toISOString() },
    meta: { files: [] },
  });
  mock.state.torrents = [
    { id: 7, name: 'running', hashString: 'hr', percentDone: 0.5, files: [{ name: 'a.mp4', length: 1000, bytesCompleted: 100 }] },
  ];
  // 3 个因空间不足被自动暂停的任务，每个都要 60% 的可用空间（加起来远超可用空间）
  for (let i = 0; i < 3; i += 1) {
    tasksRepo.create({
      module: 'transmission',
      title: `paused-${i}`,
      platform: 'BT',
      status: 'paused',
      url: null,
      priority: 0,
      expectBytes: need,
      payload: { pausedBySpace: true, torrentId: 100 + i },
      meta: { files: [] },
    });
  }
  updateSettings({ reserveFreeBytes: 0, maxConcurrent: 0, moduleConcurrency: { transmission: 0, aria2: 0, webvideo: 0 } });

  await schedulerTick();

  const resumed = tasksRepo
    .list({ pageSize: 500 })
    .items.filter((t) => String(t.title).startsWith('paused-') && t.status === 'downloading');
  assert.equal(resumed.length, 1, `【真 bug 回归】可用空间只够一个，实际恢复了 ${resumed.length} 个`);
});

/* ------------------------------------------------------------------ */
/* 5：同名文件打 zip 不能直接失败                                        */
/* ------------------------------------------------------------------ */

test('归档：不同子目录下的同名视频也能打包成功（zip -j 不能 repeat names）', async () => {
  const cd1 = path.join(root, 'src-cd', 'CD1', 'movie.mp4');
  const cd2 = path.join(root, 'src-cd', 'CD2', 'movie.mp4');
  writeFile(cd1, 200);
  writeFile(cd2, 300);

  const res = await archiveTaskFiles([cd1, cd2], { originalName: 'dupe', hideNames: true });
  assert.equal(res.ok, true, `【真 bug 回归】同名文件打包不该失败：${res.error ?? ''}`);
  assert.ok(res.sizeBytes > 0);
  assert.equal(fs.existsSync(res.archivePath), true);

  // 源文件必须还在（zip 分支不删源文件，删了会让流水线/清理互相打架）
  assert.equal(fs.existsSync(cd1), true);
  assert.equal(fs.existsSync(cd2), true);
  // 暂存目录要被清掉，不留在 state 里占地方
  const leftovers = fs.readdirSync(config.dirs.state).filter((n) => n.startsWith('zipstage_'));
  assert.deepEqual(leftovers, [], '打包用的暂存目录应被清理');
});
