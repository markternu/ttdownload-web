/**
 * 模块并发门控 + 老部署自动迁移 测试
 *
 * 背景（真实的坑）：BT(transmission) 的模块并发默认值是 1，用户上传一包 10 多个
 * .torrent 时**只有 1 个在下载**，其余全部排队 —— 磁盘还剩 18G、全局并发也没占满。
 * 更糟的是那道门当时是**静默 `continue`**：任务上只显示"等待"，日志里一个字都没有，
 * 用户完全无从排查，只能来问"你这逻辑不对"。
 *
 * 这个文件锁住三件事：
 *   1. 模块并发上限真的会拦任务（按模块分别计数，不是全局）
 *   2. 调大上限后原本等待的任务能起来（说明"等待"是可恢复的，不是死住）
 *   3. 已部署机器（数据库里存着旧设置）启动时会被一次性修正 1 -> 新默认值，
 *      并且落盘、只做一次
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupRuntime, startAria2Mock } from './helpers.mjs';

const mock = await startAria2Mock({ workDir: '/tmp' });
const root = setupRuntime({ reserveFreeBytes: 1024, env: { ARIA2_RPC_PORT: String(mock.port) } });

const { tasksRepo, settingsRepo } = await import('../dist/core/db.js');
const { schedulerTick } = await import('../dist/core/scheduler.js');
const { updateSettings, getSettings, defaultSettings } = await import('../dist/services/settings.js');
const { config } = await import('../dist/core/config.js');

test.after(async () => {
  await mock.close();
});

test('模块并发上限按模块生效：aria2 限 2 时，5 个等待任务只起 2 个', async () => {
  updateSettings({ maxConcurrent: 10, moduleConcurrency: { transmission: 3, aria2: 2, webvideo: 2 } });
  for (let i = 0; i < 5; i++) {
    tasksRepo.create({ module: 'aria2', title: `mc${i}.bin`, platform: 'URL', url: `http://example.com/mc${i}.bin` });
  }
  await schedulerTick();
  const running = tasksRepo.byStatus(['downloading', 'parsing']);
  assert.equal(running.length, 2, `aria2 模块并发上限是 2，应只起 2 个，实际 ${running.length}`);
  const waiting = tasksRepo.byStatus(['waiting']);
  assert.equal(waiting.length, 3, `其余 3 个应在等待，实际 ${waiting.length}`);

  // 等待中的任务必须**说明原因**（以前是静默的，用户看不出为什么）
  assert.ok(
    waiting.every((t) => /并发已满/.test(String(t.error))),
    '等待中的任务要写清楚是"模块并发已满"，实际: ' + waiting.map((t) => t.error).join(' | '),
  );
});

test('调大模块并发后，等待的任务会起来（不是死住）', async () => {
  updateSettings({ maxConcurrent: 10, moduleConcurrency: { transmission: 3, aria2: 5, webvideo: 2 } });
  await schedulerTick();
  const running = tasksRepo.byStatus(['downloading', 'parsing']);
  assert.equal(running.length, 5, `调大后 5 个都该起来，实际 ${running.length}`);
  assert.equal(tasksRepo.byStatus(['waiting']).length, 0, '不应再有等待任务');
  // 起来之后"并发已满"的提示要被清掉
  assert.ok(running.every((t) => !/并发已满/.test(String(t.error))), '启动后不应残留门控提示');
});

test('BT 并发的默认值不该是 1（回归：上传一包种子只跑一个）', () => {
  const d = defaultSettings();
  assert.ok(
    d.moduleConcurrency.transmission > 1,
    `transmission 默认并发必须 > 1，否则上传一包种子只会跑一个，实际 ${d.moduleConcurrency.transmission}`,
  );
  assert.equal(d.moduleConcurrency.transmission, config.moduleConcurrency.transmission, '默认值来自 config');
});

test('已部署机器：数据库里存着 transmission=1 的旧设置，读到时会自动修正并落盘（且只做一次）', async () => {
  const { migrateSettings, reloadSettings } = await import('../dist/services/settings.js');

  // 1) 迁移函数本身（测的是**生产代码**，不是测试里复刻的副本）
  const legacy = { ...defaultSettings() };
  delete legacy.schemaVersion;
  legacy.moduleConcurrency = { transmission: 1, aria2: 2, webvideo: 2 };
  const { next, notes } = migrateSettings(legacy);
  assert.equal(next.moduleConcurrency.transmission, config.moduleConcurrency.transmission,
    `旧值 1 应被提到 ${config.moduleConcurrency.transmission}，实际 ${next.moduleConcurrency.transmission}`);
  assert.equal(next.schemaVersion, 1, '应写入 schemaVersion=1');
  assert.ok(notes.some((n) => /transmission/.test(n)), '要说明改了什么，实际: ' + notes.join(' | '));

  // 2) 已经有 schemaVersion 就不再动用户设置（用户手动改回 1 也不该被改）
  const manual = { ...next, moduleConcurrency: { ...next.moduleConcurrency, transmission: 1 } };
  const again = migrateSettings(manual);
  assert.equal(again.next.moduleConcurrency.transmission, 1, '已有 schemaVersion 时不该再改用户设置');
  assert.equal(again.notes.length, 0, '不该再报改动');

  // 3) 走真实读路径：数据库里放一份老设置 -> 读到就自动修正并落盘
  const legacyStored = { ...legacy };
  delete legacyStored.schemaVersion;
  settingsRepo.setMany({ app_settings: JSON.stringify(legacyStored) });
  const loaded = reloadSettings();
  assert.equal(loaded.moduleConcurrency.transmission, config.moduleConcurrency.transmission,
    '从数据库读到老设置时应自动修正 BT 并发');
  const persisted = JSON.parse(settingsRepo.getAll().app_settings);
  assert.equal(persisted.moduleConcurrency.transmission, config.moduleConcurrency.transmission,
    '修正结果必须落盘（否则下次重启又变回 1）');
  assert.equal(persisted.schemaVersion, 1, '落盘时带上 schemaVersion');

  // 收尾：恢复正常设置，别影响其它测试
  updateSettings({ maxConcurrent: 3, moduleConcurrency: { transmission: 3, aria2: 2, webvideo: 2 } });
});
