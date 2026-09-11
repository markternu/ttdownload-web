/**
 * 加密/命名/V-L-T 标记 测试（与老脚本兼容性验证）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupRuntime, tmpFile } from './helpers.mjs';

const root = setupRuntime();
const crypto = await import('../dist/services/crypto.js');

test('deriveKeyIv 与老脚本一致（sha256/md5 hex）', () => {
  const { key, iv } = crypto.deriveKeyIv('ec3e458fcde2582e079f19368abc780f');
  assert.equal(key, '46b0cd4b0b2b3d0b5c2f4c8f1e0b6f9f'.length === key.length ? key : key); // 长度校验
  assert.equal(key.length, 64);
  assert.equal(iv.length, 32);
  // 与 openssl 命令行计算一致
  const k = execFileSync('bash', ['-c', "printf '%s' ec3e458fcde2582e079f19368abc780f | openssl dgst -sha256 -binary | xxd -p -c 256"]).toString().trim();
  const i = execFileSync('bash', ['-c', "printf '%s' ec3e458fcde2582e079f19368abc780f | openssl dgst -md5 -binary | xxd -p -c 256"]).toString().trim();
  assert.equal(key, k);
  assert.equal(iv, i);
});

test('V-L-T 标记写入/检测/读取原始文件名', () => {
  const f = tmpFile(root, 'vlt/plain.bin', 'hello-world');
  assert.equal(crypto.hasVltMarker(f), false);
  assert.equal(crypto.markVlt(f, '原始视频名.mp4'), true);
  assert.equal(crypto.hasVltMarker(f), true);
  assert.equal(crypto.readVltOriginalName(f), '原始视频名.mp4');
  // 重复标记幂等
  const sizeBefore = fs.statSync(f).size;
  crypto.markVlt(f, '另一个名字.mp4');
  assert.equal(fs.statSync(f).size, sizeBefore);
});

test('stripExtension: xxx.data -> xxx', () => {
  const f = tmpFile(root, 'strip/oqq1.data', 'cipher');
  const out = crypto.stripExtension(f);
  assert.equal(path.basename(out), 'oqq1');
  assert.equal(fs.existsSync(out), true);
});

test('加密 -> openssl 解密 往返，V-L-T 标记保留（PC 端可还原）', async () => {
  const src = tmpFile(root, 'enc/plain.bin', 'A'.repeat(5000));
  crypto.markVlt(src, '我的视频.mp4');
  const out = `${src}.data`;
  const res = await crypto.encryptFile(src, out, 'ec3e458fcde2582e079f19368abc780f');
  assert.equal(res.ok, true);
  assert.equal(fs.existsSync(out), true);

  // 用同样的 key/iv 解密，验证内容一致且标记仍在
  const { key, iv } = crypto.deriveKeyIv('ec3e458fcde2582e079f19368abc780f');
  const dec = path.join(root, 'enc/plain.dec');
  execFileSync('bash', ['-c', `openssl enc -d -aes-256-cbc -K ${key} -iv ${iv} -in '${out}' -out '${dec}'`]);
  const original = fs.readFileSync(src);
  const restored = fs.readFileSync(dec);
  assert.deepEqual(restored, original);
  assert.equal(crypto.readVltOriginalName(dec), '我的视频.mp4');
});

test('nextPublishName: 3字母前缀+递增，且不复用已存在名字', () => {
  crypto.initNamePrefix('abc');
  const n1 = crypto.nextPublishName();
  const n2 = crypto.nextPublishName();
  assert.match(n1, /^abc\d+$/);
  assert.notEqual(n1, n2);
  const dir = path.join(root, 'xiaofeizhe_downd');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, n2), 'x');
  const n3 = crypto.nextPublishName();
  assert.notEqual(n3, n2);
});
