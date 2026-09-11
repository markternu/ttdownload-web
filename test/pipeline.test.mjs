/**
 * 归档 + 加密发布流水线 测试
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupRuntime, tmpFile } from './helpers.mjs';

const root = setupRuntime();
const crypto = await import('../dist/services/crypto.js');
const { archiveTaskFiles } = await import('../dist/services/archive.js');
const { pipelineTick } = await import('../dist/services/pipeline.js');
const { config } = await import('../dist/core/config.js');
const { tasksRepo, filesRepo } = await import('../dist/core/db.js');

test('archive: 单文件归档 -> 命名为 3字母+序号 并写 V-L-T 标记', async () => {
  crypto.initNamePrefix('zzz');
  const src = tmpFile(root, 'src/single_video.mp4', 'video-bytes');
  const res = await archiveTaskFiles([src], { originalName: '单文件视频.mp4' });
  assert.equal(res.ok, true);
  assert.match(res.publishedName, /^zzz\d+$/);
  assert.equal(fs.existsSync(res.archivePath), true);
  assert.equal(crypto.hasVltMarker(res.archivePath), true);
  assert.equal(crypto.readVltOriginalName(res.archivePath), '单文件视频.mp4');
  assert.equal(fs.existsSync(src), false, '原文件应被移动');
});

test('archive: 多文件归档 -> 打包成 zip（扁平、名字含 zip）', async () => {
  const a = tmpFile(root, 'multi/video.mp4', 'AAAA');
  const b = tmpFile(root, 'multi/cover.jpg', 'BBBB');
  const res = await archiveTaskFiles([a, b], { originalName: '合集目录' });
  assert.equal(res.ok, true);
  const list = execFileSync('unzip', ['-l', res.archivePath]).toString();
  assert.match(list, /video\.mp4/);
  assert.match(list, /cover\.jpg/);
  assert.equal(crypto.hasVltMarker(res.archivePath), true);
  assert.equal(crypto.readVltOriginalName(res.archivePath), '合集目录');
});

test('pipeline: archiving -> encrypting -> 发布到消费者目录（无后缀密文）', async () => {
  crypto.initNamePrefix('ppp');
  const src = tmpFile(root, 'pipe/movie.mp4', 'M'.repeat(2048));
  crypto.markVlt(src, '流水线电影.mp4');

  const task = tasksRepo.create({ module: 'aria2', title: '流水线电影.mp4', platform: 'URL', url: 'http://x/movie.mp4' });
  tasksRepo.update(task.id, {
    status: 'archiving',
    payload: { downloadedPaths: [src], originalName: '流水线电影.mp4' },
  });

  await pipelineTick();
  await pipelineTick();

  const after = tasksRepo.get(task.id);
  assert.equal(after.status, 'completed', `任务应完成，实际 ${after.status} / ${after.error ?? ''}`);
  assert.match(after.publishedName, /^ppp\d+$/);

  const published = path.join(config.dirs.consumer, after.publishedName);
  assert.equal(fs.existsSync(published), true, '发布文件应存在');
  assert.equal(path.extname(published), '', '发布文件必须无后缀');

  // 用与老脚本相同的 key/iv 解密，验证原始文件名标记仍可读
  const { key, iv } = crypto.deriveKeyIv('ec3e458fcde2582e079f19368abc780f');
  const dec = path.join(root, 'pipe/decrypted.bin');
  execFileSync('bash', ['-c', `openssl enc -d -aes-256-cbc -K ${key} -iv ${iv} -in '${published}' -out '${dec}'`]);
  assert.equal(crypto.readVltOriginalName(dec), '流水线电影.mp4');

  const list = filesRepo.list({ pageSize: 10 });
  assert.equal(list.total >= 1, true);
  assert.equal(list.rows[0].name, after.publishedName);
  assert.equal(list.rows[0].size_bytes > 0, true);
});

test('pipeline: 归档文件缺失 -> 任务失败并给出原因', async () => {
  const task = tasksRepo.create({ module: 'aria2', title: '缺失文件', platform: 'URL', url: 'http://x/missing' });
  tasksRepo.update(task.id, { status: 'archiving', payload: { downloadedPaths: ['/nonexistent/file.bin'], originalName: 'x' } });
  await pipelineTick();
  const after = tasksRepo.get(task.id);
  assert.equal(after.status, 'failed');
  assert.match(String(after.error), /归档失败/);
});
