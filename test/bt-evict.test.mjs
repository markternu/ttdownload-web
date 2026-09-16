/**
 * BT 超时策略测试（用户指定：8 小时 + 4 小时宽限）
 *
 *   · 交给 transmission 后 8 小时内：什么都不做（只读进度）
 *   · 满 8 小时：进度 ≤ 60% → 清理（删任务 + 连残留一起删）
 *   · 满 8 小时但进度 > 60% → 再给 4 小时宽限；到点还没完 → 清理
 *   · 已经 100% 的不归这里管（扫货负责）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime, startTransmissionMock, tmpFile } from './helpers.mjs';

const root = setupRuntime();
const downloadDir = path.join(root, 'transmission', 'downloads', 'Demo');
const incompleteDir = path.join(root, 'transmission', 'incomplete', 'Demo');
fs.mkdirSync(downloadDir, { recursive: true });
fs.mkdirSync(incompleteDir, { recursive: true });
const mock = await startTransmissionMock({ downloadDir, torrentName: 'Demo' });
process.env.TRANSMISSION_RPC_PORT = String(mock.port);
process.env.TRANSMISSION_INCOMPLETE_DIR = path.join(root, 'transmission', 'incomplete');

const { config } = await import('../dist/core/config.js');
const { tasksRepo, seedsRepo } = await import('../dist/core/db.js');
const bt = await import('../dist/modules/transmission.js');
const { runBtEvict } = await import('../dist/services/btEvict.js');
const { updateSettings } = await import('../dist/services/settings.js');

test.after(async () => {
  await mock.close();
});

/** 造一个已经"交给 transmission 开下过"的任务（btHandedAt 可控） */
async function makeRunningTask({ name, handedHoursAgo, percent }) {
  const fake = tmpFile(root, `src/${name}.torrent`, 'd8:announce11:http://x/ye');
  fs.copyFileSync(fake, path.join(config.dirs.btPending, `${name}.torrent`));
  bt.registerPendingSeeds();
  const seed = seedsRepo.all().find((s) => s.name === `${name}.torrent`);
  const task = bt.enqueueSeed(seed);
  await bt.transmissionModule.prepare(tasksRepo.get(task.id));
  await bt.transmissionModule.start(tasksRepo.get(task.id));
  mock.state.percent = percent;
  const p = (tasksRepo.get(task.id).payload ?? {});
  const handedAt = new Date(Date.now() - handedHoursAgo * 3600 * 1000).toISOString();
  tasksRepo.update(task.id, { payload: { ...p, btHandedAt: handedAt } });
  return tasksRepo.get(task.id);
}

test('8 小时内不干涉：不管进度多低都不动它', async () => {
  const task = await makeRunningTask({ name: 'young', handedHoursAgo: 2, percent: 0.05 });
  const s = await runBtEvict();
  assert.equal(tasksRepo.get(task.id).status, 'downloading', '2 小时 < 8 小时，不该被清理');
  assert.equal(s.dropped, 0);
  assert.ok(s.kept >= 1);
});

test('满 8 小时且进度 ≤ 60% -> 清理（删任务 + 删残留）', async () => {
  const task = await makeRunningTask({ name: 'stalled', handedHoursAgo: 8.5, percent: 0.3 });
  const s = await runBtEvict();
  const after = tasksRepo.get(task.id);
  assert.equal(after.status, 'failed', `进度 30% 应该被清掉，实际 ${after.status}`);
  assert.match(String(after.error), /超时清理/);
  assert.equal(s.dropped, 1);
  assert.ok(mock.state.removed.length > 0, '应该删掉了 transmission 任务');
  assert.equal(mock.state.removed[mock.state.removed.length - 1].deleteLocalData, true, '要连下载残留一起删');
});

test('满 8 小时但进度 > 60% -> 进入宽限，不删', async () => {
  const task = await makeRunningTask({ name: 'graceful', handedHoursAgo: 8.5, percent: 0.8 });
  const s = await runBtEvict();
  assert.equal(tasksRepo.get(task.id).status, 'downloading', '进度 80% 应给宽限，不能删');
  assert.equal(s.inGrace, 1);
});

test('宽限 4 小时也过了还没下完 -> 清理', async () => {
  const task = await makeRunningTask({ name: 'toolate', handedHoursAgo: 12.5, percent: 0.75 });
  await runBtEvict();
  const after = tasksRepo.get(task.id);
  assert.equal(after.status, 'failed', `超过 8+4 小时应清理，实际 ${after.status}`);
  assert.match(String(after.error), /宽限/);
});

test('已经 100% 的不归超时策略管（扫货负责）', async () => {
  const task = await makeRunningTask({ name: 'done100', handedHoursAgo: 20, percent: 1 });
  const s = await runBtEvict();
  assert.equal(tasksRepo.get(task.id).status, 'downloading', '100% 的任务不该被超时策略删掉');
  assert.equal(s.dropped, 0);
});

test('三个数字都可在设置里改（改成 1 小时 / 90% / 1 小时）', async () => {
  updateSettings({ btPolicy: { checkAfterHours: 1, minProgressPercent: 90, graceHours: 1 } });
  const task = await makeRunningTask({ name: 'custom', handedHoursAgo: 1.5, percent: 0.85 });
  await runBtEvict();
  assert.equal(tasksRepo.get(task.id).status, 'failed', '按自定义阈值（1h / 90%）应被清理');
  updateSettings({ btPolicy: { checkAfterHours: 8, minProgressPercent: 60, graceHours: 4 } });
});
