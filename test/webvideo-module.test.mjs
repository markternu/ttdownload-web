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
