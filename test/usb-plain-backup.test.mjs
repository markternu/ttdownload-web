/**
 * 加密归档前：把**未加密的原始文件**备份到 U 盘（同名同大小跳过）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime, tmpFile } from './helpers.mjs';

const root = setupRuntime();
const { backupPlainToDir } = await import('../dist/services/pipeline.js');

test('备份未加密原始文件到 U 盘：逐文件拷贝、同名同大小跳过', async () => {
  const a = tmpFile(root, 'dl/movie.mkv', 'mkv-original-bytes');
  const b = tmpFile(root, 'dl/subtitle.ass', 'ass-bytes');
  const dir = path.join(root, 'fake-usb', 'ttdownload', '原始未加密');

  const r1 = await backupPlainToDir([a, b], '电影', dir);
  assert.equal(r1.copied, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'movie.mkv'), 'utf8'), 'mkv-original-bytes');
  assert.equal(fs.readFileSync(path.join(dir, 'subtitle.ass'), 'utf8'), 'ass-bytes');

  // 再跑一次：同名同大小 → 不重复拷
  const r2 = await backupPlainToDir([a, b], '电影', dir);
  assert.equal(r2.copied, 0);
  assert.equal(r2.bytes, 0);

  // 源文件必须还在（是"拷贝"不是"剪切"）
  assert.equal(fs.existsSync(a), true);
  assert.equal(fs.existsSync(b), true);
});

test('源文件不存在 → 跳过，不影响其它文件', async () => {
  const good = tmpFile(root, 'dl2/ok.mp4', 'ok');
  const missing = path.join(root, 'dl2', 'nope.mp4');
  const dir = path.join(root, 'fake-usb2', 'ttdownload', '原始未加密');
  const r = await backupPlainToDir([missing, good], 'x', dir);
  assert.equal(r.copied, 1);
  assert.equal(fs.existsSync(path.join(dir, 'ok.mp4')), true);
});
