/**
 * 「BT 超时清理」设置的回归测试（真机血案）
 *
 * 用户报：设置页改「BT 超时清理」（btPolicy：多少小时检查 / 进度阈值 / 宽限小时），
 * 保存后没生效，BT 下到 12 小时还是被清掉失败。
 *
 * 真因：`PUT /api/settings` 有个字段白名单，漏了 `btPolicy`（和 `btSelect`），
 * 前端提交的这两块被静默丢掉 —— 设置从来没落盘，永远用默认 12 小时。
 *
 * 顺带验证「拉活」：把因超时被清成 failed 的任务，重新丢回下载队列（重新计时）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setupRuntime, startTransmissionMock } from './helpers.mjs';

const tm = await startTransmissionMock();
const root = setupRuntime({ env: { TRANSMISSION_RPC_PORT: String(tm.port) } });

const { createApp } = await import('../dist/app.js');
const { tasksRepo } = await import('../dist/core/db.js');
const { getSettings } = await import('../dist/services/settings.js');
const { reviveTimedOutBt } = await import('../dist/services/btEvict.js');

const server = http.createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((r) => server.close(r));
  await tm.close();
});

test('【血案回归】PUT /api/settings 必须真正落盘 btPolicy 与 btSelect', async () => {
  const patch = {
    btPolicy: { checkAfterHours: 48, minProgressPercent: 30, graceHours: 12 },
    btSelect: { bigRatio: 8, smallCeilingBytes: 300 * 1024 ** 2, manySmallCount: 5 },
  };
  const res = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  assert.equal(res.status, 200, `保存设置应成功，实际 ${res.status}`);

  const s = getSettings();
  assert.equal(s.btPolicy.checkAfterHours, 48, 'btPolicy.checkAfterHours 要真的存进去（白名单漏了就永远是 12）');
  assert.equal(s.btPolicy.minProgressPercent, 30);
  assert.equal(s.btPolicy.graceHours, 12);
  assert.equal(s.btSelect.bigRatio, 8, 'btSelect 也要能存进去');
});

test('【拉活】超时失败的任务被重新丢回下载队列并重新计时', async () => {
  // 造一个「因超时清理」而 failed 的 transmission 任务
  const t = tasksRepo.create({
    module: 'transmission',
    title: 'timeout-book',
    platform: 'BT',
    url: null,
    status: 'failed',
    error: '超时清理：...',
    payload: {
      torrentId: 999,          // transmission 里那个种子早被删了（残留旧 id）
      torrentName: 'timeout-book',
      btActiveMs: 13 * 3600e3, // 已经超时的旧计时
      btHandedAt: new Date(Date.now() - 13 * 3600e3).toISOString(),
      timedOutAt: new Date().toISOString(),
      timedOutReason: '已交给 transmission 13 小时...',
      timedOutAgeHours: 13,
    },
  });

  const r = reviveTimedOutBt();
  assert.equal(r.revived, 1, '要拉活这 1 个超时任务');

  const after = tasksRepo.get(t.id);
  assert.equal(after.status, 'waiting', '状态要回到 waiting 重新排队');
  assert.equal(after.error, null);
  assert.equal(after.progress, 0);
  assert.equal(after.payload.torrentId, 0, 'torrentId 要清 0（prepare 会用留档 .torrent 重新加）');
  assert.equal(after.payload.btActiveMs, 0, '计时要清零，按新设置重新给完整窗口');
  assert.equal(after.payload.btHandedAt, null);
  assert.equal(after.payload.timedOutAt, null, '超时标记要清掉');
});

test('【拉活】只拉"超时失败"的，其它失败任务不动', async () => {
  const normalFailed = tasksRepo.create({
    module: 'transmission',
    title: 'normal-fail',
    platform: 'BT',
    url: null,
    status: 'failed',
    error: '别的错误',
    payload: { torrentId: 1 },
  });
  const r = reviveTimedOutBt();
  assert.equal(r.revived, 0, '没有 timedOutAt 标记的任务不该被拉活');
  assert.equal(tasksRepo.get(normalFailed.id).status, 'failed', '其它失败任务保持不动');
});
