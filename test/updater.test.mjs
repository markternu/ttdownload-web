/**
 * 自动更新（自升级）测试
 *
 * 这里要钉死的行为（都是用户明确要求的）：
 *   ① 版本号规范：只有远端 SemVer 比本地**高**才算"有更新"（用户要求三位规范化 x.y.z）；
 *   ② 开机拉取失败 → **绝不抛异常**，服务照常用本地代码跑（拉不到不能影响启动）；
 *   ③ 版本号没抬的新提交**不自动升级**（防止把没发布的半成品推上线）；
 *   ④ 升级前会暂停下载任务（BT/aria2），并写恢复计划；升级失败时不会把任务卡死（不动 DB 状态）；
 *   ⑤ 不是 git 仓库时如实报"不能自动更新"，而不是假装成功。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime, startTransmissionMock } from './helpers.mjs';

const root = setupRuntime();
const downloadDir = path.join(root, 'transmission', 'downloads', 'Demo');
fs.mkdirSync(downloadDir, { recursive: true });
const mock = await startTransmissionMock({ downloadDir, torrentName: 'Demo' });
process.env.TRANSMISSION_RPC_PORT = String(mock.port);
// 更新源指向一个不存在的 remote：模拟"网络不通/没配凭据"——正是开机拉取失败的场景
process.env.UPDATE_REMOTE = 'no-such-remote';
process.env.UPDATE_BRANCH = 'main';
process.env.UPDATE_BOOT_RETRIES = '2';
process.env.UPDATE_BOOT_RETRY_GAP_MS = '10';
process.env.UPDATE_BOOT_DELAY_SEC = '0';

const { parseSemVer, compareSemVer, isMajorBump } = await import('../dist/core/version.js');
const { tasksRepo } = await import('../dist/core/db.js');
const updater = await import('../dist/services/updater.js');
const { readPackageVersionFromText } = updater;
const { config } = await import('../dist/core/config.js');
const { createApp } = await import('../dist/app.js');

test.after(async () => {
  await mock.close();
});

/* ------------------------------ 版本号规范 ------------------------------ */

test('SemVer 解析：三位必须写全，混乱写法一律判为非法（不猜）', () => {
  assert.deepEqual(parseSemVer('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: '', raw: '1.2.3' });
  assert.deepEqual(parseSemVer('v2.0.0'), { major: 2, minor: 0, patch: 0, prerelease: '', raw: 'v2.0.0' });
  assert.equal(parseSemVer('1.2.3-beta.1')?.prerelease, 'beta.1');
  for (const bad of ['1.2', '1', 'v1.2', 'abc', '', null, undefined, '1.2.3.4']) {
    assert.equal(parseSemVer(bad), null, `${String(bad)} 不该被当成合法版本号`);
  }
});

test('版本比较遵循 SemVer：主 > 次 > 修订；预发布小于同号正式版', () => {
  assert.equal(compareSemVer('1.1.0', '1.0.9'), 1);
  assert.equal(compareSemVer('1.0.1', '1.1.0'), -1);
  assert.equal(compareSemVer('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemVer('2.0.0', '1.99.99'), 1);
  assert.equal(compareSemVer('1.2.0-beta.1', '1.2.0'), -1, '预发布版不能算比正式版新');
  assert.equal(compareSemVer('1.0.0', '不是版本号'), 1, '解析不了的排最后');
});

test('isMajorBump：只有主版本变了才算"大版本升级"（页面要提醒不兼容）', () => {
  assert.equal(isMajorBump('1.4.2', '2.0.0'), true);
  assert.equal(isMajorBump('1.4.2', '1.5.0'), false);
  assert.equal(isMajorBump('1.4.2', '1.4.3'), false);
});

test('远端版本从 package.json 文本里读（升级脚本/检查都用它）', () => {
  assert.equal(readPackageVersionFromText('{"name":"x","version":"3.4.5"}'), '3.4.5');
  assert.equal(readPackageVersionFromText('{"version":"v1.0.0"}'), '1.0.0');
  assert.equal(readPackageVersionFromText('{"version":"1.2"}'), null, '不合法就是 null，别乱猜');
  assert.equal(readPackageVersionFromText('不是 JSON'), null);
});

test('本地版本 = package.json 的版本（唯一来源，且必须是三位 SemVer）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(config.rootDir, 'package.json'), 'utf8'));
  assert.equal(config.version, pkg.version, 'config.version 必须等于 package.json 的 version');
  assert.ok(parseSemVer(pkg.version), `package.json 的 version 必须符合 x.y.z 规范，实际 ${pkg.version}`);
});

/* --------------------------- 开机拉取失败不影响启动 --------------------------- */

test('【开机】远端拉不到：checkForUpdate 不抛异常，如实记错误，服务照常可用', async () => {
  const st = await updater.checkForUpdate();
  assert.ok(st.error, '拉取失败要如实报出来（不能假装成功）');
  assert.equal(st.versionNewer, false, '拉不到远端就等于没有更新');
  assert.equal(st.available, false);
  assert.equal(st.currentVersion, config.version);
  assert.ok(st.checkedAt, '要记录检查时间，页面才能显示"上次检查"');
});

test('【开机】拉取失败也必须能起 HTTP 服务（更新检查永远在 listen 之后）', async () => {
  // 这里直接用 app 起一个真实端口，模拟"开机时网络不通"下服务仍然可用
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, config.version, '/api/health 要报出规范化后的版本号');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('【开机】bootCheck 静默失败：拉不到就用本地代码跑，不抛异常', async () => {
  // 不 await 定时器、直接跑一次开机检查；它内部会重试 2 次后放弃
  await updater.__testBootCheck();
  const st = updater.getUpdateStatus();
  assert.equal(st.currentVersion, config.version);
  assert.ok(st.error, '开机拉取失败的原因要留在状态里给用户看');
});

/* ------------------------------ 升级前置判断 ------------------------------ */

test('版本号没抬的新提交不自动升级（规范：发布必须抬版本号）', () => {
  const st = {
    ...updater.getUpdateStatus(),
    repoReady: true,
    versionNewer: false,
    versionUnchanged: true,
    behind: 3,
    latestVersion: config.version,
  };
  const auto = updater.canApply(st, { manual: false });
  assert.equal(auto.ok, false, '自动模式必须拒绝"版本没抬但有新提交"');
  assert.match(String(auto.reason), /版本号/);
});

test('远端版本更高时允许自动升级；已经最新则拒绝', () => {
  const base = updater.getUpdateStatus();
  const newer = { ...base, repoReady: true, versionNewer: true, versionUnchanged: false, behind: 2, latestVersion: '99.0.0' };
  const r = updater.canApply(newer, { manual: false });
  // 本机开发目录就是 git 仓库、升级脚本也在，所以这里应当放行
  assert.equal(r.ok, true, `应当允许升级，实际被拒：${r.reason ?? ''}`);
  assert.ok(r.command?.endsWith('self-update.sh'));

  const same = { ...base, repoReady: true, versionNewer: false, versionUnchanged: false, available: false, behind: 0, latestVersion: config.version };
  assert.equal(updater.canApply(same, { manual: false }).ok, false);
  assert.equal(updater.canApply(same, { manual: true }).ok, false, '手动也不能"升级"到同一个版本');
});

test('不是 git 仓库时如实报错（不假装能升级）', () => {
  const st = { ...updater.getUpdateStatus(), repoReady: false, versionNewer: true, available: true, behind: 1 };
  const r = updater.canApply(st, { manual: true });
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /git/);
});

/* ------------------------------ 暂停 / 恢复 ------------------------------ */

test('升级前暂停下载：BT 种子被 torrent-stop，并写下恢复计划；数据库状态不动', async () => {
  const bt = await import('../dist/modules/transmission.js');
  const { seedsRepo } = await import('../dist/core/db.js');
  const { tmpFile } = await import('./helpers.mjs');
  const fake = tmpFile(root, 'src/upd.torrent', 'd8:announce11:http://x/ye');
  fs.copyFileSync(fake, path.join(config.dirs.btPending, 'upd.torrent'));
  bt.registerPendingSeeds();
  const seed = seedsRepo.all().find((s) => s.name === 'upd.torrent');
  const task = bt.enqueueSeed(seed);
  await bt.transmissionModule.prepare(tasksRepo.get(task.id));
  await bt.transmissionModule.start(tasksRepo.get(task.id));
  const torrentId = Number((tasksRepo.get(task.id).payload ?? {}).torrentId);
  assert.ok(torrentId > 0);

  const plan = await updater.pauseDownloads();
  assert.ok(plan.torrentIds.includes(torrentId), `恢复计划里要有种子 ${torrentId}，实际 ${JSON.stringify(plan.torrentIds)}`);
  assert.ok(mock.state.stopped.includes(torrentId), '要向 transmission 发 torrent-stop');
  assert.equal(tasksRepo.get(task.id).status, 'downloading', '⚠️ 数据库状态必须保持 downloading（回滚到老代码也能自愈）');
  assert.ok(fs.existsSync(path.join(config.dirs.state, 'update-resume.json')), '恢复计划要落盘');

  await updater.resumeAfterUpdate();
  assert.ok(mock.state.started.includes(torrentId), '恢复时要 torrent-start 回来');
  assert.equal(fs.existsSync(path.join(config.dirs.state, 'update-resume.json')), false, '恢复完要删掉计划文件');
});

test('没有恢复计划时 resumeAfterUpdate 什么都不做（不能凭空 start 一堆种子）', async () => {
  const before = mock.state.started.length;
  await updater.resumeAfterUpdate();
  assert.equal(mock.state.started.length, before);
});

/* ------------------------------ 状态与页面接口 ------------------------------ */

test('状态对象包含页面需要的字段（版本/提交/是否可升级/日志/自动更新开关）', () => {
  const st = updater.getUpdateStatus();
  for (const key of [
    'currentVersion', 'latestVersion', 'currentCommit', 'latestCommit', 'behind',
    'available', 'versionNewer', 'majorBump', 'versionUnchanged', 'commits',
    'remote', 'branch', 'repoReady', 'checkedAt', 'error', 'phase', 'message',
    'lastResult', 'logTail', 'autoEnabled', 'intervalMin', 'bootDelaySec', 'serviceName', 'activeTasks',
  ]) {
    assert.ok(key in st, `更新状态缺少字段 ${key}`);
  }
  assert.equal(typeof st.autoEnabled, 'boolean');
  assert.equal(st.remote, 'no-such-remote');
  assert.equal(st.branch, 'main');
});

test('升级脚本存在且是可执行的 bash（页面按钮点了要真能跑起来）', () => {
  const script = path.join(config.rootDir, 'deploy', 'scripts', 'self-update.sh');
  assert.ok(fs.existsSync(script), `缺少 ${script}`);
  const head = fs.readFileSync(script, 'utf8').split('\n')[0];
  assert.match(head, /^#!.*bash/);
  assert.ok(fs.statSync(script).mode & 0o100, '要有可执行权限');
});

test('applyUpdate 的前置判断：有脚本、是 git 仓库、版本更高 → 放行（真实重启不在单测里跑）', () => {
  const st = updater.getUpdateStatus();
  const newer = { ...st, repoReady: true, versionNewer: true, versionUnchanged: false, available: true, behind: 1, latestVersion: '99.0.0', latestCommit: 'abcdef1' };
  const decision = updater.canApply(newer, { manual: false });
  assert.equal(decision.ok, true, `应当允许升级，实际被拒：${decision.reason ?? ''}`);
  assert.ok(decision.command?.includes('self-update.sh'));
  // ⚠️ 这里刻意**不**调用 applyUpdate 本体：它会真的拉起升级脚本并重启服务，单测里跑不起。
  assert.equal(updater.getUpdateStatus().currentVersion, config.version, '本地版本不应被改动');
});
