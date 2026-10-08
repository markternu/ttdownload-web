/**
 * 任务列表「全选 + 批量操作」测试（用户要求：各任务列表要有全选/全选删除/全选启动/全选暂停…）
 *
 * 要钉死的行为：
 *   ① 列表是分页的，但「全选」必须能拿到**当前筛选条件下的全部 id**（不能只有当前页 20 条）；
 *   ② 批量操作**逐条执行、逐条回报**：状态不允许的那条只影响它自己，并说明原因，
 *      绝不能让整批失败、也绝不能假装成功；
 *   ③ 「批量删除」前会先把还在跑/排队的停掉 —— 否则 transmission/aria2 里会留下
 *      没人管的孤儿下载（页面看不见却一直占带宽）；
 *   ④ 参数校验：空 ids / 未知动作要 400。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { setupRuntime, startTransmissionMock } from './helpers.mjs';

const root = setupRuntime();
const downloadDir = path.join(root, 'transmission', 'downloads', 'Demo');
fs.mkdirSync(downloadDir, { recursive: true });
const mock = await startTransmissionMock({ downloadDir, torrentName: 'Demo' });
process.env.TRANSMISSION_RPC_PORT = String(mock.port);

const { createApp } = await import('../dist/app.js');
const { tasksRepo } = await import('../dist/core/db.js');
const { stopScheduler } = await import('../dist/core/scheduler.js');

const server = http.createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(p, init = {}) {
  const res = await fetch(base + p, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

const postJson = (p, body) =>
  call(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test.after(async () => {
  stopScheduler();
  await new Promise((r) => server.close(r));
  await mock.close();
});

function makeTask(over = {}) {
  return tasksRepo.create({
    module: 'transmission',
    title: over.title ?? 'demo',
    platform: 'BT',
    ...over,
  });
}

test('GET /api/tasks/ids：能拿到**当前筛选条件下的全部** id（不受每页 20 条限制）', async () => {
  const before = (await call('/api/tasks/ids?kind=download')).json.total;
  for (let i = 0; i < 25; i += 1) makeTask({ title: `bulk-${i}` });

  const page = await call('/api/tasks?kind=download&pageSize=20');
  assert.equal(page.json.items.length, 20, '列表接口每页只给 20 条（分页）');

  const ids = await call('/api/tasks/ids?kind=download');
  assert.equal(ids.status, 200);
  assert.equal(ids.json.total, before + 25, '「全选」要拿到全部，而不是当前页那 20 条');
  assert.equal(new Set(ids.json.ids).size, ids.json.ids.length, 'id 不能重复');
});

test('批量暂停：等待中的会被暂停，状态不允许的会被跳过并说明原因（逐条回报）', async () => {
  const waiting = makeTask({ title: 'bulk-pause-waiting', status: 'waiting' });
  const done = makeTask({ title: 'bulk-pause-done', status: 'completed' });

  const res = await postJson('/api/tasks/actions', { ids: [waiting.id, done.id], action: 'pause' });
  assert.equal(res.status, 200);
  assert.equal(res.json.succeeded, 1, '等待中的那个应该被暂停');
  assert.equal(res.json.failed, 1, '已完成的那个状态不允许，要如实报失败');
  assert.equal(res.json.ok, false, '有失败项时 ok 必须为 false，前端据此提示');

  const failedItem = res.json.results.find((r) => !r.ok);
  assert.equal(failedItem.id, done.id);
  assert.match(String(failedItem.message), /不能暂停/, '要说清楚为什么没做成');

  assert.equal(tasksRepo.get(waiting.id).status, 'paused');
  assert.equal(tasksRepo.get(done.id).status, 'completed', '不能因为批量操作把别的任务状态改坏');
});

test('批量恢复：只对已暂停的生效，其它状态跳过', async () => {
  const paused = makeTask({ title: 'bulk-resume', status: 'paused' });
  const done = makeTask({ title: 'bulk-resume-done', status: 'completed' });
  const res = await postJson('/api/tasks/actions', { ids: [paused.id, done.id], action: 'resume' });
  assert.equal(res.status, 200);
  assert.equal(res.json.succeeded, 1);
  assert.equal(res.json.failed, 1);
  assert.notEqual(tasksRepo.get(paused.id).status, 'paused', '已暂停的任务要恢复（进入下载/排队）');
});

test('批量重试：失败/已取消的回到等待队列', async () => {
  const failed = makeTask({ title: 'bulk-retry', status: 'failed' });
  const res = await postJson('/api/tasks/actions', { ids: [failed.id], action: 'retry' });
  assert.equal(res.json.succeeded, 1);
  assert.equal(tasksRepo.get(failed.id).status, 'waiting');
});

test('批量删除：先取消再删记录 —— transmission 里不能留下孤儿下载', async () => {
  const running = makeTask({ title: 'bulk-delete-running', status: 'downloading' });
  // 模拟"已经交给 transmission 开下"的任务（有真实 torrentId）
  tasksRepo.update(running.id, { payload: { torrentId: 7, btHandedAt: new Date().toISOString(), btActiveMs: 0 } });
  const another = makeTask({ title: 'bulk-delete-plain', status: 'completed' });

  const removedBefore = mock.state.removed.length;
  const res = await postJson('/api/tasks/actions', { ids: [running.id, another.id], action: 'delete' });
  assert.equal(res.status, 200);
  assert.equal(res.json.succeeded, 2);
  assert.equal(tasksRepo.get(running.id), null, '任务记录要删掉');
  assert.equal(tasksRepo.get(another.id), null);
  assert.ok(
    mock.state.removed.length > removedBefore,
    '⚠️ 删除正在下载的任务前必须先取消（否则 transmission 里留下没人管的孤儿下载）',
  );
});

test('参数校验：空 ids / 未知动作都要 400（不能静默什么都不做）', async () => {
  const empty = await postJson('/api/tasks/actions', { ids: [], action: 'pause' });
  assert.equal(empty.status, 400);
  const bad = await postJson('/api/tasks/actions', { ids: [1], action: 'explode' });
  assert.equal(bad.status, 400);
  const notArray = await postJson('/api/tasks/actions', { ids: 'abc', action: 'pause' });
  assert.equal(notArray.status, 400);
});

test('批量操作对不存在的 id 只报它自己失败，不影响其它', async () => {
  const ok = makeTask({ title: 'bulk-ghost-ok', status: 'waiting' });
  const res = await postJson('/api/tasks/actions', { ids: [ok.id, 999999], action: 'pause' });
  assert.equal(res.json.succeeded, 1);
  assert.equal(res.json.failed, 1);
  assert.equal(tasksRepo.get(ok.id).status, 'paused');
  assert.match(String(res.json.results.find((r) => !r.ok).message), /不存在/);
});
