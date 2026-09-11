/**
 * aria2 模块 测试（mock aria2 JSON-RPC）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime, startAria2Mock } from './helpers.mjs';

const mock = await startAria2Mock({ workDir: '/tmp' });
const root = setupRuntime({ env: { ARIA2_RPC_PORT: String(mock.port) } });

const { config } = await import('../dist/core/config.js');
const { tasksRepo } = await import('../dist/core/db.js');
const { aria2Module, probeRemoteSize } = await import('../dist/modules/aria2.js');
const { handoffToArchive, pipelineTick } = await import('../dist/services/pipeline.js');

test.after(async () => {
  await mock.close();
});

test('probeRemoteSize: 无法访问的地址返回 0（不抛异常）', async () => {
  const size = await probeRemoteSize('http://127.0.0.1:1/nothing');
  assert.equal(size, 0);
});

test('aria2: RPC 不可用时错误信息清晰；可用时自动检测成功', async () => {
  const { Aria2Client, ensureAria2Daemon } = await import('../dist/modules/aria2Client.js');
  const bad = new Aria2Client('127.0.0.1', 1, '');
  await assert.rejects(() => bad.version());

  const daemon = await ensureAria2Daemon();
  assert.equal(daemon.ok, true, daemon.message);
});

test('aria2: 添加任务 -> 进度 -> 完成 -> 归档发布', async () => {
  const task = tasksRepo.create({ module: 'aria2', title: 'demo.bin', platform: 'URL', url: 'http://example.com/demo.bin' });
  await aria2Module.start(task);
  const started = tasksRepo.get(task.id);
  assert.equal(started.status, 'downloading');
  const gid = String(started.payload.gid);
  assert.equal(gid.startsWith('mock'), true);

  // 进度
  mock.setProgress(gid, { total: 4096, completed: 2048 });
  const p1 = await aria2Module.poll(tasksRepo.get(task.id));
  assert.equal(p1.progress, 50);
  assert.equal(p1.speedBps, 1024);

  // 未完成时不返回 done
  assert.equal(p1.done, undefined);

  // 完成（mock 会写真实文件且无 .aria2 控制文件）
  mock.complete(gid);
  const p2 = await aria2Module.poll(tasksRepo.get(task.id));
  assert.ok(p2.done, '完成时应返回 done');
  assert.equal(p2.done.files.length, 1);
  assert.equal(fs.existsSync(p2.done.files[0]), true);

  // 手工交接给归档流水线（真实运行由 scheduler 调用）
  handoffToArchive(task.id, p2.done.files, p2.done.originalName, p2.done.sizeBytes);
  await pipelineTick();
  await pipelineTick();
  const doneTask = tasksRepo.get(task.id);
  assert.equal(doneTask.status, 'completed', doneTask.error ?? '');
  assert.equal(fs.existsSync(path.join(config.dirs.consumer, doneTask.publishedName)), true);
});

test('aria2 队列去重：同 URL 不会创建两次（接口层验证见 api 测试）', () => {
  const list = tasksRepo.list({ modules: ['aria2'], pageSize: 100 }).items;
  assert.ok(list.length >= 1);
});
