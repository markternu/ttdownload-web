/**
 * BT 内容甄别 + 成品拆分 测试
 *
 * 背景：旧逻辑只判断"扩展名是视频或图片 → 全要"，于是宣传图、广告视频、网址文件
 * 统统下下来；而"一个种子 = 一个 zip 成品"会把好几个大视频塞进同一个包。
 *
 * 这里锁住新规则：
 *   ① 默认只要核心内容（视频）；图片在"有视频"时按宣传图排除
 *   ② 广告关键词命中即排除（文件名**和所在目录**都参与匹配）
 *   ③ 体积下限默认关闭（因为有些正片就是几十 MB，一刀切会误伤）；开了才生效
 *   ④ ≥ 阈值的视频各自一个成品（不打包）；其余小文件合成一个 zip 成品
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectBtFiles,
  buildPublishUnits,
  matchedKeyword,
  DEFAULT_BT_BLOCK_KEYWORDS,
} from '../dist/services/btSelect.js';

const VIDEO = ['mp4', 'mkv', 'avi', 'wmv', 'mov', 'ts'];
const IMAGE = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const base = { videoExts: VIDEO, imageExts: IMAGE };

const names = (files, res) => res.keep.map((i) => files[i].name).sort();
const reasons = (res) => res.dropped.map((d) => `${d.name}:${d.reason}`);

test('默认只要核心内容：视频留，图片（有视频时）与其它扩展名排除', () => {
  const files = [
    { name: 'movie.mp4', length: 700 * 1024 ** 2 },
    { name: 'cover.jpg', length: 200 * 1024 },
    { name: 'screenshot.png', length: 300 * 1024 },
    { name: 'readme.txt', length: 1024 },
    { name: 'www.abc.com.url', length: 100 },
  ];
  const res = selectBtFiles(files, base);
  assert.deepEqual(names(files, res), ['movie.mp4'], '只留视频');
  assert.equal(res.hasVideo, true);
  assert.equal(res.keptBytes, 700 * 1024 ** 2);
  assert.ok(reasons(res).some((r) => r.includes('不是视频/图片')), 'txt/url 应因扩展名被排除: ' + reasons(res).join(' | '));
  assert.ok(reasons(res).some((r) => r.startsWith('cover.jpg:')), '封面图应被排除（先被关键词命中）');
});

test('广告关键词命中就排除：文件名和所在目录都算', () => {
  const files = [
    { name: '正片.mp4', length: 1024 },
    { name: '广告.jpg', length: 10 },
    { name: '宣传视频.mp4', length: 10 },
    { name: 'Screenshot_2024.mp4', length: 10 },
    { name: 'trailer.mp4', length: 10 },
    { name: '广告宣传/正片2.mp4', length: 1024 },
  ];
  const res = selectBtFiles(files, base);
  assert.deepEqual(names(files, res), ['正片.mp4'], '只有正片留下（目录名命中关键词的也排掉）');
  const r = reasons(res).join(' | ');
  assert.ok(r.includes('广告.jpg:命中广告关键词'), r);
  assert.ok(r.includes('宣传视频.mp4:命中广告关键词'), r);
  assert.ok(r.includes('Screenshot_2024.mp4:命中广告关键词'), r);
  assert.ok(r.includes('trailer.mp4:命中广告关键词'), r);
  assert.ok(r.includes('广告宣传/正片2.mp4:命中广告关键词'), '目录名也要参与匹配: ' + r);
});

test('照片合集（种子里没有视频）才保留图片', () => {
  const files = [
    { name: '001.jpg', length: 100 },
    { name: '002.jpg', length: 100 },
    { name: '003.png', length: 100 },
  ];
  const res = selectBtFiles(files, base);
  assert.equal(res.hasVideo, false);
  assert.equal(res.keep.length, 3, '整包都是图片时按照片合集保留');
});

test('图片策略可选择：always / never（关键词优先于图片开关）', () => {
  // 用中性文件名，避免被关键词先命中
  const files = [{ name: 'movie.mp4', length: 10 }, { name: '001.jpg', length: 5 }];
  assert.deepEqual(names(files, selectBtFiles(files, { ...base, keepImages: 'always' })), ['001.jpg', 'movie.mp4']);
  assert.deepEqual(names(files, selectBtFiles(files, { ...base, keepImages: 'never' })), ['movie.mp4']);
  // auto（默认）：有视频 -> 丢图片
  assert.deepEqual(names(files, selectBtFiles(files, { ...base, keepImages: 'auto' })), ['movie.mp4']);
});

test('关键词优先于图片开关：就算设了保留图片，广告词命中的图片照样排掉', () => {
  const files = [{ name: 'movie.mp4', length: 10 }, { name: '广告图2.jpg', length: 5 }];
  const res = selectBtFiles(files, { ...base, keepImages: 'always' });
  assert.deepEqual(names(files, res), ['movie.mp4']);
  assert.ok(reasons(res).some((r) => r.includes('命中广告关键词')), reasons(res).join(' | '));
  // 用户把「广告」从关键词表里去掉，它就会按图片策略保留下来（表是可编辑的，这就是意义）
  const res2 = selectBtFiles(files, { ...base, keepImages: 'always', blockKeywords: ['sample'] });
  assert.deepEqual(names(files, res2), ['movie.mp4', '广告图2.jpg'].sort());
});

test('体积下限默认关闭；开了才按它排除小视频', () => {
  const files = [
    { name: 'big.mp4', length: 50 * 1024 ** 2 },
    { name: 'small.mp4', length: 5 * 1024 ** 2 },
  ];
  // 默认 0 = 不过滤（用户明确说过"几十 MB 的正片也可能是核心内容"，不能一刀切）
  const off = selectBtFiles(files, base);
  assert.equal(off.keep.length, 2, '默认不按体积过滤');

  const on = selectBtFiles(files, { ...base, minVideoBytes: 10 * 1024 ** 2 });
  assert.deepEqual(names(files, on), ['big.mp4']);
  assert.ok(reasons(on).some((r) => r.includes('小于体积下限')), reasons(on).join(' | '));
});

test('自定义关键词表可覆盖默认表', () => {
  const files = [{ name: '广告.mp4', length: 10 }, { name: 'ok.mp4', length: 10 }];
  const res = selectBtFiles(files, { ...base, blockKeywords: ['ok'] });
  assert.deepEqual(names(files, res), ['广告.mp4'], '传了自定义表就只用自定义表');
  // 默认表本身要能命中常见广告词
  assert.equal(matchedKeyword('www.广告.com/1.mp4', DEFAULT_BT_BLOCK_KEYWORDS), '广告');
  assert.equal(matchedKeyword('sample.mp4', DEFAULT_BT_BLOCK_KEYWORDS), 'sample');
  // 不能误伤普通片名
  assert.equal(matchedKeyword('S01E01.mkv', DEFAULT_BT_BLOCK_KEYWORDS), null);
  assert.equal(matchedKeyword('Interstellar.2014.1080p.mkv', DEFAULT_BT_BLOCK_KEYWORDS), null, '片名里的 ad 之类子串不能命中');
});

test('成品拆分：大文件各自一个成品，小文件合成一个 zip', () => {
  const sizes = { '/d/a.mp4': 600 * 1024 ** 2, '/d/b.mp4': 700 * 1024 ** 2, '/d/c.mp4': 20 * 1024 ** 2 };
  const units = buildPublishUnits(
    Object.keys(sizes),
    500 * 1024 ** 2,
    (p) => sizes[p],
    (p) => p.split('/').pop().replace(/\.[^.]+$/, ''),
    '合集',
  );
  assert.equal(units.length, 3, '两个大文件各自一个 + 小文件一个 = 3 个成品');
  assert.deepEqual(units[0], { files: ['/d/a.mp4'], name: 'a' }, '大文件单独成包（单文件走移动，不 zip）');
  assert.deepEqual(units[1], { files: ['/d/b.mp4'], name: 'b' });
  assert.deepEqual(units[2], { files: ['/d/c.mp4'], name: 'c' }, '只有一个小文件就用它自己的名字');
});

test('成品拆分：全是小文件时合成一个 zip 成品（等全部下完）', () => {
  const sizes = { '/d/1.mp4': 30 * 1024 ** 2, '/d/2.mp4': 40 * 1024 ** 2, '/d/3.mp4': 50 * 1024 ** 2 };
  const units = buildPublishUnits(Object.keys(sizes), 500 * 1024 ** 2, (p) => sizes[p], (p) => p, '整包');
  assert.equal(units.length, 1, '小文件合成一个成品');
  assert.equal(units[0].name, '整包');
  assert.equal(units[0].files.length, 3, '三个文件进同一个 zip');
});

test('成品拆分：阈值为 0 时全部合成一个成品（老行为）', () => {
  const sizes = { '/d/a.mp4': 600 * 1024 ** 2, '/d/b.mp4': 700 * 1024 ** 2 };
  const units = buildPublishUnits(Object.keys(sizes), 0, (p) => sizes[p], (p) => p, '整包');
  assert.equal(units.length, 1);
  assert.equal(units[0].files.length, 2);
});
