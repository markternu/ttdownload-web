/**
 * 公开视频URL（webvideo）模块 测试：使用假的 yt-dlp 可执行文件
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime, tmpFile } from './helpers.mjs';

const root = setupRuntime();

// 构造一个假的 yt-dlp：-J 输出元数据；下载时输出进度并写出文件
const fakeBin = path.join(root, 'bin', 'yt-dlp');
fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
fs.writeFileSync(
  fakeBin,
  `#!/bin/bash
if [ "$1" = "--version" ]; then echo "2024.01.01"; exit 0; fi
if [ "$1" = "-J" ]; then
  cat <<'JSON'
{"title":"测试视频 Demo","uploader":"测试作者","duration":93,"thumbnail":"http://x/t.jpg","formats":[
 {"format_id":"137","ext":"mp4","resolution":"1080p","height":1080,"vcodec":"avc1","acodec":"none","filesize":235000000},
 {"format_id":"22","ext":"mp4","resolution":"720p","height":720,"vcodec":"avc1","acodec":"mp4a","filesize":120000000}
]}
JSON
  exit 0
fi
OUT=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then OUT="$a"; fi
  prev="$a"
done
DIR=$(dirname "$OUT")
[ -z "$OUT" ] && exit 0
mkdir -p "$DIR"
echo "[download] Destination: $DIR/mockvideo.mp4"
echo "PROG 500000 1000000 2048 5"
sleep 0.2
echo "PROG 1000000 1000000 0 NA"
echo "fake video content" > "$DIR/mockvideo.mp4"
exit 0
`,
  { mode: 0o755 },
);

process.env.YTDLP_BIN = fakeBin;

/* ------------------------------------------------------------------ */
/* 「想尽办法」策略阶梯用的假 yt-dlp：前 N 次失败（模拟会员专享报错），之后成功 */
/* ------------------------------------------------------------------ */

const MEMBERS_ERROR =
  "ERROR: [youtube] f6kl3G_ek-A: This video is available to this channel's members on level: 高级VIP会员（人工咨询服务） (or any higher level). Join this channel to get access to members-only content and other exclusive perks.";

const ladderCalls = path.join(root, 'ladder-calls.log');
const ladderCount = path.join(root, 'ladder-count');
const ladderBin = path.join(root, 'bin', 'yt-dlp-ladder');
fs.writeFileSync(
  ladderBin,
  `#!/bin/bash
if [ "$1" = "--version" ]; then echo "2024.01.01"; exit 0; fi
echo "ARGS: $*" >> "$LADDER_CALLS"
if [ "$1" = "-J" ]; then
  if [ -n "$LADDER_PARSE_FAIL" ]; then
    echo "$LADDER_MEMBERS_ERROR" >&2
    exit 1
  fi
  echo '{"title":"阶梯测试视频","uploader":"作者","duration":10,"thumbnail":null,"formats":[{"format_id":"18","ext":"mp4","resolution":"360p","height":360,"vcodec":"avc1","acodec":"mp4a","filesize":1000}]}'
  exit 0
fi
OUT=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then OUT="$a"; fi
  prev="$a"
done
[ -z "$OUT" ] && exit 0
N=$(cat "$LADDER_COUNT" 2>/dev/null || echo 0)
N=$((N + 1))
echo "$N" > "$LADDER_COUNT"
if [ "$N" -le "\${LADDER_FAIL_TIMES:-0}" ]; then
  echo "\${LADDER_DOWNLOAD_ERROR:-$LADDER_MEMBERS_ERROR}" >&2
  exit 1
fi
DIR=$(dirname "$OUT")
mkdir -p "$DIR"
echo "ladder video content" > "$DIR/ladder.mp4"
echo "PROG 100 100 0 NA"
exit 0
`,
  { mode: 0o755 },
);

function resetLadder({ failTimes = 0, parseFail = '' } = {}) {
  fs.writeFileSync(ladderCalls, '');
  fs.writeFileSync(ladderCount, '0');
  process.env.LADDER_CALLS = ladderCalls;
  process.env.LADDER_COUNT = ladderCount;
  process.env.LADDER_MEMBERS_ERROR = MEMBERS_ERROR;
  process.env.LADDER_FAIL_TIMES = String(failTimes);
  process.env.LADDER_PARSE_FAIL = parseFail;
  config.bins.ytdlp = ladderBin;
}

async function runWebvideoTask({ url = 'https://www.youtube.com/watch?v=f6kl3G_ek-A', payload = {} } = {}) {
  const task = tasksRepo.create({ module: 'webvideo', title: 'x', platform: 'YouTube', url, payload });
  await webvideo.webvideoModule.prepare(tasksRepo.get(task.id));
  await webvideo.webvideoModule.start(tasksRepo.get(task.id));
  let result = null;
  for (let i = 0; i < 60; i += 1) {
    result = await webvideo.webvideoModule.poll(tasksRepo.get(task.id));
    if (result.done || result.error) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  return { taskId: task.id, result };
}

const ladderAllCalls = () =>
  fs
    .readFileSync(ladderCalls, 'utf8')
    .split('\n')
    .filter((l) => l.includes('ARGS:'));

const ladderArgs = () =>
  fs
    .readFileSync(ladderCalls, 'utf8')
    .split('\n')
    .filter((l) => l.includes('ARGS:') && !/-J\b/.test(l) && !l.includes('--version'));

const { config } = await import('../dist/core/config.js');
const { tasksRepo } = await import('../dist/core/db.js');
const webvideo = await import('../dist/modules/webvideo.js');
const { handoffToArchive, pipelineTick } = await import('../dist/services/pipeline.js');

test('平台识别', () => {
  assert.equal(webvideo.detectPlatform('https://www.youtube.com/watch?v=abc'), 'YouTube');
  assert.equal(webvideo.detectPlatform('https://www.bilibili.com/video/BV1xx'), 'Bilibili');
  assert.equal(webvideo.detectPlatform('https://v.douyin.com/abc/'), '抖音');
  assert.equal(webvideo.detectPlatform('https://example.com/v.mp4'), 'example.com');
});

test('解析视频元数据（标题/时长/作者/格式清单）', async () => {
  const meta = await webvideo.parseVideo('https://www.youtube.com/watch?v=abc');
  assert.equal(meta.title, '测试视频 Demo');
  assert.equal(meta.platform, 'YouTube');
  assert.equal(meta.durationSec, 93);
  assert.equal(meta.author, '测试作者');
  assert.equal(meta.formats.length, 2);
  assert.match(meta.formats[0].label, /1080p/);
  assert.equal(meta.defaultFormatId, '137');
});

test('错误信息人性化（中文可读）', () => {
  assert.match(webvideo.humanizeYtDlpError('ERROR: Unsupported URL: http://x'), /不支持/);
  assert.match(webvideo.humanizeYtDlpError('ERROR: Video unavailable'), /不可访问/);
  assert.match(webvideo.humanizeYtDlpError('ERROR: Private video'), /私有/);
  assert.match(webvideo.humanizeYtDlpError('ERROR: DRM protected'), /DRM/);
});

test('webvideo 任务：解析 -> 下载 -> 完成 -> 归档发布', async () => {
  const task = tasksRepo.create({
    module: 'webvideo',
    title: '测试视频 Demo',
    platform: 'YouTube',
    url: 'https://www.youtube.com/watch?v=abc',
    payload: { formatId: '137' },
  });
  await webvideo.webvideoModule.prepare(tasksRepo.get(task.id));
  const prepared = tasksRepo.get(task.id);
  assert.equal(prepared.expectBytes, 235000000);
  assert.equal(prepared.meta.resolution, '1080p');
  assert.equal(prepared.meta.author, '测试作者');

  await webvideo.webvideoModule.start(tasksRepo.get(task.id));
  assert.equal(tasksRepo.get(task.id).status, 'downloading');

  // 等进程结束并轮询
  await new Promise((r) => setTimeout(r, 1200));
  let result = null;
  for (let i = 0; i < 20; i += 1) {
    result = await webvideo.webvideoModule.poll(tasksRepo.get(task.id));
    if (result.done || result.error) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(result.done, result.error ?? '应完成');
  assert.equal(fs.existsSync(result.done.files[0]), true);
  assert.match(path.basename(result.done.files[0]), /mockvideo/);

  handoffToArchive(task.id, result.done.files, result.done.originalName, result.done.sizeBytes);
  await pipelineTick();
  await pipelineTick();
  const doneTask = tasksRepo.get(task.id);
  assert.equal(doneTask.status, 'completed', doneTask.error ?? '');
  assert.equal(fs.existsSync(path.join(config.dirs.consumer, doneTask.publishedName)), true);
});

test('缺少 yt-dlp 时给出安装提示（中文）', async () => {
  const badTask = tasksRepo.create({ module: 'webvideo', title: 'x', platform: 'YouTube', url: 'https://youtu.be/x', payload: {} });
  const badBin = path.join(root, 'bin', 'not-exists-ytdlp');
  const orig = config.bins.ytdlp;
  config.bins.ytdlp = badBin;
  await assert.rejects(() => webvideo.webvideoModule.start(tasksRepo.get(badTask.id)), /yt-dlp/);
  config.bins.ytdlp = orig;
});

/* ------------------------------------------------------------------ */
/* 会员专享 / 需登录：不再直接放弃，走「多方式尽力下载」                  */
/* ------------------------------------------------------------------ */

test('会员专享报错被识别成可操作中文提示（不再出现“不绕过登录限制”）', () => {
  const msg = webvideo.humanizeYtDlpError(MEMBERS_ERROR);
  assert.match(msg, /频道会员专享/);
  assert.match(msg, /cookies/);
  assert.equal(msg.includes('不绕过'), false, '不应再出现“不绕过登录限制”这种放弃式提示');
  assert.equal(msg.startsWith('下载失败：ERROR'), false, '应被专门识别，而不是落到兜底文案');
});

test('策略阶梯：前 3 种方式失败后自动换第 4 种并成功（任务最终完成）', async () => {
  resetLadder({ failTimes: 3 });
  const { taskId, result } = await runWebvideoTask();
  assert.ok(result.done, result.error ?? '应在多次尝试后成功');
  assert.match(path.basename(result.done.files[0]), /ladder/);

  const calls = ladderArgs();
  assert.ok(calls.length >= 3, `至少应尝试 3 次，实际 ${calls.length}`);
  // 解析成功后会带上「指定格式」这一档，因此按顺序关系断言而不是写死下标
  assert.match(calls[0], /-f 18\+ba\/18/, '第 1 种方式：用户/解析选定的格式');
  const iMulti = calls.findIndex((c) => c.includes('--extractor-args youtube:player_client'));
  const iRetry = calls.findIndex((c) => c.includes('--retries 20'));
  const iPlain = calls.findIndex((c) => c.includes('-f bv*+ba/b') && !c.includes('--extractor-args') && !c.includes('--retries 20'));
  assert.ok(iPlain > 0, '应包含「最佳画质」这一档');
  assert.ok(iMulti > iPlain, '多客户端回退应排在最佳画质之后');
  assert.ok(iRetry > iMulti, '长重试应排在多客户端之后');
  assert.equal(fs.readFileSync(ladderCount, 'utf8').trim(), '4', '第 4 次下载尝试应成功（长重试那一档）');
  assert.ok(taskId > 0);
});

test('策略阶梯：全部方式都失败时才判失败，并说明试过哪些方式', async () => {
  resetLadder({ failTimes: 999 });
  const { result } = await runWebvideoTask();
  assert.ok(result.error, '应返回错误');
  assert.match(result.error, /频道会员专享/);
  assert.match(result.error, /已自动尝试 \d+ 种方式/);
  assert.match(result.error, /仅音频（保底）/);
  const calls = ladderArgs();
  assert.ok(calls.length >= 8, `应把阶梯里的方式都试一遍，实际 ${calls.length}`);
});

test('解析阶段遇到会员限制不再直接判任务失败（prepare 容错）', async () => {
  resetLadder({ failTimes: 0, parseFail: '1' });
  const task = tasksRepo.create({
    module: 'webvideo',
    title: 'x',
    platform: 'YouTube',
    url: 'https://www.youtube.com/watch?v=f6kl3G_ek-A',
    payload: {},
  });
  await webvideo.webvideoModule.prepare(tasksRepo.get(task.id)); // 不应抛错
  const prepared = tasksRepo.get(task.id);
  assert.equal(prepared.status, 'waiting');
  assert.match(String(prepared.payload.parseError ?? ''), /频道会员专享/);

  // 解析失败也照样去下载：这次让下载成功
  process.env.LADDER_PARSE_FAIL = '';
  await webvideo.webvideoModule.start(prepared);
  let result = null;
  for (let i = 0; i < 60; i += 1) {
    result = await webvideo.webvideoModule.poll(tasksRepo.get(task.id));
    if (result.done || result.error) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(result.done, result.error ?? '解析失败但下载应成功');
  tasksRepo.update(task.id, { status: 'completed' });
});

test('配上 cookies 后，会带登录态优先尝试（会员视频的关键一步）', async () => {
  resetLadder({ failTimes: 0 });
  const cookiesFile = path.join(root, 'state', 'cookies.txt');
  fs.mkdirSync(path.dirname(cookiesFile), { recursive: true });
  fs.writeFileSync(cookiesFile, '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc\n');
  const { updateSettings, getSettings } = await import('../dist/services/settings.js');
  const before = { ...getSettings() };
  updateSettings({ webvideoCookiesFile: cookiesFile });

  const labels = webvideo
    .buildDownloadAttempts({ formatId: '', cookiesFile, cookiesFromBrowser: '', isYouTube: true })
    .map((a) => a.label);
  assert.match(labels[0], /登录态/);
  assert.equal(labels.some((l) => l.includes('多客户端')), true);

  const { taskId, result } = await runWebvideoTask();
  assert.ok(result.done, result.error ?? '带 cookies 应能下载');
  assert.match(ladderArgs()[0], /--cookies/, '第一次尝试就应带上 --cookies');

  assert.ok(
    ladderAllCalls().some((l) => /-J\b/.test(l) && l.includes('--cookies')),
    '解析（-J）阶段也应带上 --cookies，否则会员视频连元数据都拿不到',
  );

  const status = await webvideo.cookiesStatus();
  assert.equal(status.exists, true);
  assert.equal(status.cookiesFile, cookiesFile);
  assert.ok(status.sizeBytes > 0);
  updateSettings({ webvideoCookiesFile: before.webvideoCookiesFile });
  config.bins.ytdlp = fakeBin;
  tasksRepo.update(taskId, { status: 'completed' });
});

test('额外参数解析（支持引号）与生效', async () => {
  assert.deepEqual(webvideo.parseExtraArgs('--proxy socks5://127.0.0.1:1080'), ['--proxy', 'socks5://127.0.0.1:1080']);
  assert.deepEqual(webvideo.parseExtraArgs('--user-agent "Mozilla/5.0 X" -v'), ['--user-agent', 'Mozilla/5.0 X', '-v']);
  assert.deepEqual(webvideo.parseExtraArgs('   '), []);

  resetLadder({ failTimes: 0 });
  const { updateSettings, getSettings } = await import('../dist/services/settings.js');
  const before = { ...getSettings() };
  updateSettings({ webvideoExtraArgs: '--proxy socks5://127.0.0.1:1080' });
  const { taskId, result } = await runWebvideoTask();
  assert.ok(result.done, result.error ?? '应完成');
  assert.match(ladderArgs()[0], /--proxy socks5:\/\/127\.0\.0\.1:1080/, '额外参数应追加到 yt-dlp 下载调用');
  assert.ok(
    ladderAllCalls().some((l) => /-J\b/.test(l) && l.includes('--proxy socks5://127.0.0.1:1080')),
    '额外参数（如代理）也应作用于解析调用',
  );
  updateSettings({ webvideoExtraArgs: before.webvideoExtraArgs });
  config.bins.ytdlp = fakeBin;
  tasksRepo.update(taskId, { status: 'completed' });
});

test('会员/登录类失败走“自动重试”耗尽次数才失败；DRM 等真永久错误才立即判失败', async () => {
  const { schedulerTick } = await import('../dist/core/scheduler.js');
  const { getSettings, updateSettings } = await import('../dist/services/settings.js');
  const prevAutoRetry = getSettings().autoRetry;
  updateSettings({ autoRetry: 5, webvideoCookiesFile: '' });

  const waitForSettle = async (id) => {
    let t = tasksRepo.get(id);
    for (let i = 0; i < 200; i += 1) {
      await schedulerTick();
      t = tasksRepo.get(id);
      if (t.status === 'failed' || t.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 60));
    }
    return t;
  };

  // 1) 会员专享：不是永久错误 -> 会一直自动重试，直到用满 autoRetry 才判失败
  resetLadder({ failTimes: 999 });
  const members = tasksRepo.create({
    module: 'webvideo',
    title: '会员视频',
    platform: 'YouTube',
    url: 'https://www.youtube.com/watch?v=f6kl3G_ek-A',
    payload: {},
  });
  const membersAfter = await waitForSettle(members.id);
  assert.equal(membersAfter.status, 'failed');
  assert.equal(Number(membersAfter.retryCount ?? 0), 5, '会员/登录错误应走满 5 次自动重试（而非一上来就永久失败）');
  assert.match(String(membersAfter.error ?? ''), /频道会员专享/);

  // 2) DRM：真·永久错误 -> 不重试，直接失败
  resetLadder({ failTimes: 999 });
  process.env.LADDER_DOWNLOAD_ERROR = 'ERROR: This video is DRM protected and cannot be downloaded';
  const drm = tasksRepo.create({
    module: 'webvideo',
    title: 'DRM 视频',
    platform: 'YouTube',
    url: 'https://www.youtube.com/watch?v=drm',
    payload: {},
  });
  const drmAfter = await waitForSettle(drm.id);
  assert.equal(drmAfter.status, 'failed');
  assert.equal(Number(drmAfter.retryCount ?? 0), 0, 'DRM 属于真永久错误，不应浪费重试次数');
  assert.match(String(drmAfter.error ?? ''), /DRM/);

  delete process.env.LADDER_DOWNLOAD_ERROR;
  updateSettings({ autoRetry: prevAutoRetry });
  config.bins.ytdlp = fakeBin;
});
