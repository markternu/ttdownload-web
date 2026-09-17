/**
 * BT 扫货测试（用户指定的规则）
 *
 *   downloads（下完了的）：
 *     · 1 个文件 -> 单独走
 *     · 多个文件且全都 < 阈值 -> 合成一个 zip
 *     · 有文件 >= 阈值 -> 大文件一个一个单独走，小的合成一个
 *     发布成功后 -> 删文件夹 + 删 transmission 任务 + 下载任务收尾
 *   incomplete（还在下的）：
 *     · 只有 1 个文件 -> 跳过
 *     · 多个文件里有下完的 -> 只把下完的按同样规则交出去；**不动文件夹、不动任务**
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime, startTransmissionMock } from './helpers.mjs';

const root = setupRuntime();
const completeDir = path.join(root, 'transmission', 'downloads');
const incompleteDir = path.join(root, 'transmission', 'incomplete');
process.env.BT_DOWNLOAD_DIR = completeDir;
process.env.TRANSMISSION_INCOMPLETE_DIR = incompleteDir;

const mock = await startTransmissionMock({ downloadDir: completeDir, torrentName: 'Demo' });
process.env.TRANSMISSION_RPC_PORT = String(mock.port);

const { tasksRepo } = await import('../dist/core/db.js');
const { btHarvestTick } = await import('../dist/services/btHarvest.js');
const { pipelineTick } = await import('../dist/services/pipeline.js');
const { updateSettings } = await import('../dist/services/settings.js');

test.after(async () => {
  await mock.close();
});

const THRESHOLD = 100; // 用很小阈值，测试造小文件就够（真实默认 300MB）

function writeFile(p, bytes) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
}

function resetTasks() {
  for (const t of tasksRepo.list({ pageSize: 500 }).items) tasksRepo.delete(t.id);
}

/** 当前所有"扫货产生"的发布任务 */
const harvestTasks = () =>
  tasksRepo.list({ pageSize: 500 }).items.filter((t) => (t.payload ?? {}).harvest);

test.beforeEach(() => {
  resetTasks();
  updateSettings({ btSelect: { smallFileMaxBytes: THRESHOLD }, reserveFreeBytes: 0 });
  mock.state.torrents = [];
  mock.state.removed.length = 0;
  fs.rmSync(completeDir, { recursive: true, force: true });
  fs.rmSync(incompleteDir, { recursive: true, force: true });
  fs.mkdirSync(completeDir, { recursive: true });
  fs.mkdirSync(incompleteDir, { recursive: true });
});

test('downloads：只有 1 个视频 -> 单独一个成品，然后删文件夹 + 删 transmission 任务', async () => {
  const dir = path.join(completeDir, 'Demo');
  writeFile(path.join(dir, 'movie.mp4'), 50);
  mock.state.torrents = [{ id: 7, name: 'Demo', hashString: 'h1', percentDone: 1 }];

  const s1 = await btHarvestTick();
  assert.equal(s1.published, 1, '应该产生 1 个发布任务');
  const tasks = harvestTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].payload.harvest.dir, dir, '要记住处理完删哪个文件夹');
  assert.deepEqual(tasks[0].payload.downloadedPaths, [path.join(dir, 'movie.mp4')]);
  assert.equal(tasks[0].payload.publishUnits.length, 1, '1 个文件 -> 1 个成品单元');

  // 再 tick 一次不该重复建任务
  const s2 = await btHarvestTick();
  assert.equal(s2.published, 0, '同一个文件夹不该重复建任务');
  assert.equal(harvestTasks().length, 1);

  // 走完流水线（归档->加密->发布）
  await pipelineTick();
  await pipelineTick();
  assert.equal(tasksRepo.get(tasks[0].id).status, 'completed', tasksRepo.get(tasks[0].id).error ?? '');

  // 收尾：删 transmission 任务 + 删文件夹
  const s3 = await btHarvestTick();
  assert.equal(s3.finished, 1, '应该做收尾');
  assert.ok(mock.state.removed.some((r) => Number(r.ids[0]) === 7), '要删掉 transmission 任务');
  assert.equal(fs.existsSync(dir), false, '文件夹要被删掉');
});

test('downloads：多个视频全都小于阈值 -> 合成一个 zip', async () => {
  const dir = path.join(completeDir, 'Demo');
  writeFile(path.join(dir, 'a.mp4'), 30);
  writeFile(path.join(dir, 'b.mp4'), 40);
  writeFile(path.join(dir, 'c.mkv'), 50);
  writeFile(path.join(dir, 'cover.jpg'), 999); // 非视频，不管
  mock.state.torrents = [{ id: 7, name: 'Demo', hashString: 'h1', percentDone: 1 }];

  await btHarvestTick();
  const tasks = harvestTasks();
  assert.equal(tasks.length, 1, '一个目录只建一个任务');
  const units = tasks[0].payload.publishUnits;
  assert.equal(units.length, 1, '小文件应合成一个成品单元');
  assert.equal(units[0].files.length, 3, '三个视频进同一个包（图片不算）');
});

test('downloads：有文件 >= 阈值 -> 大文件各自单独，小的合成一个', async () => {
  const dir = path.join(completeDir, 'Demo');
  writeFile(path.join(dir, 'big1.mp4'), 500);
  writeFile(path.join(dir, 'big2.mp4'), 300);
  writeFile(path.join(dir, 'small1.mp4'), 10);
  writeFile(path.join(dir, 'small2.mp4'), 20);
  mock.state.torrents = [{ id: 7, name: 'Demo', hashString: 'h1', percentDone: 1 }];

  await btHarvestTick();
  const tasks = harvestTasks();
  assert.equal(tasks.length, 1, '一个目录只建一个任务（内部拆多个成品单元）');
  const units = tasks[0].payload.publishUnits;
  const singles = units.filter((u) => u.files.length === 1);
  const batch = units.filter((u) => u.files.length > 1);
  assert.equal(singles.length, 2, '两个大文件各自一个成品单元');
  assert.equal(batch.length, 1, '两个小文件合成一个成品单元');
  assert.equal(units.length, 3);
});

test('incomplete：只有 1 个文件 -> 跳过（还没下完）', async () => {
  const dir = path.join(incompleteDir, 'Demo');
  writeFile(path.join(dir, 'half.mp4'), 50);
  mock.state.torrents = [{ id: 7, name: 'Demo', hashString: 'h1', percentDone: 0.5, files: [{ name: 'half.mp4', length: 100, bytesCompleted: 50 }] }];

  const s = await btHarvestTick();
  assert.equal(s.published, 0, '只有一个文件时跳过');
});

test('incomplete：多个文件中已下完的那些 -> 交出去，但不动文件夹和任务', async () => {
  const dir = path.join(incompleteDir, 'Demo');
  writeFile(path.join(dir, 'done.mp4'), 50);
  writeFile(path.join(dir, 'half.mp4'), 10);
  mock.state.torrents = [{
    id: 7, name: 'Demo', hashString: 'h1', percentDone: 0.6,
    files: [
      { name: 'done.mp4', length: 50, bytesCompleted: 50 },  // 下完了
      { name: 'half.mp4', length: 100, bytesCompleted: 10 }, // 没下完
    ],
  }];

  const s = await btHarvestTick();
  assert.equal(s.published, 1, '已下完的那个应该被交出去');
  const tasks = harvestTasks();
  assert.deepEqual(tasks[0].payload.publishUnits[0].files, [path.join(dir, 'done.mp4')]);
  assert.equal(tasks[0].payload.harvest.dir, undefined, 'incomplete 不删文件夹');
  assert.equal(fs.existsSync(dir), true, '文件夹必须保留（还在下）');
  assert.equal(mock.state.removed.length, 0, 'transmission 任务必须保留');

  // 再 tick 不会重复交同一个文件
  const s2 = await btHarvestTick();
  assert.equal(s2.published, 0, '交过的文件不重复交');
});

test('一个任务带多个成品单元 -> 流水线产出多个成品（大文件各自单独发布的关键路径）', async () => {
  const dir = path.join(completeDir, 'Multi');
  writeFile(path.join(dir, 'big1.mp4'), 500);
  writeFile(path.join(dir, 'big2.mp4'), 400);
  writeFile(path.join(dir, 'small1.mp4'), 20);
  writeFile(path.join(dir, 'small2.mp4'), 30);
  mock.state.torrents = [{ id: 9, name: 'Multi', hashString: 'h9', percentDone: 1 }];

  await btHarvestTick();
  const tasks = harvestTasks();
  assert.equal(tasks.length, 1, '一个目录一个任务');
  assert.equal(tasks[0].payload.publishUnits.length, 3, '两个大文件各自一个 + 小文件一个 = 3 个成品');

  // 走完流水线：归档（单元1单独移动/单元2单独移动/单元3打成zip）→ 加密 → 发布
  await pipelineTick();
  await pipelineTick();
  await pipelineTick();
  const after = tasksRepo.get(tasks[0].id);
  assert.equal(after.status, 'completed', after.error ?? '');
  const fileIds = (after.payload ?? {}).fileIds ?? [];
  assert.equal(fileIds.length, 3, `应该发布了 3 个成品，实际 ${fileIds.length}`);

  // 三个成品都真的落到消费者目录了
  const { filesRepo } = await import('../dist/core/db.js');
  for (const id of fileIds) {
    const f = filesRepo.get(id);
    assert.ok(f, '成品记录应存在');
    assert.equal(fs.existsSync(f.path), true, `成品文件应存在: ${f.path}`);
  }
});
