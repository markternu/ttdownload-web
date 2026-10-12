/**
 * 「扫描与清理垃圾」测试。
 *
 * 安全是这一版的重中之重，用例要钉死这些：
 *   ① 只把**真的垃圾**（临时/半成品）扫出来，正在下载/已归档的成品绝不进垃圾清单；
 *   ② 「疑似孤儿成品」只报告、不放进一键清理；
 *   ③ 删除前逐个白名单校验 —— 白名单之外、符号链接，一律不删；
 *   ④ 清理只删用户勾选的类别，其余不动。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime, startAria2Mock } from './helpers.mjs';

const mock = await startAria2Mock({ workDir: '/tmp' });
const root = setupRuntime({ env: { ARIA2_RPC_PORT: String(mock.port) } });

const { config } = await import('../dist/core/config.js');
const { filesRepo, tasksRepo } = await import('../dist/core/db.js');
const { scanJunk, cleanFromReport } = await import('../dist/services/junkScan.js');

const old = (ms) => new Date(Date.now() - ms);
const mk = (dir, name, content = 'x') => {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
};
const age = (p, ms) => fs.utimesSync(p, old(ms), old(ms));

test.after(async () => {
  await mock.close();
});

test('【识别】能扫出各类垃圾：aria2 控制文件、yt-dlp 分片、解密/加密临时、打包暂存、临时 zip', async () => {
  // aria2 残留：孤儿 .aria2 + 配套半成品（不在 aria2 实时任务里）
  const orphanBase = mk(config.dirs.aria2, 'orphan.bin', 'partial-data');
  mk(config.dirs.aria2, 'orphan.bin.aria2', 'ctl');
  age(orphanBase, 2 * 3600_000);

  // yt-dlp 分片（>6h）
  const ytdlp = mk(config.dirs.webTools, 'video.part', 'partial');
  age(ytdlp, 7 * 3600_000);

  // 解密临时（>1h）
  const origTmp = path.join(config.dirs.state, 'original-tmp');
  const ot = mk(origTmp, 'abc123.part', 'decrypted-stuff');
  age(ot, 2 * 3600_000);

  // 加密临时（>6h）
  const enc = mk(config.dirs.encryptTmp, 'leftover.data', 'enc');
  age(enc, 8 * 3600_000);

  // 打包暂存目录（>1h）—— 注意 age 的是**目录**本身
  const zipstageDir = path.join(config.dirs.state, 'zipstage_test_1');
  mk(zipstageDir, 'inner.bin', 'zip-part');
  age(zipstageDir, 2 * 3600_000);

  // 归档临时 zip（>1h）
  const tmpzip = mk(config.dirs.archiveReady, '.tmp_movie.zip', 'zippart');
  age(tmpzip, 2 * 3600_000);

  const report = await scanJunk();
  const byKey = (k) => report.categories.find((c) => c.key === k);

  assert.ok(byKey('aria2').items.some((i) => i.name === 'orphan.bin.aria2'), '要扫出孤儿 .aria2');
  assert.ok(byKey('aria2').items.some((i) => i.name === 'orphan.bin'), '要扫出配套半成品');
  assert.ok(byKey('ytdlp').items.some((i) => i.name === 'video.part'));
  assert.ok(byKey('original_tmp').items.some((i) => i.name === 'abc123.part'));
  assert.ok(byKey('encrypt_tmp').items.some((i) => i.name === 'leftover.data'));
  assert.ok(byKey('zipstage').items.some((i) => i.name === 'zipstage_test_1'));
  assert.ok(byKey('archive_tmpzip').items.some((i) => i.name === '.tmp_movie.zip'));

  assert.ok(report.junkBytes > 0);
  assert.ok(report.breakdown.some((b) => b.dir === config.dirs.consumer));
  // 文件清单（只读）也要带出来，让用户看清目录里到底有哪些文件
  const aria2Listing = report.fileListing.find((l) => l.dir === config.dirs.aria2);
  assert.ok(aria2Listing, '要有关键目录的文件清单');
  assert.ok(aria2Listing.files.some((f) => f.name === 'orphan.bin'), '文件清单里要能看见具体文件名');
});

test('【不误删】正在下载的 aria2 文件 / 正在跑的任务引用 / 刚写完的临时文件 都不进垃圾', async () => {
  // 一个"还活着"的 aria2 任务（mock 里注册过 → tellActive 会报它）
  const liveTask = tasksRepo.create({ module: 'aria2', title: 'live.bin', platform: 'URL', url: 'https://x/live.bin' });
  const { aria2Module } = await import('../dist/modules/aria2.js');
  await aria2Module.start(liveTask);
  const liveGid = String(tasksRepo.get(liveTask.id).payload.gid);
  const liveFile = mock.state.tasks.get(liveGid).file;
  // 它的 .aria2 控制文件也"活着"
  fs.writeFileSync(liveFile + '.aria2', 'ctl');

  // 一个刚写完的 yt-dlp 分片（<6h，可能还在写）
  const fresh = mk(config.dirs.webTools, 'fresh.part', 'fresh');
  age(fresh, 5 * 60_000);

  const report = await scanJunk();
  const aria2 = report.categories.find((c) => c.key === 'aria2');
  const ytdlp = report.categories.find((c) => c.key === 'ytdlp');
  assert.ok(!aria2.items.some((i) => path.resolve(i.path) === path.resolve(liveFile)), '活着的下载文件不能进垃圾');
  assert.ok(!aria2.items.some((i) => path.resolve(i.path) === path.resolve(liveFile + '.aria2')), '活着的控制文件不能进垃圾');
  assert.ok(!ytdlp.items.some((i) => i.name === 'fresh.part'), '刚写过的分片不能当垃圾');
});

test('【孤儿成品】consumer/archiveReady 里数据库没记录的文件：只报告、不自动删', async () => {
  mk(config.dirs.consumer, 'not-in-db', 'real-product?');
  const report = await scanJunk();
  const cat = report.categories.find((c) => c.key === 'orphan');
  assert.ok(cat, '要有「疑似孤儿成品」这个分类');
  assert.equal(cat.autoClean, false, '必须只报告，不自动删');
  assert.ok(cat.items.some((i) => i.name === 'not-in-db'));

  // 它不计入"可一键清理"的总量（junkBytes 只算 autoClean 的）
  const autoCleanBytes = report.categories.filter((c) => c.autoClean && !c.skipped).reduce((n, c) => n + c.totalBytes, 0);
  assert.equal(report.junkBytes, autoCleanBytes);
  // 即使手动把它加进清理列表，cleanFromReport 也不会删（autoClean=false 被忽略）
  const r = cleanFromReport(report, ['orphan']);
  assert.equal(r.deleted, 0, '报告类别的项目不许被一键清理');
  assert.ok(fs.existsSync(path.join(config.dirs.consumer, 'not-in-db')), '孤儿成品不能被删');
});

test('【清理】只删勾选的类别；白名单之外与符号链接一律不删', async () => {
  // 造两类垃圾 + 一个白名单外的"垃圾"（不该被删）+ 一个符号链接（不该被跟）
  const ariaJunk = mk(config.dirs.aria2, 'clean-me.bin', 'data');
  mk(config.dirs.aria2, 'clean-me.bin.aria2', 'ctl');
  age(ariaJunk, 3 * 3600_000);
  const ytJunk = mk(config.dirs.webTools, 'clean-me.part', 'partial');
  age(ytJunk, 9 * 3600_000);

  const outside = path.join(root, 'outside-junk.bin');
  fs.writeFileSync(outside, 'outside');
  const symlink = path.join(config.dirs.webTools, 'link.part');
  fs.symlinkSync(outside, symlink);
  age(symlink, 9 * 3600_000);

  const report = await scanJunk();

  // 只勾选 aria2 类 → yt-dlp 垃圾要留着
  const r = cleanFromReport(report, ['aria2']);
  assert.ok(r.deleted >= 1, '要删掉 aria2 的垃圾');
  assert.ok(!fs.existsSync(ariaJunk), '配套半成品应被删');
  assert.ok(fs.existsSync(ytJunk), '没勾选的 yt-dlp 类不能动');

  // 符号链接与白名单外文件：删 ytdlp 类时也不能碰它们
  const r2 = cleanFromReport(report, ['ytdlp']);
  assert.ok(fs.existsSync(outside), '白名单外的文件绝不能删');
  assert.ok(fs.lstatSync(symlink).isSymbolicLink(), '符号链接绝不能跟过去删');
});
