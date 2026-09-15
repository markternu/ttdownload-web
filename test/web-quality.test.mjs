/**
 * 前端纯逻辑单元测试（真实源码，不是复制一份逻辑）
 *
 * 背景（用户实际踩到的 bug）：YouTube 的 yt-dlp 输出里 resolution 是 "1920x1080"，
 * 前端按「第一个数字」取高度会得到 1920 → 与 1080P/720P 等选项全都对不上 →
 * 质量下拉框里只剩「仅音频」，看起来像「这个视频只有声音」。
 * 这里直接编译 web/src/lib/*.ts 来验证修复（包含能复现该症状的用例）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve('.');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttdl-weblib-'));
const esbuild = path.join(root, 'web', 'node_modules', '.bin', 'esbuild');

function build(entry) {
  const out = path.join(outDir, path.basename(entry).replace(/\.ts$/, '.mjs'));
  execFileSync(esbuild, [path.join(root, 'web', 'src', 'lib', entry), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${out}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out;
}

const constants = await import(build('constants.ts'));
const quality = await import(build('quality.ts'));

test.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

test('parseResolutionHeight：认识 WxH / 1080p / 纯数字 / audio', () => {
  const cases = [
    ['1920x1080', 1080], // ← 就是这里：取宽度会得到 1920（旧 bug）
    ['1280x720', 720],
    ['3840x2160', 2160],
    ['1080x1920', 1080], // 竖屏：取短边（平台叫法也是 1080p）
    ['1080p', 1080],
    ['1080p60', 1080],
    ['720P60', 720],
    ['1080', 1080],
    ['audio', 0],
    ['audio only', 0],
    ['', 0],
    ['unknown', 0],
  ];
  for (const [input, expected] of cases) {
    assert.equal(constants.parseResolutionHeight(input), expected, `parseResolutionHeight(${JSON.stringify(input)})`);
  }
});

/** 真实 yt-dlp 的 YouTube 输出形状（resolution 是 WxH） */
const youtubeFormats = [
  { id: '137', ext: 'mp4', resolution: '1920x1080', vcodec: 'avc1.640028', acodec: 'none' },
  { id: '136', ext: 'mp4', resolution: '1280x720', vcodec: 'avc1.4d401f', acodec: 'none' },
  { id: '135', ext: 'mp4', resolution: '854x480', vcodec: 'avc1.4d401e', acodec: 'none' },
  { id: '140', ext: 'm4a', resolution: 'audio only', vcodec: 'none', acodec: 'mp4a.40.2' },
];

test('回归：YouTube 的 WxH 分辨率必须给出 1080P/720P 等选项（不能只剩「仅音频」）', () => {
  const choices = quality.qualityChoices(youtubeFormats).map((c) => c.value);
  assert.ok(choices.includes('1080p'), `应能选 1080P，实际 ${JSON.stringify(choices)}`);
  assert.ok(choices.includes('720p'), '应能选 720P');
  assert.ok(choices.includes('480p'), '应能选 480P');
  assert.ok(choices.includes('audio'), '也应有「仅音频」可选');
  assert.notDeepEqual(choices, ['audio'], '绝不能只剩「仅音频」');
});

test('默认质量：有 1080P 时必须默认 1080P（不能掉到 audio）', () => {
  assert.equal(quality.pickDefaultQuality(youtubeFormats, '1080p'), '1080p');
  assert.equal(quality.pickDefaultQuality(youtubeFormats, '720p'), '720p');
  // 只有音频的视频：只能给 audio，不能列出一堆用不了的分辨率
  const audioOnly = [{ id: '140', ext: 'm4a', resolution: 'audio only', vcodec: 'none', acodec: 'mp4a' }];
  assert.deepEqual(
    quality.qualityChoices(audioOnly).map((c) => c.value),
    ['audio'],
    '纯音频视频只能有「仅音频」一个选项',
  );
  assert.equal(quality.pickDefaultQuality(audioOnly, '1080p'), 'audio');
});

test('非标准分辨率（如 1440x1080 竖屏/宽屏）也要能选出对应高度', () => {
  const odd = [{ id: 'x', ext: 'mp4', resolution: '1440x1080', vcodec: 'avc1', acodec: 'none' }];
  const choices = quality.qualityChoices(odd).map((c) => c.value);
  assert.ok(choices.includes('1080p'), `1080 高度应识别为 1080P，实际 ${JSON.stringify(choices)}`);
});

test('pickFormatId 会挑中正确高度的格式（含 WxH 情况）', () => {
  const id = constants.pickFormatId(youtubeFormats, '720p', 'mp4');
  assert.equal(id, '136', `720P+mp4 应挑中 720p 的格式，实际 ${id}`);
  const id1080 = constants.pickFormatId(youtubeFormats, '1080p', 'mp4');
  assert.equal(id1080, '137');
  const audioId = constants.pickFormatId(youtubeFormats, 'audio', 'm4a');
  assert.equal(audioId, '140', 'audio 应挑中纯音频格式');
});

test('格式下拉：按实际出现的容器类型给出', () => {
  const exts = quality.formatChoices(youtubeFormats).map((f) => f.value);
  assert.ok(exts.includes('mp4'));
  assert.ok(exts.includes('m4a'));
});
