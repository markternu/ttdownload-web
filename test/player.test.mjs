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
const { preparePlayable, getPlayJob, getPlayItem, preparePlayItem } = await import('../dist/services/player.js');
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

async function waitItem(jobId, index, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const it = getPlayItem(jobId, index);
    if (it && (it.state === 'ready' || it.state === 'failed')) return it;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待视频准备超时（${it?.state} / ${it?.error}）`);
    await new Promise((r) => setTimeout(r, 50));
  }
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
  assert.equal(job.items.length, 1, '播放列表 1 个视频');
  assert.equal(job.items[0].state, 'pending', 'moov 在后 → 选中时才转');
  assert.ok(preparePlayItem(job.id, 0));
  const it = await waitItem(job.id, 0);
  assert.equal(it.state, 'ready', it.error ?? '');
  assert.ok(it.playPath && fs.existsSync(it.playPath), '要产出可播放文件');
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
  assert.equal(job.items[0].state, 'ready', 'faststart 的 mp4 直接可播');
  assert.ok(job.items[0].playPath);
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
  assert.equal(job.items.length, 2, 'zip 里两个视频都要进播放列表（不是只挑一个）');
  assert.ok(preparePlayItem(job.id, 0));
  const it = await waitItem(job.id, 0);
  assert.equal(it.state, 'ready', it.error ?? '');
  assert.ok(fs.existsSync(it.playPath), '要产出可播放文件');
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
    assert.equal(status.items[0].state, 'ready', 'faststart mp4 应直接可播');

    const ranged = await fetch(`${base}/api/files/play/stream/${start.id}/0`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(ranged.status, 206);
    assert.match(String(ranged.headers.get('content-range')), /^bytes 0-9\//);
    assert.equal(ranged.headers.get('accept-ranges'), 'bytes');
    const body = Buffer.from(await ranged.arrayBuffer());
    assert.equal(body.length, 10);

    // Safari 友好：URL 带 .mp4 也能播
    const mp4 = await fetch(`${base}/api/files/play/stream/${start.id}/0.mp4`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(mp4.status, 206, '带 .mp4 后缀的播放地址要能用');
    // 兼容老缓存前端（旧的 /play/stream/:jobId 没有 index）
    const legacy = await fetch(`${base}/api/files/play/stream/${start.id}`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(legacy.status, 206, '旧播放地址（无 index）要向后兼容');
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

/* ---------- zip 归档名字带 _z 标记 ---------- */

test('多文件 zip 归档 / 单个 zip 文件 → 归档名带 _z；单文件不带', async () => {
  const { archiveTaskFiles } = await import('../dist/services/archive.js');
  const { initNamePrefix } = await import('../dist/services/crypto.js');
  const { execFileSync } = await import('node:child_process');
  initNamePrefix('zzz');

  const dir = path.join(root, 'mark');
  fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, 'a.mp4');
  const b = path.join(dir, 'b.mp4');
  fs.writeFileSync(a, 'a-bytes');
  fs.writeFileSync(b, 'b-bytes');

  const multi = await archiveTaskFiles([a, b], { originalName: 'multi' });
  assert.equal(multi.ok, true);
  assert.match(multi.publishedName, /_z$/, '多文件打成 zip → 名字要带 _z');

  const zipPath = path.join(dir, 'bundle.zip');
  execFileSync('zip', ['-j', '-q', zipPath, path.join(dir, 'a.mp4')]);
  const singleZip = await archiveTaskFiles([zipPath], { originalName: 'single-zip' });
  assert.equal(singleZip.ok, true);
  assert.match(singleZip.publishedName, /_z$/, '原始文件本身就是 zip → 也要带 _z');

  const c = path.join(dir, 'c.mp4');
  fs.writeFileSync(c, 'c-bytes');
  const single = await archiveTaskFiles([c], { originalName: 'single' });
  assert.equal(single.ok, true);
  assert.doesNotMatch(single.publishedName, /_z$/, '单个普通文件不带 _z');
});

/* ---------- 复用已解密 + 无扩展名/文件夹/特殊字符 ---------- */

test('复用：同一文件再次点播放，不会再解密（同一 job）', async () => {
  const plain = tmpFile(root, 'p5/reuse.mp4', Buffer.concat([ftyp, moov, mdat]));
  const fileId = await publishEncrypted(plain, '复用.mp4');

  const a = preparePlayable(fileId);
  const b = preparePlayable(fileId);
  assert.equal(a.job.id, b.job.id, '同一个文件已有任务 → 直接复用，不能重复解密');
  const job = await waitReady(a.job.id);
  assert.equal(job.state, 'ready');
  const { decryptedPath } = await import('../dist/services/decrypted.js');
  assert.ok(fs.existsSync(decryptedPath(fileId)), '要有共享解密产物（播放/下载原始文件共用）');
});

test('复用：还原目录里已有解密好的文件 → 直接取用，不再跑 openssl', async () => {
  const { registerRestored, restoredDir, ensureRestoredDir } = await import('../dist/services/restored.js');
  const plain = tmpFile(root, 'p6/reuse2.mp4', Buffer.concat([ftyp, moov, mdat]));
  const fileId = await publishEncrypted(plain, '复用2.mp4');

  // 手工造一个"上次已经解密好"的工作目录（解密结果 = 去掉 VLT 尾的 mp4 + meta.json）
  ensureRestoredDir();
  const workDir = fs.mkdtempSync(path.join(restoredDir(), `play_${fileId}_`));
  fs.writeFileSync(path.join(workDir, 'decrypted.bin'), Buffer.concat([ftyp, moov, mdat]));
  fs.writeFileSync(path.join(workDir, 'meta.json'), JSON.stringify({ fileId, originalName: '复用2.mp4' }));
  registerRestored({ path: workDir, kind: 'player', sourceFileId: fileId, sizeBytes: 3000, readyAt: Date.now() });

  const prep = preparePlayable(fileId);
  assert.equal(prep.job.workDir, workDir, '要复用还原目录里上次的工作目录');
  const job = await waitReady(prep.job.id);
  assert.equal(job.state, 'ready');
  assert.equal(job.items.length, 1);
  assert.equal(job.items[0].state, 'ready', '已经是 faststart mp4 → 直接可播');
});

test('文件名没有扩展名（如「1（4）」）→ 靠文件内容识别成视频', async () => {
  const plain = tmpFile(root, 'p7/noext.mp4', Buffer.concat([ftyp, moov, mdat]));
  const fileId = await publishEncrypted(plain, '1（4）');
  const prep = preparePlayable(fileId);
  const job = await waitReady(prep.job.id);
  assert.equal(job.state, 'ready', `无扩展名的 mp4 也要能播：${job.error ?? ''}`);
  assert.equal(job.items.length, 1);
  assert.equal(job.items[0].state, 'ready');
});

test('zip 里是文件夹 + 中文/空格/特殊字符名 → 递归进去，全部进播放列表', async () => {
  const src = path.join(root, 'zip-folder');
  const sub = path.join(src, '文件夹（1）');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, '第一集 测试（1）.mp4'), Buffer.concat([ftyp, moov, mdat]));
  fs.writeFileSync(path.join(sub, '第二集 测试（2）.mkv'), Buffer.from('fake-mkv'));
  const zipPath = path.join(root, 'folder-bundle.zip');
  const { execFileSync } = await import('node:child_process');
  execFileSync('zip', ['-r', '-q', zipPath, '文件夹（1）'], { cwd: src });

  const fileId = await publishEncrypted(zipPath, '合集（文件夹）.zip');
  const prep = preparePlayable(fileId);
  const job = await waitReady(prep.job.id);
  assert.equal(job.state, 'ready', `zip 里套文件夹也要能播：${job.error ?? ''}`);
  assert.equal(job.items.length, 2, '文件夹里的两个视频都要进播放列表');
  assert.ok(
    job.items.some((it) => it.name.includes('第一集 测试（1）')),
    '特殊字符文件名要能正确识别',
  );
  // 第二个（mkv）按需转封装
  const mkvItem = job.items.find((it) => it.name.endsWith('.mkv'));
  assert.equal(mkvItem.state, 'pending');
  assert.ok(preparePlayItem(job.id, mkvItem.index));
  const it = await waitItem(job.id, mkvItem.index);
  assert.equal(it.state, 'ready', it.error ?? '');
});

test('rar/7z 压缩包 → 明确提示不支持，而不是含糊的"不是视频"', async () => {
  const plain = tmpFile(root, 'p8/archive.bin', 'Rar!\x1a\x07\x00' + 'x'.repeat(200));
  const fileId = await publishEncrypted(plain, '压缩包.rar');
  const prep = preparePlayable(fileId);
  const job = await waitReady(prep.job.id);
  assert.equal(job.state, 'failed');
  assert.match(String(job.error), /rar|7z|压缩包/i);
});

/* ---------- VLC：原始流（不转封装） ---------- */

test('VLC：原始流直接给原文件（不转码），地址带 token 供 VLC 免登录', async () => {
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const rawBytes = Buffer.from('fake-mkv-bytes-for-vlc');
    const plain = tmpFile(root, 'p9/movie.mkv', rawBytes);
    const fileId = await publishEncrypted(plain, '原始视频.mkv');

    const start = await (await fetch(`${base}/api/files/${fileId}/play`, { method: 'POST' })).json();
    let st;
    for (let i = 0; i < 100; i += 1) {
      st = await (await fetch(`${base}/api/files/play/status/${start.id}`)).json();
      if (st.state === 'ready' || st.state === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(st.state, 'ready', st.error ?? '');
    assert.equal(st.items[0].name, '原始视频.mkv', '单文件用原始名（带真实扩展名）');
    assert.equal(st.items[0].state, 'pending', 'mkv 不自动转封装，等 VLC 直接播');

    const vlc = await (await fetch(`${base}/api/files/play/vlc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: start.id, index: 0 }),
    })).json();
    assert.ok(vlc.url.includes('token='), 'VLC 地址要带 token（VLC 没有登录 cookie）');
    assert.equal(vlc.name, '原始视频.mkv');

    const raw = await fetch(vlc.url);
    assert.equal(raw.status, 200);
    const body = Buffer.from(await raw.arrayBuffer());
    assert.deepEqual(body, rawBytes, '原始流必须是原文件字节，不是转封装后的 mp4');

    const ranged = await fetch(vlc.url, { headers: { Range: 'bytes=0-3' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-type'), 'video/x-matroska');

    const m3u = await fetch(vlc.m3u);
    assert.equal(m3u.status, 200);
    const m3uText = await m3u.text();
    assert.match(m3uText, /#EXTM3U/);
    assert.match(m3uText, /movie\.mkv|play\/raw/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/* ---------- 播放 / 下载原始文件 共用解密产物 ---------- */

test('共享解密产物：ensureDecrypted 第二次直接复用，不重复解密', async () => {
  const { ensureDecrypted, decryptedPath } = await import('../dist/services/decrypted.js');
  const plain = tmpFile(root, 'p10/share.mp4', Buffer.concat([ftyp, moov, mdat]));
  const fileId = await publishEncrypted(plain, '共享.mp4');

  const a = await ensureDecrypted(fileId);
  assert.equal(a.ok, true);
  assert.equal(a.payload.reused, false, '第一次要真的解密');
  const shared = decryptedPath(fileId);
  assert.ok(fs.existsSync(shared), '要产出共享解密文件');
  const mtime1 = fs.statSync(shared).mtimeMs;

  const b = await ensureDecrypted(fileId);
  assert.equal(b.ok, true);
  assert.equal(b.payload.reused, true, '第二次必须复用，不能重复解密');
  assert.equal(b.payload.path, a.payload.path);
  assert.equal(fs.statSync(shared).mtimeMs, mtime1, '复用时文件不应被重写');

  // 播放也走同一份共享产物
  const prep = preparePlayable(fileId);
  const job = await waitReady(prep.job.id);
  assert.equal(job.state, 'ready');
  assert.equal(fs.statSync(shared).mtimeMs, mtime1, '播放也不应重新解密');
});

test('文件清单显示播放状态：没点过 → 不显示；解密完成 → ready（可直接播放）', async () => {
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const plain = tmpFile(root, 'p11/status.mp4', Buffer.concat([ftyp, moov, mdat]));
    const fileId = await publishEncrypted(plain, '状态.mp4');

    // 没点过播放 → 列表里 playStatus 为 null（界面什么都不显示）
    let list = await (await fetch(`${base}/api/files?pageSize=100`)).json();
    assert.equal(list.items.find((f) => f.id === fileId)?.playStatus ?? null, null);

    // 点播放并等解密完成 → playStatus = 'ready'
    const start = await (await fetch(`${base}/api/files/${fileId}/play`, { method: 'POST' })).json();
    for (let i = 0; i < 100; i += 1) {
      const st = await (await fetch(`${base}/api/files/play/status/${start.id}`)).json();
      if (st.state === 'ready' || st.state === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    list = await (await fetch(`${base}/api/files?pageSize=100`)).json();
    assert.equal(list.items.find((f) => f.id === fileId)?.playStatus, 'ready', '解密完成后列表要显示"可直接播放"');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
