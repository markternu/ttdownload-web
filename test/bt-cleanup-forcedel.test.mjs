/**
 * 真机事故回归：BT 目录里带中文/括号的特殊文件名 + 属主是 transmission（父目录不可写）时，
 * 普通 fs.rmSync 会 Permission denied → 目录删不掉 → 空间永远不释放。
 * 现在 removeDirs 会「修权限后重试 → rm -rf 兜底」，必须能删干净。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime } from './helpers.mjs';

const root = setupRuntime();
const { config } = await import('../dist/core/config.js');
const { removeDirs } = await import('../dist/services/btCleanup.js');

const PADDING = '_____padding_file_96_如果您看到此文件，请升级到BitComet(比特彗星)0.85或以上版本____';

test('带中文/括号的文件名 + 目录不可写 → 也必须删干净并释放空间', () => {
  const dir = path.join(config.dirs.btDownload, '0915 (17)');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PADDING), 'x'.repeat(1024));
  fs.writeFileSync(path.join(dir, 'video.mp4'), 'y'.repeat(2048));

  // 模拟transmission 落盘的权限：目录/文件都不可写（属主另说，这里至少把写权限去掉）
  fs.chmodSync(path.join(dir, PADDING), 0o444);
  fs.chmodSync(dir, 0o555);

  const res = removeDirs([dir]);
  assert.equal(fs.existsSync(dir), false, `目录必须被删掉，实际还在。skipped=${JSON.stringify(res.skipped)}`);
  assert.ok(res.freedBytes > 0, '必须统计到释放的空间（否则调度器不会回血）');
  assert.deepEqual(res.skipped, [], '不该有跳过');
});

test('只读文件 + 只读目录嵌套两层也要删干净', () => {
  const dir = path.join(config.dirs.btDownload, '0915 (18)');
  const sub = path.join(dir, 'CD1');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, PADDING), 'z'.repeat(512));
  fs.chmodSync(path.join(sub, PADDING), 0o000);
  fs.chmodSync(sub, 0o555);
  fs.chmodSync(dir, 0o555);

  const res = removeDirs([dir]);
  assert.equal(fs.existsSync(dir), false, '嵌套的只读结构也要删掉');
  assert.deepEqual(res.skipped, []);
});
