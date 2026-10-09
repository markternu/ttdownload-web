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
const { aria2Module, probeRemoteSize, titleForNewTask, guessFileName, taskDownloadDir, baseNameOfUrl } = await import('../dist/modules/aria2.js');
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

/* ------------------------------------------------------------------ *
 *  直链任务的两个真机 bug（2026-10-08 用户反馈）
 * ------------------------------------------------------------------ */

test('【标题】`.../download?id=x` 这类直链不能全都叫 "download" —— 用户要求 download1…downloadn', () => {
  // 用户原话："download1，download2，download3，download4.。。。downloadn 这样也能接受"
  const used = new Set();
  const titles = [1, 2, 3, 4].map((i) => titleForNewTask(`https://cdn.example.com/download?id=${i}`, used));
  assert.deepEqual(titles, ['download1', 'download2', 'download3', 'download4'], `实际 ${titles.join(',')}`);
  assert.equal(new Set(titles).size, 4, '必须互不相同');

  // 单个调用（没给 used 集合）也要编号，绝不返回裸 "download"
  assert.equal(titleForNewTask('https://cdn.example.com/download?id=9'), 'download1');
  assert.notEqual(titleForNewTask('https://cdn.example.com/download?id=9'), 'download');

  // 像文件名的照旧用文件名；重名才加序号（加在扩展名前）
  assert.equal(titleForNewTask('https://x.com/a/b/电影 1080p.mp4'), '电影 1080p.mp4');
  assert.equal(titleForNewTask('https://x.com/f.zip?token=1'), 'f.zip');
  const dup = new Set(['movie.mp4']);
  assert.equal(titleForNewTask('https://y.com/other/movie.mp4', dup), 'movie2.mp4');

  // 基础名（给 aria2 当 out 用只能是真文件名；不像就不设，让服务器给真名）
  assert.equal(baseNameOfUrl('https://x.com/download?id=1'), 'download');
  assert.equal(guessFileName('https://x.com/download?id=1'), '', '不像文件名 → 不设 out');
  assert.equal(guessFileName('https://x.com/a.mp4'), 'a.mp4');
});

test('【连接类失败】服务器掐掉 TLS 握手 → 自动换**单连接**重试一次，任务不能就这么失败', async () => {
  const url = 'https://cdn.example.com/download?id=SSL1';
  const task = tasksRepo.create({ module: 'aria2', title: titleForNewTask(url), platform: 'URL', url });
  await aria2Module.start(task);
  const gid1 = String(tasksRepo.get(task.id).payload.gid);
  const addsBefore = mock.state.addCalls.length;

  // 模拟真机现象：16 并发被服务器掐断
  mock.fail(gid1, {
    code: 1,
    message: 'SSL/TLS handshake failure: The TLS connection was non-properly terminated.',
  });
  const r = await aria2Module.poll(tasksRepo.get(task.id));
  assert.equal(r.error, undefined, '连接类失败不该直接判任务失败（用户实测单连接能下）');

  const after = tasksRepo.get(task.id);
  const gid2 = String(after.payload.gid);
  assert.notEqual(gid2, gid1, '要重新建一个 aria2 任务');
  assert.equal(after.payload.singleConnection, true, '要标记"已退到单连接"');
  assert.equal(after.status, 'downloading');

  const lastAdd = mock.state.addCalls[mock.state.addCalls.length - 1];
  assert.equal(mock.state.addCalls.length, addsBefore + 1, '应该只重试一次');
  assert.equal(lastAdd.options.split, '1', '重试必须改成单连接（split=1）');
  assert.equal(lastAdd.options['max-connection-per-server'], '1', '每服务器连接数也要降到 1');

  // 第二次还失败就别再折腾了，如实报错
  mock.fail(gid2, { code: 1, message: 'SSL/TLS handshake failure: The TLS connection was non-properly terminated.' });
  const r2 = await aria2Module.poll(tasksRepo.get(task.id));
  assert.ok(r2.error, '单连接也失败 → 如实报错，不能无限重试');
  assert.match(String(r2.error), /SSL\/TLS/);
});

test('【非连接类失败】不该被"单连接重试"掩盖（404 就是 404）', async () => {
  const url = 'https://cdn.example.com/nope-404.bin';
  const task = tasksRepo.create({ module: 'aria2', title: titleForNewTask(url), platform: 'URL', url });
  await aria2Module.start(task);
  const gid = String(tasksRepo.get(task.id).payload.gid);
  const addsBefore = mock.state.addCalls.length;
  mock.fail(gid, { code: 3, message: 'Resource not found' });
  const r = await aria2Module.poll(tasksRepo.get(task.id));
  assert.ok(r.error, '404 要如实失败');
  assert.equal(mock.state.addCalls.length, addsBefore, '不该白白重建任务');
});

test('【标题刷新】aria2 拿到真实文件名后，任务标题要跟着变成真名', async () => {
  const url = 'https://cdn.example.com/download?id=REAL';
  const task = tasksRepo.create({ module: 'aria2', title: titleForNewTask(url), platform: 'URL', url });
  await aria2Module.start(task);
  const gid = String(tasksRepo.get(task.id).payload.gid);
  // mock 的文件名来自 addUri 的 out（这里没给 out → fileN.bin）；模拟服务器给了真名的情况
  mock.state.tasks.get(gid).file = '/tmp/真名-视频.mp4';
  await aria2Module.poll(tasksRepo.get(task.id));
  assert.equal(tasksRepo.get(task.id).title, '真名-视频.mp4', '要换成 aria2 解析出来的真实文件名');
});

test('【守护进程参数】并发可配置、且要带上重试参数（16 并发招服务器掐连接）', async () => {
  const { aria2DaemonArgs } = await import('../dist/modules/aria2Client.js');
  const args = aria2DaemonArgs({ port: 6800, secret: 's', dir: '/tmp/dl', session: '/tmp/s.session' });
  const get = (k) => args.find((a) => a.startsWith(`--${k}=`));
  assert.equal(get('split'), `--split=${config.aria2.split}`);
  assert.equal(get('max-connection-per-server'), `--max-connection-per-server=${config.aria2.maxConnectionPerServer}`);
  assert.ok(config.aria2.split <= 8, `默认连接数要收敛（实测 8 并发已能跑满带宽），实际 ${config.aria2.split}`);
  assert.equal(get('max-tries'), `--max-tries=${config.aria2.maxTries}`, '连接被掐断多半是瞬时的，要多试几次');
  assert.equal(get('retry-wait'), `--retry-wait=${config.aria2.retryWaitSec}`);
  assert.equal(get('rpc-secret'), '--rpc-secret=s');
  assert.ok(!args.some((a) => /max-(overall-)?download-limit/.test(a)), '绝不能出现限速参数（用户要求拉满带宽）');
});

test('【互不影响】每个任务一个专属目录（对齐用户手动 mkdir 的做法），且重试复用同一目录', () => {
  const a = taskDownloadDir(101, 'https://cdn.example.com/download?id=AAA');
  const b = taskDownloadDir(102, 'https://cdn.example.com/download?id=BBB');
  assert.notEqual(a, b, '不同任务必须落在不同目录 —— 否则同名文件会互相覆盖（"其中两个莫名其妙报错"的真因之一）');
  assert.match(a, /101-/, '目录名带任务号，便于排查');
  assert.ok(a.startsWith(config.dirs.aria2), '还是在本模块的下载根目录下');

  const withName = taskDownloadDir(103, 'https://x.com/a/movie%201080p.mp4');
  assert.match(withName, /movie_1080p\.mp4$/, 'URL 里有真文件名就用它');

  // 重试/续传必须复用同一目录（否则已下的分片找不到 → 白下）
  assert.equal(taskDownloadDir(101, 'https://cdn.example.com/download?id=AAA', { downloadDir: a }), a);
});

test('【对齐用户做法】默认并发=同服务器 1 条连接（他手动 aria2c -i 就是这个默认值，从没出过问题）', () => {
  assert.equal(config.aria2.maxConnectionPerServer, 1, '默认必须和手动 aria2c 一致（同服务器 1 条连接）');
  assert.ok(config.aria2.split <= 8, `split 也要收敛，实际 ${config.aria2.split}`);
  assert.ok(config.aria2.maxConcurrentDownloads >= 8, '"再多文件也不影响" → 同时下载的任务数要够');
});

test('【提交上限】一次能交很多 URL（用户手动流程没有数量上限）', async () => {
  const { createApp } = await import('../dist/app.js');
  const http = await import('node:http');
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const urls = Array.from({ length: 250 }, (_, i) => `https://bulk.example.com/f${i}.bin`).join('\n');
    const res = await fetch(`${base}/api/aria2/urls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, `250 个 URL 不该被拒（实际 ${res.status}）`);
    assert.equal(body.created, 250, '250 个都要建出来');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('【接口层】提交多个 `.../download?id=x` 直链：任务标题必须是 download1…downloadn，不能重名', async () => {
  const { createApp } = await import('../dist/app.js');
  const http = await import('node:http');
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const urls = [1, 2, 3, 4, 5].map((i) => `https://named.example.com/download?id=${i}`).join('\n');
    const res = await fetch(`${base}/api/aria2/urls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    const titles = body.tasks.map((t) => t.title);
    assert.equal(titles.length, 5);
    assert.equal(new Set(titles).size, 5, `标题不能重名：${titles.join(',')}`);
    assert.ok(!titles.includes('download'), '绝不能出现裸 "download"');
    for (const t of titles) assert.match(t, /^download\d+$/, `应该是 downloadN 形式，实际 ${t}`);

    // 第二批（不同的 id）也不能和已在队列里的重名
    const res2 = await fetch(`${base}/api/aria2/urls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: 'https://named.example.com/download?id=101\nhttps://named.example.com/download?id=102' }),
    });
    const body2 = await res2.json();
    const titles2 = body2.tasks.map((t) => t.title);
    assert.equal(new Set([...titles, ...titles2]).size, 7, `跨批次也不能重名：${[...titles, ...titles2].join(',')}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
