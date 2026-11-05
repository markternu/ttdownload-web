/**
 * 「播放器」测试：加密归档 → 解密 →（zip 解压）→（非 mp4/faststart 重封装）→ 可播放 mp4。
 *
 * ffmpeg 在测试环境里用**假的**（脚本把输入原样复制到输出），这样能确定性验证：
 *   ① 不是 mp4 / moov 在后的文件，会真的去调 ffmpeg 重封装；
 *   ② 已经是 mp4 + faststart 的文件**不会**白跑 ffmpeg；
 *   ③ zip 归档会先解压再挑视频；
 *   ④ 播放流支持 HTTP Range（<video> 拖进度条靠它）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { setupRuntime, tmpFile } from './helpers.mjs';

// —— 假 ffmpeg：记录调用 + 把 -i 的输入复制到最后那个参数（输出）——
const fakeFfmpeg = path.join(os.tmpdir(), `ttdl-fake-ffmpeg-${process.pid}.sh`);
const ffmpegLog = path.join(os.tmpdir(), `ttdl-ffmpeg-calls-${process.pid}.log`);
fs.writeFileSync(
  fakeFfmpeg,
  `#!/bin/bash
echo "$@" >> "${ffmpegLog}"
IN=""; prev=""; OUT=""
for a in "$@"; do
  if [ "$prev" = "-i" ]; then IN="$a"; fi
  prev="$a"
  OUT="$a"
done
cp "$IN" "$OUT"
exit 0
`,
  { mode: 0o755 },
);
try {
  fs.rmSync(ffmpegLog, { force: true });
} catch {
  /* ignore */
}

const root = setupRuntime({ env: { FFMPEG_BIN: fakeFfmpeg } });

const { encryptFile, markVlt } = await import('../dist/services/crypto.js');
const { preparePlayable, getPlayJob } = await import('../dist/services/player.js');
const { isMp4Faststart, isZipFile, pickVideoFile } = await import('../dist/services/media.js');
const { filesRepo } = await import('../dist/core/db.js');
const { createApp } = await import('../dist/app.js');

/** 造一个 mp4 顶层 box */
function box(type, payload = Buffer.alloc(0)) {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt32BE(buf.length, 0);
  buf.write(type, 4, 'latin1');
  payload.copy(buf, 8);
  return buf;
}
const ftyp = box('ftyp', Buffer.from('isom\x00\x00\x02\x00isomiso2avc1mp41', 'latin1'));
const mdat = box('mdat', Buffer.from('fake-video-data'.repeat(10)));
const moov = box('moov', Buffer.alloc(32));

const ffmpegCalls = () => {
  try {
    return fs.readFileSync(ffmpegLog, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

/** 把一个明文文件 VLT 标记 + 加密，登记成 published_files，返回 fileId */
async function publishEncrypted(plainPath, title) {
  assert.equal(markVlt(plainPath, title), true);
  const enc = `${plainPath}.enc`;
  const r = await encryptFile(plainPath, enc, '');
  assert.equal(r.ok, true, `加密失败：${r.error}`);
  return filesRepo.add({
    taskId: null,
    name: path.basename(enc),
    title,
    module: 'aria2',
    sizeBytes: fs.statSync(enc).size,
    path: enc,
  });
}

async function waitReady(jobId, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const j = getPlayJob(jobId);
    if (j && (j.state === 'ready' || j.state === 'failed')) return j;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待播放准备超时（最后状态 ${j?.state} / ${j?.error}）`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('mp4（moov 在后）→ 会重封装成 mp4+faststart 再播放', async () => {
  const plain = tmpFile(root, 'p1/movie.mp4', Buffer.concat([ftyp, mdat, moov]));
  const fileId = await publishEncrypted(plain, 'moov在后.mp4');
  assert.equal(isMp4Faststart(plain), false, '造的文件应是 moov 在后');

  fs.rmSync(ffmpegLog, { force: true });
  const prep = preparePlayable(fileId);
  assert.equal(prep.ok, true);
  const job = await waitReady(prep.job.id);
  assert.equal(job.state, 'ready', `应准备好，实际 ${job.state} / ${job.error}`);
  assert.ok(job.playPath && fs.existsSync(job.playPath), '要产出可播放文件');
  assert.ok(ffmpegCalls().length >= 1, 'moov 在后 → 必须调用 ffmpeg 重封装');
});

test('mp4（moov 在前 / faststart）→ 直接用，不白跑 ffmpeg', async () => {
  const plain = tmpFile(root, 'p2/fast.mp4', Buffer.concat([ftyp, moov, mdat]));
  const fileId = await publishEncrypted(plain, 'faststart.mp4');
  assert.equal(isMp4Faststart(plain), true, '造的文件应是 moov 在前');

  fs.rmSync(ffmpegLog, { force: true });
  const prep = preparePlayable(fileId);
  const job = await waitReady(prep.job.id);
  assert.equal(job.state, 'ready');
  assert.equal(ffmpegCalls().length, 0, '已经 faststart 的 mp4 不该再跑 ffmpeg');
});

test('zip 归档 → 先解压再挑视频，再重封装', async () => {
  // 造一个含视频的 zip
  const dir = path.join(root, 'zip-src');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ep1.mkv'), Buffer.from('fake-mkv-1'));
  fs.writeFileSync(path.join(dir, 'ep2.mkv'), Buffer.from('fake-mkv-2-bigger'));
  const zipPath = path.join(root, 'bundle.zip');
  const { execFileSync } = await import('node:child_process');
  execFileSync('zip', ['-j', '-q', zipPath, path.join(dir, 'ep1.mkv'), path.join(dir, 'ep2.mkv')]);
  assert.equal(isZipFile(zipPath), true);

  const fileId = await publishEncrypted(zipPath, '合集.zip');
  fs.rmSync(ffmpegLog, { force: true });
  const prep = preparePlayable(fileId);
  const job = await waitReady(prep.job.id);
  assert.equal(job.state, 'ready', `zip 应能解压播放，实际 ${job.state} / ${job.error}`);
  assert.ok(fs.existsSync(job.playPath), '要产出可播放文件');
});

test('不是视频也不是 zip → 明确失败（不瞎调用 ffmpeg）', async () => {
  const plain = tmpFile(root, 'p3/readme.txt', 'hello world, not a video');
  const fileId = await publishEncrypted(plain, 'readme.txt');
  fs.rmSync(ffmpegLog, { force: true });
  const prep = preparePlayable(fileId);
  const job = await waitReady(prep.job.id);
  assert.equal(job.state, 'failed');
  assert.match(String(job.error), /不是视频/);
  assert.equal(ffmpegCalls().length, 0);
});

test('pickVideoFile：多个视频时挑最大的', () => {
  const dir = path.join(root, 'pick');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.mp4'), Buffer.alloc(10));
  fs.writeFileSync(path.join(dir, 'sub', 'b.mkv'), Buffer.alloc(100));
  fs.writeFileSync(path.join(dir, 'cover.jpg'), Buffer.alloc(5));
  assert.equal(path.basename(pickVideoFile(dir)), 'b.mkv');
});

test('播放流：支持 Range（206 + Content-Range）', async () => {
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const plain = tmpFile(root, 'p4/stream.mp4', Buffer.concat([ftyp, moov, mdat]));
    const fileId = await publishEncrypted(plain, '流测试.mp4');

    const start = await (await fetch(`${base}/api/files/${fileId}/play`, { method: 'POST' })).json();
    assert.ok(start.id, '要返回 jobId');

    let status;
    for (let i = 0; i < 100; i += 1) {
      status = await (await fetch(`${base}/api/files/play/status/${start.id}`)).json();
      if (status.state === 'ready' || status.state === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(status.state, 'ready', `应准备好：${status.error ?? ''}`);

    const ranged = await fetch(`${base}/api/files/play/stream/${start.id}`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(ranged.status, 206);
    assert.match(String(ranged.headers.get('content-range')), /^bytes 0-9\//);
    assert.equal(ranged.headers.get('accept-ranges'), 'bytes');
    const body = Buffer.from(await ranged.arrayBuffer());
    assert.equal(body.length, 10);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/* ---------- 归档前：非 mp4 视频统一转 mp4+faststart ---------- */

test('normalizeVideosForArchive：非 mp4 / moov 在后 → 转成 mp4 并替换原文件', async () => {
  const { normalizeVideosForArchive } = await import('../dist/services/media.js');
  const dir = path.join(root, 'norm');
  fs.mkdirSync(dir, { recursive: true });

  const mkv = path.join(dir, 'movie.mkv');
  fs.writeFileSync(mkv, Buffer.from('fake-mkv-not-mp4'));
  const fast = path.join(dir, 'already.mp4');
  fs.writeFileSync(fast, Buffer.concat([ftyp, moov, mdat]));

  fs.rmSync(ffmpegLog, { force: true });
  const r = await normalizeVideosForArchive([mkv, fast]);
  assert.equal(r.converted, 1, '只有非 mp4 的那个要转');
  assert.equal(fs.existsSync(mkv), false, '原 mkv 应被移除');
  assert.ok(fs.existsSync(path.join(dir, 'movie.mp4')), '应产出 movie.mp4');
  assert.ok(r.files.some((f) => f.endsWith('movie.mp4')), '返回的文件列表要换成新 mp4');
  assert.equal(ffmpegCalls().length, 1, '只对需要转的那一个调用 ffmpeg');
});
