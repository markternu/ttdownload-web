/**
 * webvideo 解析 → 质量选项 的契约测试
 *
 * 真实故障：YouTube 的 yt-dlp 输出里 resolution 是 "1920x1080"，接口直接把它透传给前端，
 * 前端按第一个数字当高度（1920）→ 与 1080P/720P 对不上 → 质量下拉框只剩「仅音频」，
 * 用户以为「这个视频只有声音」。
 * 这里用一个形状完全真实的 yt-dlp JSON 跑完整解析，锁住接口契约：resolution 必须是
 * "1080p"/"720p"/"audio" 这种形式。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupRuntime } from './helpers.mjs';

const root = setupRuntime();

/** 真实 YouTube -J 输出的裁剪版（字段与 yt-dlp 一致，含 WxH 的 resolution 与 audio only） */
const YOUTUBE_JSON = {
  id: 'eP5b3ydjwps',
  title: '测试视频',
  uploader: '某频道',
  duration: 200,
  thumbnail: 'https://i.ytimg.com/vi/x/hq.jpg',
  formats: [
    { format_id: '137', ext: 'mp4', width: 1920, height: 1080, resolution: '1920x1080', vcodec: 'avc1.640028', acodec: 'none', filesize: 100000000 },
    { format_id: '248', ext: 'webm', width: 1920, height: 1080, resolution: '1920x1080', vcodec: 'vp9', acodec: 'none' },
    { format_id: '136', ext: 'mp4', width: 1280, height: 720, resolution: '1280x720', vcodec: 'avc1.4d401f', acodec: 'none', filesize_approx: 50000000 },
    { format_id: '135', ext: 'mp4', width: 854, height: 480, resolution: '854x480', vcodec: 'avc1.4d401e', acodec: 'none' },
    { format_id: '18', ext: 'mp4', width: 640, height: 360, resolution: '640x360', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', filesize: 20000000 },
    { format_id: '140', ext: 'm4a', resolution: 'audio only', vcodec: 'none', acodec: 'mp4a.40.2', filesize: 3000000 },
  ],
};

/** 竖向短视频（1080x1920，短边 1080）+ 只有一个音频流的播客 */
const VERTICAL_JSON = {
  title: '竖屏',
  duration: 15,
  formats: [
    { format_id: 'v1', ext: 'mp4', width: 1080, height: 1920, resolution: '1080x1920', vcodec: 'avc1', acodec: 'none' },
    { format_id: 'a1', ext: 'm4a', resolution: 'audio only', vcodec: 'none', acodec: 'mp4a' },
  ],
};
const AUDIO_ONLY_JSON = {
  title: '播客',
  duration: 3600,
  formats: [{ format_id: 'a', ext: 'm4a', resolution: 'audio only', vcodec: 'none', acodec: 'mp4a' }],
};

const fakeBin = path.join(root, 'bin', 'yt-dlp-fixture');
fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
fs.writeFileSync(
  fakeBin,
  `#!/bin/bash
if [ "$1" = "--version" ]; then echo "2026.08.19"; exit 0; fi
echo "ARGS: $*" >> "${path.join(root, 'parse-calls.log')}"
case "$FIXTURE" in
  vertical) cat <<'J'
${JSON.stringify(VERTICAL_JSON)}
J
    ;;
  audio) cat <<'J'
${JSON.stringify(AUDIO_ONLY_JSON)}
J
    ;;
  *) cat <<'J'
${JSON.stringify(YOUTUBE_JSON)}
J
    ;;
esac
exit 0
`,
  { mode: 0o755 },
);

const { parseVideo, parseClientArgs } = await import('../dist/modules/webvideo.js');

test('resolution 契约：WxH 必须被归一成 "1080p"/"720p"（不能把 1920x1080 透传给前端）', async () => {
  delete process.env.FIXTURE;
  const r = await parseVideo('https://www.youtube.com/watch?v=eP5b3ydjwps', fakeBin, 20000);
  const byId = new Map(r.formats.map((f) => [f.id, f]));

  assert.equal(byId.get('137')?.resolution, '1080p', '1080 高度的格式应报 1080p');
  assert.equal(byId.get('248')?.resolution, '1080p');
  assert.equal(byId.get('136')?.resolution, '720p');
  assert.equal(byId.get('135')?.resolution, '480p');
  assert.equal(byId.get('18')?.resolution, '360p');
  assert.equal(byId.get('140')?.resolution, 'audio', '纯音频格式应报 audio');

  for (const f of r.formats) {
    assert.doesNotMatch(String(f.resolution), /x/, `resolution 不能是 WxH 形式：${f.resolution}`);
  }

  // 默认格式必须是有画面的，绝不能默认成纯音频
  assert.equal(r.defaultFormatId, '137', `默认应挑 1080p mp4，实际 ${r.defaultFormatId}`);
  assert.equal(r.expectedBytes, 100000000);
  assert.equal(r.platform, 'YouTube');
  assert.equal(r.title, '测试视频');
});

test('竖屏 1080x1920 报 1080p（短边，和平台叫法一致）', async () => {
  process.env.FIXTURE = 'vertical';
  const r = await parseVideo('https://www.douyin.com/video/1', fakeBin, 20000);
  const v = r.formats.find((f) => f.id === 'v1');
  assert.equal(v?.resolution, '1080p', `竖屏应按短边报 1080p，实际 ${v?.resolution}`);
  assert.equal(r.defaultFormatId, 'v1', '默认应挑视频格式');
});

test('纯音频内容：只报 audio，不谎报分辨率', async () => {
  process.env.FIXTURE = 'audio';
  const r = await parseVideo('https://example.com/podcast', fakeBin, 20000);
  assert.deepEqual(r.formats.map((f) => f.resolution), ['audio']);
  assert.equal(r.defaultFormatId, 'a');
  delete process.env.FIXTURE;
});


test('★解析必须用 web_safari 客户端（否则 YouTube 只给 360p —— 用户实际踩到）', async () => {
  const calls = path.join(root, 'parse-calls.log');
  const readCalls = () =>
    fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l.includes('-J'));

  fs.writeFileSync(calls, '');
  await parseVideo('https://www.youtube.com/watch?v=jz1Ga7GG0Uk', fakeBin, 20000);
  const ytCalls = readCalls();
  assert.ok(ytCalls.length >= 1, '应有解析调用');
  assert.match(
    ytCalls[ytCalls.length - 1],
    /--extractor-args youtube:player_client=web_safari/,
    'YouTube 解析必须带 player_client=web_safari（默认客户端只返回 360p）',
  );

  // 非 YouTube 站点不能带 youtube 专用参数
  fs.writeFileSync(calls, '');
  await parseVideo('https://v.douyin.com/abc/', fakeBin, 20000);
  const dyCalls = readCalls();
  assert.ok(dyCalls.length >= 1);
  assert.doesNotMatch(dyCalls[dyCalls.length - 1], /player_client=web_safari/, '别的平台不该带 YouTube 客户端参数');
});

test('parseClientArgs：只给 YouTube 加，且 web_safari 排在最前', () => {
  const yt = parseClientArgs('https://www.youtube.com/watch?v=x');
  assert.equal(yt.length, 2);
  assert.equal(yt[0], '--extractor-args');
  assert.match(yt[1], /^youtube:player_client=web_safari/);
  assert.deepEqual(parseClientArgs('https://www.bilibili.com/video/BV1x'), []);
  assert.deepEqual(parseClientArgs('https://v.douyin.com/x/'), []);
});
