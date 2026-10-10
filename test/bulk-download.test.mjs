/**
 * 「全选 → 全部下载 / 全部下载原始文件」测试（tar 打包，一条连接）
 *
 * 用户诉求（原话）：
 *   "全选后只有全部删除功能，增加两个选择：一个全部下载，二是全部下载原始文件。
 *    现在一个一个点击下这两个任意选项的时候连续点击下 5 个还是 6 个就必须要等前面的
 *    下载完了才能下载之后的，这次调整把限制也去掉。"
 *
 * 那个"5~6 个就得等"是**浏览器**对"同一站点同时下载数"的限制（Chrome 约 6），
 * 服务端加并发绕不过去；唯一有效的办法是打成**一个包、一条连接**。
 * 所以这里的用例都要证明：① 接口真的吐出**合法的 tar**（用系统 tar 命令验证）；
 * ② 解密是**并行**的，不是一个一个排队。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setupRuntime, startAria2Mock } from './helpers.mjs';

const mock = await startAria2Mock({ workDir: '/tmp' });
const root = setupRuntime({
  env: {
    ARIA2_RPC_PORT: String(mock.port),
    ORIGINAL_DL_SECRET: 'bulk-test-secret-0123456789abcdef0123456789',
  },
});

const { createApp } = await import('../dist/app.js');
const { filesRepo } = await import('../dist/core/db.js');
const { config } = await import('../dist/core/config.js');
const { markVlt, encryptFile } = await import('../dist/services/crypto.js');
const { currentCode } = await import('../dist/services/originalCode.js');
const { listJobs } = await import('../dist/services/originalDownload.js');

const consumerDir = path.join(root, 'xiaofeizhe_downd');
fs.mkdirSync(consumerDir, { recursive: true });

const server = http.createServer(createApp());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((r) => server.close(r));
  await mock.close();
});

/** 造一个成品（可指定内容），返回 files 表里的 id */
function makeFile(name, content) {
  const p = path.join(consumerDir, name);
  fs.writeFileSync(p, content);
  return filesRepo.add({
    taskId: null,
    name,
    title: `${name}.mp4`,
    module: 'webvideo',
    sizeBytes: Buffer.byteLength(content),
    path: p,
  });
}

/** 造一个"加密归档"（真的用项目自己的加密代码），返回 files 表 id 与原始内容 */
async function makeEncrypted(name, plainText, originalName) {
  const plain = path.join(root, `${name}.plain`);
  fs.writeFileSync(plain, plainText);
  markVlt(plain, originalName);
  await encryptFile(plain, plain + '.data', config.encryptPassword);
  fs.rmSync(plain);
  const target = path.join(consumerDir, name);
  fs.renameSync(plain + '.data', target);
  const id = filesRepo.add({
    taskId: null,
    name,
    title: originalName,
    module: 'webvideo',
    sizeBytes: fs.statSync(target).size,
    path: target,
  });
  return id;
}

/** 把响应体写成文件，返回路径（测试里用系统 tar 验证） */
function saveBody(buf, name) {
  const p = path.join(root, 'downloads', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
}

test('【全部下载】多个成品打成一个合法的 tar（系统 tar 能列出并解出内容一致）', async () => {
  const a = makeFile('bulk-a', 'AAA-content');
  const b = makeFile('bulk-b', 'BBB-content-longer');
  const res = await fetch(`${base}/api/files/bulk-download?ids=${a},${b}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/x-tar');
  assert.match(String(res.headers.get('content-disposition')), /attachment; filename="ttdownload-.*\.tar"/);
  assert.equal(res.headers.get('x-bulk-files'), '2');

  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(Number(res.headers.get('content-length')), buf.length, 'Content-Length 必须与实际字节数一致');
  const tarPath = saveBody(buf, 'bulk.tar');

  // 用系统 tar 验证：能被识别成 tar、条目名对、内容字节一致
  const list = execFileSync('tar', ['-tf', tarPath], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(list.sort(), ['bulk-a', 'bulk-b']);
  assert.equal(execFileSync('tar', ['-xOf', tarPath, 'bulk-a'], { encoding: 'utf8' }), 'AAA-content');
  assert.equal(execFileSync('tar', ['-xOf', tarPath, 'bulk-b'], { encoding: 'utf8' }), 'BBB-content-longer');
});

test('【全部下载】已不在磁盘上的文件自动跳过并在响应头里说明；全都不可用则 404', async () => {
  const ok = makeFile('bulk-ok', 'ok');
  const gone = makeFile('bulk-gone', 'gone');
  fs.rmSync(path.join(consumerDir, 'bulk-gone'));
  const res = await fetch(`${base}/api/files/bulk-download?ids=${ok},${gone}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-bulk-files'), '1');
  assert.equal(res.headers.get('x-bulk-skipped'), '1');
  const buf = Buffer.from(await res.arrayBuffer());
  const list = execFileSync('tar', ['-tf', saveBody(buf, 'bulk2.tar')], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(list, ['bulk-ok']);

  const none = await fetch(`${base}/api/files/bulk-download?ids=${gone}`);
  assert.equal(none.status, 404, '一个都拿不到要如实报错，不能给个空包');

  const empty = await fetch(`${base}/api/files/bulk-download?ids=`);
  assert.equal(empty.status, 400, '空 ids 要 400');
});

test('【全部下载原始文件】三个文件**并行**解密（不是一个一个排队），完成后一个 tar 打包下载', async () => {
  const f1 = await makeEncrypted('enc-1', 'PLAIN-1', '原片 1.mp4');
  const f2 = await makeEncrypted('enc-2', 'PLAIN-2', '原片 2.mp4');
  const f3 = await makeEncrypted('enc-3', 'PLAIN-3', '原片 3.mp4');

  // 没解锁 → 403（和单文件同一条规矩）
  const locked = await fetch(`${base}/api/original/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [f1, f2, f3] }),
  });
  assert.equal(locked.status, 403);

  const unlock = await fetch(`${base}/api/original/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: currentCode() }),
  });
  assert.equal(unlock.status, 200, `解锁应成功（当前密码 ${currentCode()}）`);
  const cookie = (unlock.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

  const start = await fetch(`${base}/api/original/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ fileIds: [f1, f2, f3] }),
  });
  const started = await start.json();
  assert.equal(start.status, 200);
  assert.equal(started.jobs.length, 3, `三个文件都要被受理（实际 ${JSON.stringify(started.failed)}）`);
  const jobIds = started.jobs.map((j) => j.id);

  // ⭐ 关键：三个任务必须**同时在跑**（用户要的就是"别一个个排队"）
  const running = listJobs().filter((j) => jobIds.includes(j.id) && j.state === 'decrypting');
  assert.equal(running.length, 3, `三个解密任务应同时在跑，实际只有 ${running.length} 个在跑`);

  // 等它们解密完（小文件，应该很快）
  let ready = [];
  for (let i = 0; i < 100; i += 1) {
    const r = await fetch(`${base}/api/original/jobs`, { headers: { cookie } });
    const body = await r.json();
    const mine = body.jobs.filter((j) => jobIds.includes(j.id));
    if (mine.length === 3 && mine.every((j) => j.state !== 'decrypting')) {
      ready = mine.filter((j) => j.state === 'ready');
      assert.equal(ready.length, 3, `三个都应解密成功：${JSON.stringify(mine.map((j) => [j.state, j.error]))}`);
      break;
    }
    await new Promise((r2) => setTimeout(r2, 100));
  }
  assert.equal(ready.length, 3, '解密超时（没等到 ready）');

  const dl = await fetch(`${base}/api/original/bulk/download?jobs=${jobIds.join(',')}`, { headers: { cookie } });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/x-tar');
  assert.equal(dl.headers.get('x-bulk-files'), '3');
  const tarPath = saveBody(Buffer.from(await dl.arrayBuffer()), 'original.tar');

  const list = execFileSync('tar', ['-tf', tarPath], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(list.sort(), ['原片 1.mp4', '原片 2.mp4', '原片 3.mp4'], 'tar 里必须是**原始文件名**');
  assert.equal(execFileSync('tar', ['-xOf', tarPath, '原片 2.mp4'], { encoding: 'utf8' }), 'PLAIN-2');

  // 下载完 → 临时文件按规矩立刻删掉（任务也从列表里消失）
  const after = listJobs().filter((j) => jobIds.includes(j.id));
  assert.equal(after.length, 0, '批量下载完成后应立刻清理临时文件与任务');
});

test('【全部下载原始文件】还没就绪就点下载 → 明确报错（不能给半成品）', async () => {
  const unlock = await fetch(`${base}/api/original/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: currentCode() }),
  });
  const cookie = (unlock.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const notReady = await fetch(`${base}/api/original/bulk/download?jobs=nope1,nope2`, { headers: { cookie } });
  assert.equal(notReady.status, 400);
  const body = await notReady.json();
  assert.match(body.error.message, /就绪|解密/);
});

test('打包下载不会在服务器上留临时文件（流式，不需要额外磁盘）', async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ttdl-')).length;
  const id = makeFile('bulk-stream', 'stream-me');
  const res = await fetch(`${base}/api/files/bulk-download?ids=${id}`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 512, '应有 tar 内容');
  // 服务器临时目录（original-tmp / state）里不该多出这次打包的产物
  const stateDir = path.join(config.dirs.state);
  const stray = fs.existsSync(stateDir)
    ? fs.readdirSync(stateDir).filter((n) => n.includes('bulk') || n.endsWith('.tar'))
    : [];
  assert.deepEqual(stray, [], `不该在 state 目录留下打包产物：${stray.join(',')}`);
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ttdl-')).length;
  assert.equal(after, before, '不该在系统临时目录里堆东西');
});
