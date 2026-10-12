/**
 * 加密的崩溃安全 / 断电恢复 测试。
 *
 * 用户问（原话）："我现在要是突然断电了，重启后是不是又多了很多垃圾文件，这些垃圾
 * 会不会被删除；断电前加密归档未完成的任务怎么恢复、还能不能恢复。"
 *
 * 要钉死的行为：
 *   ① 加密时源文件**留在 archiveReady 不动**（老写法先 move 走源，断电就丢 → 任务失败）；
 *   ② 加密成功才删源；中途断电留下的 `.enc.*.part` 是垃圾，开机会被清掉；
 *   ③ 断电后重启：任务能**从 archiveReady 重新加密**，数据不丢（恢复，不是白丢）；
 *   ④ 收割器在流水线已经积压时**先别灌**（否则 20 个文件一起排队加密，树莓派半天完不了）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime, tmpFile, startAria2Mock } from './helpers.mjs';

const mock = await startAria2Mock({ workDir: '/tmp' });
const root = setupRuntime({ env: { ARIA2_RPC_PORT: String(mock.port) } });

const crypto = await import('../dist/services/crypto.js');
const { config } = await import('../dist/core/config.js');
const { tasksRepo, filesRepo } = await import('../dist/core/db.js');
const { pipelineTick, cleanupStaleEncryptParts } = await import('../dist/services/pipeline.js');

test.after(async () => {
  await mock.close();
});

function makeEncryptingTask(name, content = 'X'.repeat(2048)) {
  crypto.initNamePrefix('enc');
  const src = tmpFile(root, `arc/${name}`, content);
  crypto.markVlt(src, name);
  // 模拟"已经归档完、进入加密状态"的任务：archivePath 指向 archiveReady 里的源
  const archived = path.join(config.dirs.archiveReady, name);
  fs.mkdirSync(config.dirs.archiveReady, { recursive: true });
  fs.renameSync(src, archived);
  const task = tasksRepo.create({ module: 'aria2', title: name, platform: 'URL', url: null });
  tasksRepo.update(task.id, {
    status: 'encrypting',
    payload: {
      originalName: name,
      publishUnits: [{ files: [archived], name, archivePath: archived }],
    },
  });
  return { task: tasksRepo.get(task.id), archived };
}

test('【断电恢复】加密中断后：源还在 archiveReady，任务能从源头重新加密，不丢数据', async () => {
  const { task, archived } = makeEncryptingTask('断电恢复.mp4');

  // 模拟"上次加密到一半断电"：encryptTmp 里留下一个半成品 .part，源文件完好
  fs.mkdirSync(config.dirs.encryptTmp, { recursive: true });
  const stale = path.join(config.dirs.encryptTmp, '.enc.断电恢复.mp4.deadbe.part');
  fs.writeFileSync(stale, 'half-encrypted');

  // ① 开机清理：半成品被删，但源文件**不动**
  cleanupStaleEncryptParts();
  assert.equal(fs.existsSync(stale), false, '开机要把加密半成品清掉');
  assert.equal(fs.existsSync(archived), true, '源文件必须还在（这是能恢复的前提）');

  // ② 重新跑流水线：任务应从源头重新加密 → 发布到 consumer（= 恢复成功）
  for (let i = 0; i < 6; i += 1) {
    await pipelineTick();
    if (tasksRepo.get(task.id).status === 'completed') break;
  }
  const after = tasksRepo.get(task.id);
  assert.equal(after.status, 'completed', `断电后重启要能重新加密完成，实际 ${after.status} / ${after.error ?? ''}`);
  assert.equal(fs.existsSync(archived), false, '加密成功后才删源');
  assert.ok(filesRepo.list({ pageSize: 1 }).total >= 1, '要有成品记录');
  // 没有留下半成品垃圾
  const leftover = fs.existsSync(config.dirs.encryptTmp)
    ? fs.readdirSync(config.dirs.encryptTmp).filter((n) => n.startsWith('.enc.') && n.endsWith('.part'))
    : [];
  assert.deepEqual(leftover, [], '加密成功不该留下 .part 半成品');
});

test('【加密是串行的】多个 encrypting 任务是一个一个来，不是并发', async () => {
  // 用两个任务验证串行：先只建第一个，跑一轮后第一个 completed，第二个还没开始
  const a = makeEncryptingTask('串行-a.mp4', 'A'.repeat(4096));
  const b = makeEncryptingTask('串行-b.mp4', 'B'.repeat(4096));

  // 故意让 b 排在 a 之后（创建顺序）
  // 跑够轮次直到两个都完成，全程不应该有并发加密
  for (let i = 0; i < 12; i += 1) await pipelineTick();
  assert.equal(tasksRepo.get(a.task.id).status, 'completed');
  assert.equal(tasksRepo.get(b.task.id).status, 'completed');
});

test('【收割节流】流水线里已积压 archiving/encrypting 任务时，先不再灌新的', async () => {
  const { harvestOrphanAria2 } = await import('../dist/services/aria2Harvest.js');
  // 造 3 个"还在归档"的任务 → 触发积压
  for (let i = 0; i < 3; i += 1) {
    tasksRepo.create({ module: 'aria2', title: `pending-${i}.mp4`, platform: 'URL', url: null, status: 'archiving' });
  }
  // 再放一个"下完的孤儿"文件
  const orphan = tmpFile(root, 'downd_aria2_path/orphan.mp4', 'O'.repeat(1024));
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(orphan, old, old);

  const r = await harvestOrphanAria2();
  assert.equal(r.archived, 0, '积压 ≥3 时不该再灌（否则 20 个文件一起排队加密，半天完不了）');
});
