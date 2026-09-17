/**
 * BT 日志脱敏 —— **全链路**回归（用户要求：BT 日志里不能出现种子名、也不能出现下载内容的名字）
 *
 * 为什么单独一份、而且要走全链路：
 *   老的断言只覆盖了 prepare + start + poll。真正会漏的地方在后面：
 *     ① 解压种子 zip 时把 zip 名/包内 .torrent 名写进 argv 与子进程输出（PROC_SPAWN/PROC_EXIT）
 *     ② 归档多文件时 `zip` 的 argv 就是所有源文件的**绝对路径**（含内容名）
 *     ③ 扫货日志写的是目录名 = 种子名；发布单元还带 originalName
 *     ④ 超时清理/目录清理把目录名、文件名塞进 BT_TIMEOUT / BT_CLEANUP 的数据里，
 *        再经由 space-freed 广播被调度器的 SPACE_FREED 日志整段打出来
 *     ⑤ 任务失败信息里带文件系统路径（EACCES/ENOENT: ... open '/…/名字.mp4'）
 *   这一份测试跑完"上传 → 加种 → 选片 → 开下 → 扫货 → 归档 → 加密 → 发布 → 超时清理"
 *   之后，翻**整个 app.log + 日志表**，任何一个环节的隐藏名字都不许出现。
 *
 * 同时反过来验证：数据库/界面里的真实标题照旧保留（只脱敏日志）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupRuntime, startTransmissionMock, startJsonRpcServer, tmpFile } from './helpers.mjs';

const root = setupRuntime();
const completeDir = path.join(root, 'transmission', 'downloads');
const incompleteDir = path.join(root, 'transmission', 'incomplete');
process.env.BT_DOWNLOAD_DIR = completeDir;
process.env.TRANSMISSION_INCOMPLETE_DIR = incompleteDir;
fs.mkdirSync(completeDir, { recursive: true });
fs.mkdirSync(incompleteDir, { recursive: true });

const mock = await startTransmissionMock({ downloadDir: completeDir, torrentName: 'Demo' });
process.env.TRANSMISSION_RPC_PORT = String(mock.port);

const { config } = await import('../dist/core/config.js');
const { seedsRepo, tasksRepo, logsRepo } = await import('../dist/core/db.js');
const bt = await import('../dist/modules/transmission.js');
const { TransmissionClient } = bt;
const { btHarvestTick } = await import('../dist/services/btHarvest.js');
const { pipelineTick } = await import('../dist/services/pipeline.js');
const { runBtEvict } = await import('../dist/services/btEvict.js');
const { schedulerTick, startScheduler, stopScheduler } = await import('../dist/core/scheduler.js');
const { updateSettings } = await import('../dist/services/settings.js');
const { tasksReport } = await import('../dist/services/report.js');
const { bus } = await import('../dist/core/events.js');

test.after(async () => {
  stopScheduler();
  await mock.close();
});

/** 空间回血广播是"事件"，调度器收到后会把它整个打进 SPACE_FREED 日志 → 这里捕获原始 payload 断言 */
const freedEvents = [];
bus.on('space-freed', (p) => freedEvents.push(p));

/* ------------------------------------------------------------------ */
/* 一眼能认出来的"秘密"名字                                            */
/* ------------------------------------------------------------------ */

const SECRET_ZIP = 'SECRETZIP9377';
const SECRET_TORRENT = 'SECRETTORRENT9377';
const SECRET_MOVIE1 = 'SECRETMOVIE9377';
const SECRET_MOVIE2 = 'SECRETMOVIE9378';
const SECRET_FAIL = 'SECRETFAIL9377';
const SECRETS = [SECRET_ZIP, SECRET_TORRENT, SECRET_MOVIE1, SECRET_MOVIE2, SECRET_FAIL];

function readLog() {
  return fs.existsSync(config.logPath) ? fs.readFileSync(config.logPath, 'utf8') : '';
}

/** 日志文件 + 落库的日志表，两处都不许出现秘密名字 */
function assertNoSecrets(where) {
  const log = readLog();
  assert.ok(log.length > 0, '应该有日志（否则等于把所有日志删了，不是脱敏）');
  for (const s of SECRETS) {
    assert.equal(log.includes(s), false, `${where}：app.log 里不该出现 ${s}`);
  }
  const rows = logsRepo.recent(5000);
  const table = rows.map((r) => `${r.level} ${r.message}`).join('\n');
  for (const s of SECRETS) {
    assert.equal(table.includes(s), false, `${where}：日志表里不该出现 ${s}`);
  }
}

function resetTasks() {
  for (const t of tasksRepo.list({ pageSize: 500 }).items) tasksRepo.delete(t.id);
}

function writeFile(p, bytes) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* ① 上传 zip → 解压 → 种子入库 → prepare → start → poll                */
/* ------------------------------------------------------------------ */

test('阶段1：上传/解压/选片/开下 —— 日志无名字，数据库照旧', async () => {
  mock.state.torrents = [];
  mock.state.removed.length = 0;

  // 上传的 zip 名与包内的 .torrent 名都是敏感信息
  const torrentSrc = tmpFile(root, `src/${SECRET_TORRENT}.torrent`, 'd8:announce11:http://x/ye');
  const zipPath = path.join(config.dirs.btZip, `${SECRET_ZIP}.zip`);
  execFileSync('zip', ['-j', '-q', zipPath, torrentSrc]);

  const extracted = await bt.scanZipUploads();
  assert.equal(extracted, 1, '应该解压出 1 个种子');
  bt.registerPendingSeeds();
  const seed = seedsRepo.all().find((s) => s.name === `${SECRET_TORRENT}.torrent`);
  assert.ok(seed, '种子应入库');
  assert.equal(seed.name, `${SECRET_TORRENT}.torrent`, '数据库里种子名照旧（只有日志脱敏）');

  const task = bt.enqueueSeed(seed);
  assert.equal(task.title, SECRET_TORRENT, '数据库/界面里标题照旧');

  mock.state.name = SECRET_TORRENT;
  mock.state.files = [
    { name: `${SECRET_MOVIE1}.mp4`, length: 5000, bytesCompleted: 0 },
    { name: `${SECRET_MOVIE2}.mkv`, length: 4000, bytesCompleted: 0 },
    { name: `${SECRET_ZIP}.jpg`, length: 100, bytesCompleted: 0 },
  ];
  mock.state.wanted = [1, 1, 1];

  await bt.transmissionModule.prepare(tasksRepo.get(task.id));
  await bt.transmissionModule.start(tasksRepo.get(task.id));
  await bt.transmissionModule.poll(tasksRepo.get(task.id));
  await sleep(200); // 等日志落盘

  assert.equal(tasksRepo.get(task.id).meta.files.length, 2, '只挑视频（两个）');
  assert.match(readLog(), /BT_SELECT|BT_PICK/, '挑片规则的诊断信息要保留');
  assert.match(readLog(), /BT_PREPARE/, '准备阶段日志要保留');
  assertNoSecrets('阶段1');
});

/* ------------------------------------------------------------------ */
/* ② 扫货 → 归档（多文件打 zip）→ 加密 → 发布 → 收尾                     */
/* ------------------------------------------------------------------ */

test('阶段2：扫货/归档/加密/发布/清理 —— 全链路日志无名字', async () => {
  resetTasks();
  fs.rmSync(completeDir, { recursive: true, force: true });
  fs.mkdirSync(completeDir, { recursive: true });

  // 目录名 = 种子名；里面两个视频 → 走"合成一个 zip"分支（zip 的 argv 含所有源文件绝对路径）
  const dir = path.join(completeDir, SECRET_TORRENT);
  writeFile(path.join(dir, `${SECRET_MOVIE1}.mp4`), 300);
  writeFile(path.join(dir, `${SECRET_MOVIE2}.mkv`), 400);
  mock.state.torrents = [{ id: 7, name: SECRET_TORRENT, hashString: 'h1', percentDone: 1 }];
  updateSettings({ btSelect: { smallFileMaxBytes: 100000 }, reserveFreeBytes: 0 });

  const s1 = await btHarvestTick();
  assert.equal(s1.published, 1, '应该产生 1 个发布任务');
  await sleep(120);
  assertNoSecrets('阶段2-扫货');

  await pipelineTick();
  await pipelineTick();
  const created = tasksRepo.list({ pageSize: 500 }).items.find((t) => (t.payload ?? {}).harvest);
  assert.equal(created.status, 'completed', created.error ?? '流水线应发布完成');
  await sleep(120);

  const log = readLog();
  assert.match(log, /MARK:BT_HARVEST/, '扫货日志要保留');
  assert.match(log, /MARK:ARCHIVE/, '归档日志要保留');
  assert.match(log, /MARK:PUBLISH/, '发布日志要保留');
  assert.match(log, /MARK:PROC_SPAWN/, '子进程日志要保留（只是参数被隐藏）');
  assertNoSecrets('阶段2-流水线');

  // 收尾：删 transmission 任务 + 删目录（会广播 space-freed，调度器会把它整段记进日志）
  freedEvents.length = 0;
  const s3 = await btHarvestTick();
  assert.equal(s3.finished, 1, '应该做一次收尾');
  assert.equal(fs.existsSync(dir), false, '目录应被清理');
  await sleep(200);
  assert.ok(freedEvents.length > 0, '清理后应广播 space-freed');
  const freedDump = JSON.stringify(freedEvents);
  for (const s of SECRETS) {
    assert.equal(freedDump.includes(s), false, `space-freed 广播里不该出现 ${s}`);
  }
  assertNoSecrets('阶段2-收尾');
});

/* ------------------------------------------------------------------ */
/* ③ 超时清理（8 小时策略）                                            */
/* ------------------------------------------------------------------ */

test('阶段3：超时清理 —— 日志与 space-freed 广播里没有种子名', async () => {
  resetTasks();
  const dir = path.join(incompleteDir, SECRET_TORRENT);
  writeFile(path.join(dir, `${SECRET_MOVIE1}.mp4`), 500);
  mock.state.torrents = [{ id: 9, name: SECRET_TORRENT, hashString: 'h9', percentDone: 0.1 }];

  const task = tasksRepo.create({
    module: 'transmission',
    title: SECRET_TORRENT,
    platform: 'BT',
    url: null,
    status: 'downloading',
    priority: 0,
    expectBytes: 1000,
    payload: {
      torrentId: 9,
      torrentName: SECRET_TORRENT,
      // 9 小时前交给 transmission 的 → 满 8 小时且进度只有 10% → 清理
      btHandedAt: new Date(Date.now() - 9 * 3600e3).toISOString(),
      downloadDir: dir,
    },
    meta: { files: [`${SECRET_MOVIE1}.mp4`] },
  });

  updateSettings({ btPolicy: { checkAfterHours: 8, minProgressPercent: 60, graceHours: 4 }, reserveFreeBytes: 0 });
  // 这次启动真实的调度器：它会把 space-freed 的 payload 原样写进 SPACE_FREED 日志，
  // 是"payload 里藏名字"这条链路的真实出口（阶段 2 只用事件断言，不启调度器以免干扰后续用例）
  startScheduler();
  const summary = await runBtEvict();
  assert.equal(summary.evicted, 1, '应该判定为超时清理');
  assert.equal(summary.candidates[0].title, SECRET_TORRENT, '给界面看的 summary 里标题照旧');
  assert.equal(tasksRepo.get(task.id).status, 'failed');
  await sleep(200);
  stopScheduler();

  assert.match(readLog(), /BT_TIMEOUT_DROP/, '超时清理日志要保留');
  assert.match(readLog(), /MARK:SPACE_FREED/, '空间回血日志要保留');
  assertNoSecrets('阶段3-超时清理');
});

/* ------------------------------------------------------------------ */
/* ④ RPC 失败：不打印响应体（响应体里含种子名与全部文件名）              */
/* ------------------------------------------------------------------ */

test('阶段4：transmission RPC 失败时不打印响应体', async () => {
  const bad = await startJsonRpcServer(() => ({
    body: {
      result: 'no such torrent',
      arguments: { torrents: [{ name: SECRET_TORRENT, files: [{ name: `${SECRET_MOVIE1}.mp4` }] }] },
    },
  }));
  try {
    const client = new TransmissionClient('127.0.0.1', bad.port);
    await assert.rejects(() => client.call('torrent-get', { ids: [7] }), /transmission 错误/);
  } finally {
    await bad.close();
  }
  await sleep(120);
  assert.match(readLog(), /TR_RPC/, 'RPC 日志要保留');
  assertNoSecrets('阶段4-RPC失败');
});

/* ------------------------------------------------------------------ */
/* ⑤ 任务失败：消息里带文件系统路径（含内容名）时也要脱敏               */
/* ------------------------------------------------------------------ */

test('阶段5：BT 任务失败消息带路径 —— 日志脱敏，任务表保留原文', async () => {
  resetTasks();
  const oldPort = config.transmissionRpc.port;
  // 错误结果里塞一个真实形态的路径；响应体里同样带名字，验证两条都不进日志
  const leaky = `/var/lib/transmission/downloads/${SECRET_TORRENT}/${SECRET_MOVIE1}.mp4`;
  const boom = await startJsonRpcServer((msg) => {
    if (msg.method === 'session-get') return { body: { result: 'success', arguments: { version: '4.0.5-boom' } } };
    return {
      body: {
        result: `ENOENT: no such file or directory, open '${leaky}'`,
        arguments: { torrents: [{ name: SECRET_TORRENT, files: [{ name: `${SECRET_MOVIE1}.mp4` }] }] },
      },
    };
  });
  try {
    // ⚠️ 端口要写进**设置**：BT 客户端现在「设置页优先、回落 .env」，
    //    只改 config（env）是覆盖不掉的（这正是修好的那个 bug）
    updateSettings({ transmissionRpc: { host: '127.0.0.1', port: boom.port, user: 'u', password: 'p' } });
    const task = tasksRepo.create({
      module: 'transmission',
      title: SECRET_TORRENT,
      platform: 'BT',
      url: null,
      status: 'downloading',
      priority: 0,
      expectBytes: 1000,
      payload: { torrentId: 7, torrentName: SECRET_TORRENT },
      meta: { files: [`${SECRET_MOVIE1}.mp4`] },
    });
    updateSettings({ reserveFreeBytes: 0 });
    await schedulerTick();
    await sleep(200);

    // 任务表（界面）里保留真实原因，方便用户自己看
    assert.match(String(tasksRepo.get(task.id).error ?? ''), new RegExp(SECRET_MOVIE1), '任务 error 字段应保留原文');
    assert.match(readLog(), /TASK_RETRY|TASK_FAIL/, '任务失败日志要保留');
    assertNoSecrets('阶段5-任务失败');
  } finally {
    updateSettings({ transmissionRpc: { host: '127.0.0.1', port: oldPort, user: '', password: '' } });
    await boom.close();
  }
});

/* ------------------------------------------------------------------ */
/* ⑥ 导出/诊断报告：任务清单里的 BT 标题也要脱敏（那是要发给开发者的）  */
/* ------------------------------------------------------------------ */

test('阶段6：诊断报告的任务清单里 BT 标题/路径已脱敏，界面仍用真实标题', async () => {
  resetTasks();
  const dir = path.join(completeDir, SECRET_TORRENT);
  writeFile(path.join(dir, `${SECRET_MOVIE1}.mp4`), 10);
  tasksRepo.create({
    module: 'transmission',
    title: SECRET_TORRENT,
    platform: 'BT',
    url: null,
    status: 'downloading',
    priority: 0,
    expectBytes: 10,
    payload: {
      torrentName: SECRET_TORRENT,
      downloadedPaths: [path.join(dir, `${SECRET_MOVIE1}.mp4`)],
      originalName: `${SECRET_MOVIE1}.mp4`,
      publishUnits: [{ files: [path.join(dir, `${SECRET_MOVIE1}.mp4`)], name: `${SECRET_MOVIE1}.mp4` }],
      harvest: { dir, torrentName: SECRET_TORRENT, files: [path.join(dir, `${SECRET_MOVIE1}.mp4`)] },
    },
    meta: { files: [`${SECRET_MOVIE1}.mp4`] },
  });

  const report = tasksReport(50);
  const dump = JSON.stringify(report);
  for (const s of SECRETS) {
    assert.equal(dump.includes(s), false, `导出报告里不该出现 ${s}`);
  }
  // 但数据库里照旧
  const real = tasksRepo.list({ modules: ['transmission'], pageSize: 50 }).items[0];
  assert.equal(real.title, SECRET_TORRENT, '数据库/界面标题不受影响');
});
