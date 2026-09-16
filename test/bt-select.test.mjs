/**
 * BT 选片 + 打包规则 测试（**只有视频后缀**，不做任何广告识别）
 *
 * 背景：之前的"关键词 + 图片策略 + 体积下限"广告识别把正片也误判成广告，
 * 用户明确要求删掉。现在只剩一条规则：扩展名是视频才下（大小写不敏感）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBtFiles, buildPublishUnits, extOfName } from '../dist/services/btSelect.js';

const VIDEO = ['mp4', 'avi', 'wmv', 'mkv', 'flv', 'webm', 'mov', 'ts', 'm2ts', 'rmvb', 'mpg', 'mpeg', 'm4v', '3gp'];
const base = { videoExts: VIDEO };
const names = (files, res) => res.keep.map((i) => files[i].name).sort();

test('只下视频：任何视频后缀都要，其它一律不要', () => {
  const files = [
    { name: 'movie.mp4', length: 1000 },
    { name: 'A.MKV', length: 1000 },        // 大写后缀也要
    { name: 'b.Avi', length: 1000 },        // 混合大小写
    { name: 'c.ts', length: 1000 },
    { name: 'cover.jpg', length: 10 },      // 图片不要
    { name: '宣传.mp4.jpg', length: 10 },   // 后缀是 jpg -> 不要（不看名字，只看后缀）
    { name: 'readme.txt', length: 10 },
    { name: 'www.abc.com.url', length: 10 },
    { name: 'setup.exe', length: 10 },
  ];
  const res = selectBtFiles(files, base);
  assert.deepEqual(names(files, res), ['A.MKV', 'b.Avi', 'c.ts', 'movie.mp4'].sort(), '只留视频（后缀大小写不敏感）');
  assert.equal(res.keptBytes, 4000, '只统计视频大小（用于排队）');
});

test('不做任何"广告识别"：名字里带广告词但确实是视频的，照样下', () => {
  const files = [
    { name: '广告.mp4', length: 100 },
    { name: '宣传片.mkv', length: 100 },
    { name: 'sample.mp4', length: 100 },
    { name: 'trailer.mp4', length: 100 },
    { name: 'Screenshot_2024.mp4', length: 100 },
    { name: '广告宣传/正片.mp4', length: 100 },
  ];
  const res = selectBtFiles(files, base);
  assert.equal(res.keep.length, 6, '只要后缀是视频就全要（不再按名字猜广告，避免误杀正片）');
  assert.equal(res.dropped.length, 0);
});

test('一个视频都没有时：全都被排除（调用方据此跳过这个种子）', () => {
  const files = [
    { name: 'cover.jpg', length: 10 },
    { name: 'readme.txt', length: 10 },
    { name: 'info.nfo', length: 10 },
  ];
  const res = selectBtFiles(files, base);
  assert.equal(res.keep.length, 0);
  assert.equal(res.dropped.length, 3);
  assert.ok(res.dropped.every((d) => d.reason.includes('不是视频文件')), res.dropped.map((d) => d.reason).join('|'));
});

test('extOfName：取最后一个点之后的后缀并转小写', () => {
  assert.equal(extOfName('a/b/c.MP4'), 'mp4');
  assert.equal(extOfName('无扩展名'), '');
  assert.equal(extOfName('a.b.c.mkv'), 'mkv');
});

// ---------------- 打包规则（阈值默认 300MB） ----------------
const MB = 1024 ** 2;
const mk = (sizes) => {
  const map = {};
  Object.keys(sizes).forEach((k) => { map[`/d/${k}`] = sizes[k] * MB; });
  return map;
};

test('只有 1 个文件 -> 直接单独走（不改名打包）', () => {
  const sizes = mk({ 'a.mp4': 800 });
  const units = buildPublishUnits(Object.keys(sizes), 300 * MB, (p) => sizes[p], (p) => p, 'fold');
  assert.equal(units.length, 1);
  assert.deepEqual(units[0].files, ['/d/a.mp4']);
});

test('多个文件全都 < 300MB -> 合成一个 zip', () => {
  const sizes = mk({ 'a.mp4': 100, 'b.mp4': 200, 'c.mp4': 250 });
  const units = buildPublishUnits(Object.keys(sizes), 300 * MB, (p) => sizes[p], (p) => p, 'fold');
  assert.equal(units.length, 1, '小文件合成一个成品（会被打成 zip）');
  assert.equal(units[0].files.length, 3);
  assert.equal(units[0].name, 'fold');
});

test('有文件 >= 300MB -> 大文件一个一个单独走，小的合成一个', () => {
  const sizes = mk({ 'big1.mp4': 900, 'big2.mp4': 400, 'small1.mp4': 50, 'small2.mp4': 60 });
  const units = buildPublishUnits(Object.keys(sizes), 300 * MB, (p) => sizes[p], (p) => p.split('/').pop().replace(/\.\w+$/, ''), 'fold');
  const singles = units.filter((u) => u.files.length === 1).map((u) => u.files[0]).sort();
  assert.deepEqual(singles, ['/d/big1.mp4', '/d/big2.mp4'], '两个大文件各自一个成品');
  const batch = units.find((u) => u.files.length > 1);
  assert.ok(batch, '小文件应该合成一个成品');
  assert.deepEqual(batch.files.sort(), ['/d/small1.mp4', '/d/small2.mp4']);
  assert.equal(units.length, 3);
});
