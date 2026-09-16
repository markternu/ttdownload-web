/**
 * BT 目录清理的安全底线测试
 *
 * 用户指出的真实风险：多个种子可能落进同一个目录，一个任务清理时会把别人的资源删掉。
 * 另外早交付（大文件一下完就单独建发布子任务）之后，父任务完成时子任务的文件可能
 * 还没被流水线搬走 —— 这时删目录同样会删错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime } from './helpers.mjs';

const root = setupRuntime();
const { config } = await import('../dist/core/config.js');
const { tasksRepo } = await import('../dist/core/db.js');
const { cleanupBtTaskDirs } = await import('../dist/services/btCleanup.js');

const btRoot = config.dirs.btDownload;

function makeTask(opts) {
  const t = tasksRepo.create({ module: 'transmission', title: opts.title, platform: 'BT', status: opts.status ?? 'downloading' });
  tasksRepo.update(t.id, { payload: opts.payload ?? {} });
  return tasksRepo.get(t.id);
}

test('独占目录：整目录删掉（连 .part 残留一起清，空间真的回来）', () => {
  const dir = path.join(btRoot, 'solo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.mp4'), Buffer.alloc(1000, 1));
  fs.writeFileSync(path.join(dir, 'a.mp4.part'), Buffer.alloc(500, 2));

  const task = makeTask({ title: 'solo', payload: { downloadDir: dir, downloadedPaths: [path.join(dir, 'a.mp4')] } });
  const freed = cleanupBtTaskDirs(task, 'solo', 'test');
  assert.ok(freed >= 1500, '应该把整个目录（含 .part）都算进释放量，实际 ' + freed);
  assert.equal(fs.existsSync(dir), false, '独占目录应被删除');
});

test('目录被别的任务共用：整块跳过，绝不删', () => {
  const dir = path.join(btRoot, 'shared');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mine.mp4'), Buffer.alloc(1000, 1));
  fs.writeFileSync(path.join(dir, 'theirs.mp4'), Buffer.alloc(2000, 1));

  const other = makeTask({ title: 'other', payload: { downloadDir: dir } });
  const task = makeTask({ title: 'shared', payload: { downloadDir: dir, downloadedPaths: [path.join(dir, 'mine.mp4')] } });

  const freed = cleanupBtTaskDirs(task, 'shared', 'test');
  assert.equal(fs.existsSync(dir), true, '共用目录必须保留');
  assert.equal(fs.existsSync(path.join(dir, 'theirs.mp4')), true, '别人的文件必须还在');
  assert.equal(fs.existsSync(path.join(dir, 'mine.mp4')), false, '自己的文件可以删');
  assert.ok(freed >= 1000, '自己那份的空间要释放出来');
  tasksRepo.update(other.id, { status: 'completed' });
});

test('别的任务的文件还躺在目录里（早交付子任务在归档中）：整块跳过', () => {
  const dir = path.join(btRoot, 'early');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'big.mp4');
  fs.writeFileSync(file, Buffer.alloc(4096, 3));

  // 子任务：archiving（还没被流水线搬走），文件就在父任务目录里
  const child = tasksRepo.create({ module: 'transmission', title: 'early · big', platform: 'BT', status: 'archiving' });
  tasksRepo.update(child.id, { payload: { downloadedPaths: [file], parentTaskId: 999 } });

  const parent = makeTask({ title: 'early', payload: { downloadDir: dir, downloadedPaths: [] } });
  const freed = cleanupBtTaskDirs(parent, 'early', 'test');
  assert.equal(fs.existsSync(file), true, '子任务还没归档完，源文件不能被父任务的清理删掉');
  assert.equal(freed, 0, '这种情况不该释放任何空间');

  // 子任务做完（搬走了）之后，再清理就该成功
  tasksRepo.update(child.id, { status: 'completed' });
  const freed2 = cleanupBtTaskDirs(tasksRepo.get(parent.id), 'early', 'test');
  assert.equal(fs.existsSync(dir), false, '子任务完成后目录应被清理');
  assert.ok(freed2 >= 4096, '这次才真正释放空间');
});
