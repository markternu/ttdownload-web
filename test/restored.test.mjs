/**
 * 【还原文件目录】测试：
 *   · 播放器 与 「下载原始文件」的还原文件都放同一个目录（state/restored）；
 *   · 每个文件从还原成功起单独活 4 小时，到期清理；
 *   · 设置页「手动清理垃圾」一键清空（不管有没有到期）+ 顺带清理其它临时垃圾。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { setupRuntime, tmpFile } from './helpers.mjs';

// 假 ffmpeg（兜底，避免真调）；播放器用例用一个 faststart mp4，正常不会触发
const fakeFfmpeg = path.join(os.tmpdir(), `ttdl-fake-ffmpeg-r-${process.pid}.sh`);
fs.writeFileSync(
  fakeFfmpeg,
  `#!/bin/bash\nIN=""; prev=""; OUT=""; for a in "$@"; do if [ "$prev" = "-i" ]; then IN="$a"; fi; prev="$a"; OUT="$a"; done; cp "$IN" "$OUT"; exit 0\n`,
  { mode: 0o755 },
);

const root = setupRuntime({ env: { FFMPEG_BIN: fakeFfmpeg } });

const { encrypted, markVlt } = await import('../dist/services/crypto.js');
const { encryptFile, markVlt: markVlt2 } = await import('../dist/services/crypto.js');
const {
  RESTORED_TTL_MS,
  cleanAllRestored,
  ensureRestoredDir,
  listRestored,
  registerRestored,
  restoredDir,
  sweepRestored,
  sizeOfPath,
} = await import('../dist/services/restored.js');
const { restoredRepo } = await import('../dist/core/db.js');
const { tempDir } = await import('../dist/services/originalDownload.js');
const { preparePlayable, getPlayJob } = await import('../dist/services/player.js');
const { filesRepo } = await import('../dist/core/db.js');
const { config } = await import('../dist/core/config.js');
const { createApp } = await import('../dist/app.js');

function box(type, payload = Buffer.alloc(0)) {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt32BE(buf.length, 0);
  buf.write(type, 4, 'latin1');
  payload.copy(buf, 8);
  return buf;
}
const ftyp = box('ftyp', Buffer.from('isom\x00\x00\x02\x00isomiso2avc1mp41', 'latin1'));
const moov = box('moov', Buffer.alloc(32));
const mdat = box('mdat', Buffer.from('fake-video-data'));

test('「下载原始文件」和播放器共用同一个【还原文件目录】', () => {
  assert.equal(tempDir(), restoredDir(), '原始文件下载的临时目录必须就是还原文件目录');
  assert.ok(restoredDir().endsWith(path.join('state', 'restored')), '目录名叫 state/restored');
});

test('登记后从还原成功起活 4 小时：未到期保留、到期删文件+删记录', () => {
  ensureRestoredDir();
  const p = path.join(restoredDir(), 'movie.txt');
  fs.writeFileSync(p, 'restored-content');
  const readyAt = Date.now();
  registerRestored({ path: p, kind: 'original', sourceFileId: 1, readyAt });

  const row = listRestored().find((r) => r.path === p);
  assert.ok(row, '要登记进表');
  assert.equal(row.expires_at - row.ready_at, RESTORED_TTL_MS, '存活时间 = 4 小时');
  assert.equal(row.expires_at - readyAt, RESTORED_TTL_MS);

  // 3 小时后还在
  sweepRestored(readyAt + 3 * 3600e3);
  assert.equal(fs.existsSync(p), true, '没到 4 小时不能删');
  assert.ok(listRestored().some((r) => r.path === p));

  // 4 小时零 1 秒 → 删除
  sweepRestored(readyAt + RESTORED_TTL_MS + 1000);
  assert.equal(fs.existsSync(p), false, '超过 4 小时要删文件');
  assert.equal(listRestored().some((r) => r.path === p), false, '记录也要删掉');
});

test('一键清空：不管有没有到期，整个目录全删干净', () => {
  ensureRestoredDir();
  const a = path.join(restoredDir(), 'keep-me.bin');
  const b = path.join(restoredDir(), 'unregistered.bin');
  fs.writeFileSync(a, 'aaaa');
  fs.writeFileSync(b, 'bbbb');
  registerRestored({ path: a, kind: 'original' }); // 只登记 a，b 故意不登记
  assert.equal(sizeOfPath(restoredDir()) >= 8, true);

  const r = cleanAllRestored();
  assert.ok(r.removed >= 2, `应至少删 2 项，实际 ${r.removed}`);
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), false, '没登记的也要清（整个目录清空）');
  assert.equal(listRestored().length, 0, '登记表要清空');
});

test('播放器还原出来的文件也登记进【还原文件目录】，到期随巡检清掉', async () => {
  // 造一个 faststart mp4（不会触发 ffmpeg）→ 加密 → 登记成品
  const plainDir = path.join(root, 'pl');
  fs.mkdirSync(plainDir, { recursive: true });
  const plain = path.join(plainDir, 'movie.mp4');
  fs.writeFileSync(plain, Buffer.concat([ftyp, moov, mdat]));
  markVlt2(plain, '电影.mp4');
  const enc = path.join(plainDir, 'movie.enc');
  const er = await encryptFile(plain, enc, '');
  assert.equal(er.ok, true);
  const fileId = filesRepo.add({ taskId: null, name: 'movie.enc', title: '电影.mp4', module: 'aria2', sizeBytes: fs.statSync(enc).size, path: enc });

  const prep = preparePlayable(fileId);
  assert.equal(prep.ok, true);
  for (let i = 0; i < 200; i += 1) {
    const j = getPlayJob(prep.job.id);
    if (j && (j.state === 'ready' || j.state === 'failed')) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const job = getPlayJob(prep.job.id);
  assert.equal(job.state, 'ready', `播放器应准备好：${job.error ?? ''}`);

  const row = listRestored().find((r) => r.kind === 'player' && r.path === job.workDir);
  assert.ok(row, '播放器的还原目录要登记');
  assert.equal(row.source_file_id, fileId);

  // 手动把到期时间拨到过去 → 巡检删掉
  restoredRepo.upsert({ path: row.path, kind: 'player', sourceFileId: fileId, sizeBytes: row.size_bytes, readyAt: row.ready_at, expiresAt: Date.now() - 1 });
  sweepRestored();
  assert.equal(fs.existsSync(job.workDir), false, '到期后播放目录要被删');
});

test('POST /api/system/clean-junk：清空还原文件目录 + 顺带清其它临时垃圾', async () => {
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    ensureRestoredDir();
    const restoredFile = path.join(restoredDir(), 'leftover.tmp');
    fs.writeFileSync(restoredFile, 'restored');

    // 其它垃圾：加密临时区里的半成品（扫描时会被识别为临时文件）
    fs.mkdirSync(config.dirs.encryptTmp, { recursive: true });
    const junkFile = path.join(config.dirs.encryptTmp, '.enc.junk.part');
    fs.writeFileSync(junkFile, 'junk');

    const res = await fetch(`${base}/api/system/clean-junk`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.restored.removed >= 1, '要报告清掉的还原文件数');
    assert.equal(fs.existsSync(restoredFile), false, '还原文件目录要被清空');
    assert.equal(fs.existsSync(junkFile), false, '其它临时垃圾也要一起清');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
