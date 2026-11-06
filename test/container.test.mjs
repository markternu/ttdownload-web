/**
 * 文件封装格式（用户要求：按**后缀**拿格式）
 *   · 新下载：加密归档前就记录（ZIP / MKV / AVI …）
 *   · 老文件：点播放 / 下载原始文件解密出原始文件后，按原始名后缀探测并写回
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime, tmpFile } from './helpers.mjs';

const root = setupRuntime();
const { containerFromName, probeContainer } = await import('../dist/services/media.js');
const { archiveTaskFiles } = await import('../dist/services/archive.js');
const { encryptFile, markVlt } = await import('../dist/services/crypto.js');
const { filesRepo, tasksRepo } = await import('../dist/core/db.js');
const { ensureDecrypted } = await import('../dist/services/decrypted.js');
const { pipelineTick } = await import('../dist/services/pipeline.js');

test('containerFromName：按后缀给格式', () => {
  assert.equal(containerFromName('电影.mkv'), 'MKV');
  assert.equal(containerFromName('a.MP4'), 'MP4');
  assert.equal(containerFromName('a.avi'), 'AVI');
  assert.equal(containerFromName('a.rmvb'), 'RMVB');
  assert.equal(containerFromName('a.wmv'), 'WMV');
  assert.equal(containerFromName('a.zip'), 'ZIP');
  assert.equal(containerFromName('1（4）'), null, '没后缀就是 null');
  assert.equal(containerFromName(undefined), null);
});

test('probeContainer：后缀优先（不依赖 ffmpeg）', async () => {
  const f = tmpFile(root, 'x/blob', 'whatever');
  assert.equal(await probeContainer(f, 'movie.mkv'), 'MKV');
  assert.equal(await probeContainer(f, 'movie.avi'), 'AVI');
  // 文件自己有后缀也行
  assert.equal(await probeContainer(tmpFile(root, 'x/y.mp4', 'x')), 'MP4');
  // 真 zip 文件即使名字没后缀也能认出
  const { execFileSync } = await import('node:child_process');
  const zsrc = tmpFile(root, 'x/inner.txt', 'hi');
  const zipPath = path.join(root, 'x', 'noext');
  // zip 命令会自动补 .zip 后缀 → 先建成 .zip 再改名去掉后缀，专门测"没后缀也能靠文件头认出"
  execFileSync('zip', ['-j', '-q', `${zipPath}.zip`, zsrc]);
  fs.renameSync(`${zipPath}.zip`, zipPath);
  assert.equal(await probeContainer(zipPath), 'ZIP');
});

test('归档时记录封装格式：多文件 ZIP / 单个视频按后缀', async () => {
  const { initNamePrefix } = await import('../dist/services/crypto.js');
  initNamePrefix('cc');
  const a = tmpFile(root, 'arc/a.mkv', 'a');
  const b = tmpFile(root, 'arc/b.mkv', 'b');
  const multi = await archiveTaskFiles([a, b], { originalName: '合集' });
  assert.equal(multi.ok, true);
  assert.equal(multi.container, 'ZIP', '多文件打包 -> ZIP');

  const c = tmpFile(root, 'arc/c.avi', 'c');
  const single = await archiveTaskFiles([c], { originalName: '单集.avi' });
  assert.equal(single.ok, true);
  assert.equal(single.container, 'AVI', '单个视频按后缀 -> AVI');
});

test('流水线：发布出来的成品带上封装格式', async () => {
  const src = tmpFile(root, 'pipe/movie.rmvb', 'fake-rmvb-content');
  markVlt(src, '老剧.rmvb');
  const task = tasksRepo.create({ module: 'aria2', title: '老剧.rmvb', platform: 'URL', url: 'http://x/a.rmvb' });
  tasksRepo.update(task.id, {
    status: 'archiving',
    payload: { downloadedPaths: [src], originalName: '老剧.rmvb' },
  });
  await pipelineTick();
  await pipelineTick();
  const after = tasksRepo.get(task.id);
  assert.equal(after.status, 'completed', after.error ?? '');
  const file = filesRepo.list({ pageSize: 20 }).rows.find((r) => r.title === '老剧.rmvb');
  assert.ok(file, '要有成品记录');
  assert.equal(file.container, 'RMVB', '发布记录要带封装格式');
});

test('老文件：点播放/下载原始文件解密后，按原始名后缀补上封装格式', async () => {
  // 造一个"发布时没记录格式"的老成品：加密归档内容 + VLT 原始名 movie.wmv
  const plain = tmpFile(root, 'old/movie.wmv', 'fake-wmv-bytes');
  markVlt(plain, '老视频.wmv');
  const enc = path.join(root, 'old', 'movie.enc');
  const r = await encryptFile(plain, enc, '');
  assert.equal(r.ok, true);
  const fileId = filesRepo.add({
    taskId: null,
    name: 'movie.enc',
    title: '老视频.wmv',
    module: 'aria2',
    sizeBytes: fs.statSync(enc).size,
    path: enc,
  });
  assert.equal(filesRepo.get(fileId).container ?? null, null, '老数据一开始没有格式');

  const dec = await ensureDecrypted(fileId);
  assert.equal(dec.ok, true);
  assert.equal(filesRepo.get(fileId).container, 'WMV', '解密后要按后缀补上 WMV');
});
