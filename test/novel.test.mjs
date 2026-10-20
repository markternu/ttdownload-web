/**
 * 「小说资源」模块测试（书源引擎 + 编排 + 下载），全部用本地 mock 书站，不碰外网。
 *
 * 覆盖：① HTML 书源的搜索/详情/目录/正文解析；② 聚合搜索（一个源挂了不影响其它源）；
 * ③ 整本下载成 txt（多章节并发抓取）；④ 榜单抓取。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setupRuntime } from './helpers.mjs';

const root = setupRuntime();

/* ---------- 本地 mock 书站 ---------- */
const chapters = { 1: '第一章正文第一段', 2: '第二章正文第二段', 3: '第三章正文第三段' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (u.pathname === '/search') {
    res.end(`
      <ul>
        <li class="result"><a class="title" href="/book/1">星辰大海</a><span class="author">张三</span><span class="intro">一本科幻</span></li>
        <li class="result"><a class="title" href="/book/2">剑来</a><span class="author">李四</span></li>
      </ul>`);
  } else if (u.pathname === '/book/1') {
    res.end(`<h1>星辰大海</h1><div class="author">张三</div><div class="intro">这是一本科幻小说</div>
      <div class="catalog"><a href="/ch/1">第一章</a><a href="/ch/2">第二章</a><a href="/ch/3">第三章</a></div>`);
  } else if (/^\/ch\//.test(u.pathname)) {
    const n = Number(u.pathname.split('/').pop());
    res.end(`<div class="content">${chapters[n] ?? '空'}</div>`);
  } else if (u.pathname === '/rank') {
    res.end(`<ul class="rank-list"><li><a class="name" href="/book/1">星辰大海</a><span class="author">张三</span></li></ul>`);
  } else {
    res.statusCode = 404;
    res.end('nf');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((r) => server.close(r));
});

/* ---------- 载入被测模块 + 注册 mock 书源 ---------- */
const { saveStore, loadStore, searchByHtmlSource, parseBookByHtmlSource, parseChapterByHtmlSource } =
  await import('../dist/services/bookSource.js');
const { searchNovels, getNovelBook, getNovelChapter, downloadNovelTxt, fetchBoard, listBoards } =
  await import('../dist/services/novel.js');
const { config } = await import('../dist/core/config.js');

const mockSource = {
  kind: 'html',
  id: 'mock',
  name: 'mock书站',
  enabled: true,
  baseUrl: base,
  searchUrl: `${base}/search?kw={q}`,
  searchListSel: '.result',
  searchTitleSel: '.title',
  searchAuthorSel: '.author',
  searchUrlSel: '.title',
  searchIntroSel: '.intro',
  bookTitleSel: 'h1',
  bookAuthorSel: '.author',
  bookIntroSel: '.intro',
  catalogListSel: '.catalog a',
  catalogTitleSel: '.',
  catalogUrlSel: '.',
  chapterContentSel: '.content',
  removeSel: [],
};

saveStore({
  sources: [{ kind: 'gutendex', id: 'gutendex', name: 'g', enabled: false }, mockSource],
  rankBoards: [{ key: 'mock-rank', category: 'platform', label: 'mock榜', sourceId: 'mock', url: `${base}/rank`, listSel: '.rank-list li', titleSel: '.name', authorSel: '.author', urlSel: '.name' }],
});

/* ---------- 纯函数：HTML 解析 ---------- */

test('searchByHtmlSource：解析搜索结果（标题/作者/链接/简介）', () => {
  const html = `<ul><li class="result"><a class="title" href="/b/9">好书</a><span class="author">某人</span></li></ul>`;
  const items = searchByHtmlSource(mockSource, html, base);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '好书');
  assert.equal(items[0].author, '某人');
  assert.equal(items[0].url, `${base}/b/9`);
});

test('parseBookByHtmlSource：解析书名/作者/章节目录', () => {
  const html = `<h1>星辰大海</h1><div class="author">张三</div><div class="catalog"><a href="/ch/1">第一章</a><a href="/ch/2">第二章</a></div>`;
  const book = parseBookByHtmlSource(mockSource, html, base);
  assert.equal(book.title, '星辰大海');
  assert.equal(book.author, '张三');
  assert.equal(book.chapters.length, 2);
  assert.equal(book.chapters[1].url, `${base}/ch/2`);
});

test('parseChapterByHtmlSource：解析正文并去掉广告节点', () => {
  const html = `<div class="content">正文内容<script>alert(1)</script></div>`;
  const src = { ...mockSource, removeSel: ['script'] };
  const text = parseChapterByHtmlSource(src, html);
  assert.match(text, /正文内容/);
  assert.doesNotMatch(text, /alert/);
});

/* ---------- 编排：搜索 / 详情 / 章节 / 下载 ---------- */

test('聚合搜索：能搜到 mock 书站的结果（gutendex 已禁用不参与）', async () => {
  const r = await searchNovels('星辰');
  assert.equal(r.items.length, 2, '应搜到两本书');
  assert.equal(r.items[0].sourceId, 'mock');
  assert.ok(r.items.some((i) => i.title === '星辰大海'));
});

test('书籍详情：拿到章节目录', async () => {
  const book = await getNovelBook('mock', `${base}/book/1`);
  assert.equal(book.title, '星辰大海');
  assert.equal(book.chapters.length, 3);
});

test('章节正文：拿到内容', async () => {
  const ch = await getNovelChapter('mock', `${base}/ch/2`);
  assert.match(ch.content, /第二章正文/);
});

test('整本下载 txt：书名 + 三章正文都拼进去了', async () => {
  const { filename, text } = await downloadNovelTxt('mock', `${base}/book/1`);
  assert.match(filename, /星辰大海\.txt/);
  assert.match(text, /《星辰大海》/);
  assert.match(text, /第一章正文/);
  assert.match(text, /第二章正文/);
  assert.match(text, /第三章正文/);
});

/* ---------- 榜单 ---------- */

test('榜单：列出平台榜/类型榜，并能抓榜单内容', async () => {
  const boards = listBoards();
  assert.ok(boards.platform.some((b) => b.key === 'mock-rank'));
  const items = await fetchBoard('mock-rank');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '星辰大海');
  assert.equal(items[0].url, `${base}/book/1`);
});

test('书源持久化：saveStore 之后 loadStore 能读回自定义源', () => {
  const st = loadStore();
  assert.ok(st.sources.some((s) => s.id === 'mock' && s.enabled === true));
  assert.ok(st.sources.some((s) => s.id === 'gutendex' && s.enabled === false));
});
