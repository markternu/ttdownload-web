/**
 * 磁盘空间驱动的准入算法测试（就是用户描述的那套）
 *
 * 用户的诉求：**并发数不该是限制条件**。只要磁盘还有可用空间，就按「先进先出」
 * 依次把等待队列里的任务放行，直到下一个装不下；等回血（任务完成 → 安卓取走 →
 * 服务端删除）后从队首继续。
 *
 * 算法：
 *     usable = 实际可用 - 预留空间 - 已在跑任务的预留
 *     依次看等待队列（先进先出）：
 *        usable - 这个任务预计占用的空间 >= 0  → 启动它，usable 扣掉，继续下一个
 *        装不下                              → 停在它这里等回血
 *
 * 这个文件把用户举的例子（1G/2G/3G/2G/3.5G/5G/2G/3G…）按比例缩小后跑一遍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupRuntime, startAria2Mock } from './helpers.mjs';

const mock = await startAria2Mock({ workDir: '/tmp' });
// 显式声明"不限并发"，测的就是生产默认行为（测试脚手架默认是 3，会把任务卡住）
const root = setupRuntime({
  reserveFreeBytes: 0,
  env: {
    ARIA2_RPC_PORT: String(mock.port),
    MAX_CONCURRENT: '0',
    CONCURRENCY_TRANSMISSION: '0',
    CONCURRENCY_ARIA2: '0',
    CONCURRENCY_WEBVIDEO: '0',
  },
});

const { tasksRepo } = await import('../dist/core/db.js');
const { schedulerTick } = await import('../dist/core/scheduler.js');
const { updateSettings, defaultSettings } = await import('../dist/services/settings.js');
const { freeBytes } = await import('../dist/core/disk.js');

test.after(async () => {
  await mock.close();
});

const GB = 1024 ** 3;

// 这个文件要"摆布"约 6~8G 的可用空间。若测试根目录所在分区不够（典型：树莓派 /tmp 是
// 1.9G tmpfs），断言会变成毫无意义的失败 —— 明确跳过并告诉怎么修。
const NEEDED = 8 * GB;
const enoughSpace = freeBytes() >= NEEDED;
const spaceHint =
  `本机可用于测试的空间不足（需要 ~${NEEDED / GB}G，当前 ${(freeBytes() / GB).toFixed(1)}G）。` +
  '真机上请把测试根目录指到大分区：TTDL_TEST_ROOT=/home/<user>/.ttdl-test npm run test:only';
/** 空间不足时自动跳过（skip 而不是 fail） */
const testWithSpace = (name, fn) => test(name, { skip: enoughSpace ? false : spaceHint }, fn);
const MB = 1024 ** 2;

/** 把"可用空间"设成指定值：usable = freeBytes() - reserve - reserved，这里只调 reserve */
/** 只调"预留空间"来把可用空间设成指定值（不动并发设置，免得覆盖测试自己的配置）*/
function setUsable(bytes) {
  const free = freeBytes();
  updateSettings({ reserveFreeBytes: Math.max(0, free - bytes) });
}

function waitTask(title, expectBytes, priority = 0) {
  const t = tasksRepo.create({ module: 'aria2', title, platform: 'URL', url: `http://example.com/${encodeURIComponent(title)}`, expectBytes, priority });
  return t;
}

/** 清场：把现存任务都挪出等待/运行态，避免互相干扰 */
function reset() {
  for (const t of tasksRepo.list({ pageSize: 500 }).items) tasksRepo.delete(t.id);
}

const runningTitles = () =>
  tasksRepo
    .byStatus(['downloading', 'parsing'])
    .map((t) => t.title)
    .sort();
const waitingTitles = () =>
  tasksRepo
    .byStatus(['waiting'])
    .map((t) => t.title)
    .sort();

testWithSpace('默认就是"不限并发"：磁盘够就把等待队列里的任务全部放行', () => {
  reset();
  const d = defaultSettings();
  assert.equal(d.maxConcurrent, 0, '全局并发默认 0=不限');
  assert.equal(d.moduleConcurrency.transmission, 0, 'BT 模块并发默认 0=不限');
  assert.equal(d.moduleConcurrency.aria2, 0, '直链模块并发默认 0=不限');
  assert.equal(d.moduleConcurrency.webvideo, 0, '在线视频模块并发默认 0=不限');
});

// 注意：本文件用真实磁盘可用空间做基准，而 node --test 会并行跑其它测试文件（也在写文件），
// 可用空间会有几百 MB 的漂移。所以下面每处的取值都刻意留了 ≥500MB 的余量，不卡在边界上。
testWithSpace('空间驱动的准入：一直放行到装不下为止（先进先出，不跳过）', async () => {
  reset();
  // 排队：1G / 2G / 3G / 3.5G —— 可用 5G
  waitTask('t1-1G', 1 * GB);
  waitTask('t2-2G', 2 * GB);
  waitTask('t3-3G', 3 * GB);
  waitTask('t4-35G', 3.5 * GB);
  setUsable(5.5 * GB); // 1G+2G 起得来（共 3G），剩 2.5G 装不下 3G / 3.5G

  await schedulerTick();

  // 1G 起（剩 4.5G）→ 2G 起（剩 2.5G）→ 3G 装不下跳过 → 3.5G 也装不下跳过
  assert.deepEqual(runningTitles(), ['t1-1G', 't2-2G'].sort(), '起了 1G 和 2G（共 3G，剩 2.5G）');
  assert.deepEqual(waitingTitles(), ['t3-3G', 't4-35G'].sort(), '3G/3.5G 都装不下，继续等回血');

  // 再回一点血：3G 能起来
  setUsable(8.2 * GB);
  await schedulerTick();
  assert.ok(runningTitles().includes('t3-3G'), '空间够了以后 3G 起来');
});

testWithSpace('装不下的跳过，让后面装得下的先跑（不浪费空间）', async () => {
  reset();
  waitTask('big-3G', 3 * GB);
  waitTask('small-100M', 100 * MB);
  setUsable(1 * GB); // 只够 100M

  await schedulerTick();
  assert.deepEqual(runningTitles(), ['small-100M'], '3G 装不下就跳过它，让后面 100M 先跑（空间不许空着）');
  assert.deepEqual(waitingTitles(), ['big-3G'], '3G 继续等回血');

  // 回血到 3.5G：大任务也能起来了
  setUsable(3.5 * GB);
  await schedulerTick();
  assert.deepEqual(runningTitles(), ['big-3G', 'small-100M'].sort(), '回血后 3G 也能起来');
});

testWithSpace('回血后自动继续：任务完成腾出空间 -> 排队的任务被放行', async () => {
  reset();
  const a = waitTask('a-2G', 2 * GB);
  const b = waitTask('b-2G', 2 * GB);
  setUsable(2.5 * GB); // 够起一个 2G，但不够两个（4G）
  await schedulerTick();
  assert.deepEqual(runningTitles(), ['a-2G'], '只起得了一个');
  assert.deepEqual(waitingTitles(), ['b-2G'], '另一个在等');

  // 第一个任务下载完 + 被安卓取走 + 服务端删除 → 它的预留不再占着空间
  tasksRepo.update(a.id, { status: 'completed' });
  await schedulerTick();
  assert.deepEqual(runningTitles(), ['b-2G'], '空间回血后，排队的 b 自动被放行');
  assert.equal(waitingTitles().length, 0, '等待队列清空');
});

testWithSpace('多个模块一起排队时也只看空间，不按模块卡', async () => {
  reset();
  const bt = tasksRepo.create({ module: 'transmission', title: 'bt-1G', platform: 'BT', expectBytes: 1 * GB });
  const ar = waitTask('aria2-2G', 2 * GB);
  const wv = tasksRepo.create({ module: 'webvideo', title: 'wv-2G', platform: 'YouTube', url: 'https://youtu.be/x', expectBytes: 2 * GB });
  setUsable(6 * GB);

  await schedulerTick();
  // transmission 的 start 需要真的 transmission；这里只断言"没被模块并发卡住"
  // （它要么在跑、要么因 transmission 不可用而失败，都不会是 waiting）
  const stillWaiting = waitingTitles();
  assert.ok(!stillWaiting.includes('aria2-2G'), 'aria2 任务应被放行');
  assert.ok(!stillWaiting.includes('wv-2G'), 'webvideo 任务应被放行');
  assert.ok(bt.id > 0 && ar.id > 0 && wv.id > 0);
});

testWithSpace('显式设了并发上限才限制（0 以外才有意义）', async () => {
  reset();
  updateSettings({ maxConcurrent: 2, moduleConcurrency: { transmission: 0, aria2: 0, webvideo: 0 } });
  for (let i = 0; i < 4; i += 1) waitTask(`c${i}-1G`, 1 * GB);
  setUsable(10 * GB); // 空间足够

  await schedulerTick();
  assert.equal(runningTitles().length, 2, '用户显式设了 2，就只起 2 个');
  assert.equal(waitingTitles().length, 2, '其余等待');

  updateSettings({ maxConcurrent: 0 });
  await schedulerTick();
  assert.equal(runningTitles().length, 4, '改回 0=不限后，剩下的也都起来了');
});
