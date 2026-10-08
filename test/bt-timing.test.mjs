/**
 * BT 计时口径测试 —— 真机事故的"牙齿"（在修复前的代码上必须红）
 *
 * 用户报的 bug：树莓派上 BT 任务只下了几个小时，**断电重启后页面显示"已下载 140 多小时"**，
 * 随后被超时清理拉走。根因是当时用墙上时钟算时长：
 *      ageHours = (Date.now() - Date.parse(payload.btHandedAt)) / 3600e3
 *   · 断电/关机那几天被算成"在下载"；
 *   · 树莓派没有 RTC，重启后 NTP 校时会让 Date.now() 跳变（正向虚增、反向负数）。
 *
 * 现在判定读 `payload.btActiveMs`：只在服务真正运行时用**单调时钟**累加。
 * 本文件覆盖：
 *   ① 断电 140 小时 → 不能虚增、不能清理（旧代码在这里必红）
 *   ② 墙上时钟整体跳变（模拟 NTP 校时）→ 判定不受影响
 *   ③ 真正下满 12+6 小时 → 该清还是要清（别把策略改废了）
 *   ④ 老任务迁移：窗口内的墙上差值可信；超出窗口的不可信值要重置而不是拿去清理
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
const { runBtEvict, migrateLegacyActiveMs, activeMsOf } = await import('../dist/services/btEvict.js');
const clock = await import('../dist/core/clock.js');

test.after(async () => {
  await mock.close();
});

async function makeTask({ name, percent, handedHoursAgo = 0, activeHoursAgo = null }) {
  const fake = tmpFile(root, `src/${name}.torrent`, 'd8:announce11:http://x/ye');
  fs.copyFileSync(fake, path.join(config.dirs.btPending, `${name}.torrent`));
  bt.registerPendingSeeds();
  const seed = seedsRepo.all().find((s) => s.name === `${name}.torrent`);
  const task = bt.enqueueSeed(seed);
  await bt.transmissionModule.prepare(tasksRepo.get(task.id));
  await bt.transmissionModule.start(tasksRepo.get(task.id));
  mock.state.percent = percent;
  const p = { ...(tasksRepo.get(task.id).payload ?? {}) };
  p.btHandedAt = new Date(Date.now() - handedHoursAgo * 3600e3).toISOString();
  if (activeHoursAgo === null) delete p.btActiveMs;
  else p.btActiveMs = activeHoursAgo * 3600e3;
  tasksRepo.update(task.id, { payload: p });
  return tasksRepo.get(task.id);
}

function ageHoursOf(taskId) {
  const p = (tasksRepo.get(taskId).payload ?? {});
  return Number(p.btActiveMs ?? NaN) / 3600e3;
}

test('【事故复现】断电 140 小时后重启：不再虚增，也不会被拉去超时清理', async () => {
  // 老任务：只有 btHandedAt（140 小时前的墙上时刻），没有 btActiveMs
  const task = await makeTask({ name: 'powercut', percent: 0.3, handedHoursAgo: 140, activeHoursAgo: null });
  const s = await runBtEvict();
  const after = tasksRepo.get(task.id);
  assert.equal(after.status, 'downloading', `断电不该被算成下载时长，任务必须保住，实际 ${after.status}`);
  assert.equal(s.dropped, 0);
  const age = ageHoursOf(task.id);
  assert.ok(Number.isFinite(age) && age < 0.1, `重置后的实际下载时长应≈0，实际 ${age} 小时`);
  assert.ok(!/140/.test(String(after.error ?? '')), '错误信息里不该再出现 140 小时');
});

test('【时钟跳变】墙上时钟向前跳 6 天（NTP 校时），判定完全不受影响', async () => {
  const task = await makeTask({ name: 'clockjump', percent: 0.4, handedHoursAgo: 2, activeHoursAgo: 2 });
  clock.__testSetWallClockOffset(140 * 3600e3); // 模拟"机器以为已经过了 140 小时"
  try {
    const s = await runBtEvict();
    assert.equal(tasksRepo.get(task.id).status, 'downloading', '墙上时钟跳变不该把任务判成超时');
    assert.equal(s.dropped, 0);
    assert.ok(ageHoursOf(task.id) < 3, `实际时长仍应≈2 小时，实际 ${ageHoursOf(task.id)}`);
  } finally {
    clock.__testResetClockOffsets();
  }
});

test('【时钟跳变】墙上时钟向后退（校时回拨）也不会算出负数或提前清理', async () => {
  const task = await makeTask({ name: 'clockback', percent: 0.2, handedHoursAgo: 5, activeHoursAgo: 5 });
  clock.__testSetWallClockOffset(-30 * 3600e3);
  try {
    await runBtEvict();
    const age = ageHoursOf(task.id);
    assert.ok(age >= 5, `时长只增不减，实际 ${age}`);
    assert.equal(tasksRepo.get(task.id).status, 'downloading');
  } finally {
    clock.__testResetClockOffsets();
  }
});

test('【单调累计】服务每巡检一次就累加两次巡检之间的真实运行时长', async () => {
  const task = await makeTask({ name: 'monotick', percent: 0.9, activeHoursAgo: 0 });
  await runBtEvict(); // 第一次：建立单调锚点，不补历史
  assert.ok(ageHoursOf(task.id) < 0.01, '第一次巡检不该凭空补时间');
  clock.__testSetMonoClockOffset(3600e3); // 服务又跑了 1 小时（单调时钟前进）
  try {
    await runBtEvict();
    const age = ageHoursOf(task.id);
    assert.ok(age > 0.99 && age < 1.01, `应恰好累计 1 小时，实际 ${age}`);
  } finally {
    clock.__testResetClockOffsets();
  }
});

test('【策略没被改废】真正下满 12 小时进度仍 ≤ 60% → 该清还是要清', async () => {
  const task = await makeTask({ name: 'reallystalled', percent: 0.25, handedHoursAgo: 12.5, activeHoursAgo: 12.5 });
  const s = await runBtEvict();
  assert.equal(tasksRepo.get(task.id).status, 'failed', '实际下了 12.5 小时还只有 25%，必须清理');
  assert.equal(s.dropped, 1);
});

test('【老任务迁移】窗口内的墙上差值可信；超出窗口的不可信值重置为 0', () => {
  const window = 18 * 3600e3;
  assert.deepEqual(migrateLegacyActiveMs(3 * 3600e3, window), { activeMs: 3 * 3600e3, reset: false }, '3 小时照抄');
  assert.deepEqual(migrateLegacyActiveMs(140 * 3600e3, window), { activeMs: 0, reset: true }, '140 小时不可信 → 重置');
  assert.deepEqual(migrateLegacyActiveMs(-5 * 3600e3, window), { activeMs: 0, reset: false }, '负数（时钟回拨）→ 归零，不给负时长');
  assert.deepEqual(migrateLegacyActiveMs(Number.NaN, window), { activeMs: 0, reset: false }, 'NaN 不炸');

  // 已经在用的 btActiveMs 一律优先，永远不会被墙上时钟覆盖
  const fake = { id: 1, module: 'transmission', payload: { btHandedAt: new Date(Date.now() - 140 * 3600e3).toISOString(), btActiveMs: 7 * 3600e3 } };
  const r = activeMsOf(fake, window);
  assert.equal(r.activeMs, 7 * 3600e3);
  assert.equal(r.legacy, false);
});
