/**
 * .torrent 元数据解析测试：批量入队前就要知道「要下载的资源多大」，不用先丢给 transmission。
 * 手工构造最小 bencode：d4:infod6:lengthi<size>e4:name<len>:<name>ee
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseTorrentFile } from '../dist/modules/torrentMeta.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'torrent-meta-'));

function bencodeSingle(length, name) {
  return Buffer.from(`d4:infod6:lengthi${length}e4:name${name.length}:${name}ee`, 'ascii');
}

test('单文件种子：能直接读出总大小，视频扩展名算作"要下载的大小"', () => {
  const p = path.join(tmp, 'single.torrent');
  fs.writeFileSync(p, bencodeSingle(12345, 'movie.mp4'));
  const m = parseTorrentFile(p);
  assert.equal(m.totalBytes, 12345);
  assert.equal(m.fileCount, 1);
  assert.equal(m.videoBytes, 12345, 'movie.mp4 是视频 → 要下载的就是它');
});

test('非视频单文件：兜底按全量算（宁可估大，不放行过头）', () => {
  const p = path.join(tmp, 'readme.torrent');
  fs.writeFileSync(p, bencodeSingle(999, 'readme.txt'));
  const m = parseTorrentFile(p);
  assert.equal(m.totalBytes, 999);
  assert.equal(m.videoBytes, 999, '没识别出视频就按全量兜底');
});

test('坏文件不抛到主流程（调用方会兜底，返回前抛错）', () => {
  const p = path.join(tmp, 'bad.torrent');
  fs.writeFileSync(p, Buffer.from('not-a-torrent', 'ascii'));
  assert.throws(() => parseTorrentFile(p));
});
