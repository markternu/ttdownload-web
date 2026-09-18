/**
 * 磁盘准入的"预扣额度"测试 —— 线上真实投诉锁死：
 *
 *   用户看到「可用于下载 5.28G」，却有一个 1.6G 的任务在排队。
 *   两个历史 bug：
 *     ① 调度器按 `expectBytes` **全额**预扣一整场下载 —— 一个下到 91% 的任务（2.48G/2.53G）
 *        仍占着整整 2.48G，而它其实只差 0.22G；
 *     ② `/api/system` 读的是 `expect_bytes`（返回的是驼峰 `expectBytes`）→ `reservedBytes`
 *        恒为 0，接口把"可用于下载"直接当成"还能再放行"，用户看到的数和判定用的数不是一回事。
 *
 * 修好后：预扣 = max(expectBytes, totalBytes) − downloadedBytes（只算还差多少），
 * 调度器与接口共用同一套算法，前端显示的"可立即开始"就是判定用的数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setupRuntime, startAria2Mock } from './helpers.mjs';

const mock = await startAria2Mock({ workDir: '/tmp' });
setupRuntime({ env: { ARIA2_RPC_PORT: String(mock.port) } });

const { createApp } = await import('../dist/app.js');
const { tasksRepo } = await import('../dist/core/db.js');
const { remainingBytesOf, reservedByRunningTasks } = await import('../dist/core/space.js');

const server = http.createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((r) => server.close(r));
  await mock.close();
});

function makeTask({ status, expectBytes = 0, totalBytes = 0, downloadedBytes = 0 }) {
  const t = tasksRepo.create({
    module: 'transmission',
    title: '预扣测试',
    platform: 'BT',
    url: null,
    status,
    priority: 0,
    expectBytes,
  });
  if (totalBytes || downloadedBytes) tasksRepo.update(t.id, { totalBytes, downloadedBytes });
  return tasksRepo.get(t.id);
}

test('预扣只算"还差多少"：下到 91% 的任务不再按全额占额度', () => {
  // 真机数字：预计 2.48G、实际总量 2.53G、已下 2.31G → 还差 0.22G（旧逻辑占 2.48G）
  assert.equal(
    remainingBytesOf({ expectBytes: 2_480_000_000, totalBytes: 2_530_000_000, downloadedBytes: 2_310_000_000 }),
    220_000_000,
    '应按 max(预计, 实际总量) − 已下 = 还差多少',
  );
  // 没有元数据（预计 0、总量 0）：还差 0，不能凭空占额度（BT 任务 prepare 前就是这个状态）
  assert.equal(remainingBytesOf({ expectBytes: 0, totalBytes: 0, downloadedBytes: 0 }), 0);
  // 已下超过总量：0，绝不能是负数（负数会把总额度算大）
  assert.equal(remainingBytesOf({ expectBytes: 100, totalBytes: 200, downloadedBytes: 500 }), 0);
});

test('接口的"运行中预扣"必须是真的（旧代码字段名写错 → 恒为 0）', async () => {
  makeTask({ status: 'downloading', expectBytes: 2_480_000_000, totalBytes: 2_530_000_000, downloadedBytes: 2_310_000_000 });
  makeTask({ status: 'downloading', expectBytes: 1_000_000_000, totalBytes: 1_000_000_000, downloadedBytes: 400_000_000 });
  // 等待中的任务**不能**把自己算进预扣
  makeTask({ status: 'waiting', expectBytes: 1_620_000_000 });

  assert.equal(reservedByRunningTasks(), 220_000_000 + 600_000_000, '只统计正在下载的，且只算还差多少');

  const res = await fetch(`${base}/api/system`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.disk.reservedBytes, 820_000_000, '接口保留真实预扣（仅展示，旧代码恒为 0）');
  assert.equal(
    json.disk.admittableBytes,
    json.disk.usableBytes,
    '准入只按「可用于下载」，不再扣运行中任务（用户规则：可用于下载 − 需要 < 0 才不下）',
  );
});

test('调度器与接口用的是同一套算法（同一时刻同一个数）', async () => {
  const res = await fetch(`${base}/api/system`);
  const json = await res.json();
  assert.equal(json.disk.reservedBytes, reservedByRunningTasks(), '两边必须完全一致');
});
