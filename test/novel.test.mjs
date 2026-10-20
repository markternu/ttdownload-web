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
  } else if (u.pathname === '/w/api.php') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (u.searchParams.get('list') === 'search') {
      const q = u.searchParams.get('srsearch') ?? '';
      // 只对含"桃花"的搜索返回结果，避免干扰其它用例的"聚合搜索"计数
      const results = q.includes('桃花')
        ? [{ title: '桃花源记', snippet: '<span class="searchmatch">桃花源记</span> 是陶渊明的作品。' }]
        : [];
      res.end(JSON.stringify({ query: { search: results } }));
    } else if (u.searchParams.get('action') === 'parse') {
      res.end(JSON.stringify({ parse: { title: '桃花源记', text: '<p>晋太元中，武陵人捕鱼为业。</p><p>缘溪行，忘路之远近。</p>' } }));
    } else {
      res.end('{}');
    }
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
config.novel.wikisourceBase = base;   // 让 wikisource 源走本地 mock

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
  sources: [
    { kind: 'gutendex', id: 'gutendex', name: 'g', enabled: false },
    { kind: 'wikisource', id: 'wikisource', name: 'w', enabled: false },
    { kind: 'html', id: 'bqquge', name: 'bq', enabled: false },
    mockSource,
  ],
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

test('【只要txt】gutendex 优先取 txt，没有 txt 才退回 html（下载时剥标签转txt）', async () => {
  const { pickGutendexText } = await import('../dist/services/bookSource.js');
  // 有 txt → 用 txt
  assert.deepEqual(pickGutendexText({ 'text/plain': 'a.txt', 'application/epub+zip': 'a.epub' }), { url: 'a.txt', isHtml: false });
  // 只有 html → 退回 html 并标记 isHtml（下载时转 txt）
  assert.deepEqual(pickGutendexText({ 'text/html': 'a.html' }), { url: 'a.html', isHtml: true });
  // 都没有 → 空
  assert.deepEqual(pickGutendexText({ 'application/epub+zip': 'a.epub' }), { isHtml: false });
});

/* ---------- 书源管理（校验 + 保存接口） ---------- */

test('validateStore：缺必填/重复 id/坏榜单 都会被拦下并指出', async () => {
  const { validateStore } = await import('../dist/services/bookSource.js');
  // 缺必填字段
  assert.match(String(validateStore({ sources: [{ kind: 'html', id: 'x', name: 'x' }] })), /缺必填字段/);
  // searchUrl 缺 {q}
  assert.match(String(validateStore({ sources: [{ ...mockSource, searchUrl: 'http://x/noq' }] })), /\{q\}/);
  // 重复 id
  assert.match(String(validateStore({ sources: [mockSource, mockSource] })), /重复/);
  // 坏榜单
  assert.match(String(validateStore({ sources: [], rankBoards: [{ key: 'k', category: 'xxx' }] })), /榜单/);
  // 合法的应通过
  assert.equal(validateStore({ sources: [mockSource], rankBoards: [] }), null);
});

test('PUT /api/novel/sources：保存后 GET 能读回；坏配置返回 400', async () => {
  const { createApp } = await import('../dist/app.js');
  const httpmod = await import('node:http');
  const app = createApp();
  const srv = httpmod.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${srv.address().port}`;
  try {
    const good = await fetch(`${base2}/api/novel/sources`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources: [mockSource], rankBoards: [] }),
    });
    assert.equal(good.status, 200);
    const got = await (await fetch(`${base2}/api/novel/sources`)).json();
    assert.ok(got.sources.some((s) => s.id === 'mock'));

    const bad = await fetch(`${base2}/api/novel/sources`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources: [{ id: 'noid', name: 'x' }], rankBoards: [] }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});


/* ---------- 维基文库（wikisource）公版源 ---------- */

test('wikisource：搜索 / 打开整本 / 下载 txt（MediaWiki API）', async () => {
  // 临时启用 wikisource（全局 store 里默认禁用，避免其它用例打到外网）
  const { saveStore } = await import('../dist/services/bookSource.js');
  saveStore({ sources: [{ kind: 'wikisource', id: 'wikisource', name: 'w', enabled: true }, mockSource], rankBoards: [] });
  // 搜索
  const r = await searchNovels('桃花');
  const ws = r.items.find((i) => i.sourceId === 'wikisource');
  assert.ok(ws, '要能搜到维基文库的结果');
  assert.equal(ws.title, '桃花源记');

  // 打开书 → fullText
  const book = await getNovelBook('wikisource', '桃花源记');
  assert.match(String(book.fullText), /晋太元中/);
  assert.match(String(book.fullText), /武陵人/);

  // 下载 txt
  const { filename, text } = await downloadNovelTxt('wikisource', '桃花源记');
  assert.match(filename, /桃花源记\.txt/);
  assert.match(text, /晋太元中，武陵人捕鱼为业/);
  // 剥掉 HTML 标签后的纯文本里不该有 <p>
  assert.doesNotMatch(text, /<p>/);
});

/* ---------- 内置网文源（笔趣阁模板）选择器锁定 ---------- */

test('笔趣阁源：搜索/详情/目录/正文 选择器能解析（锁死模板，防止改坏）', async () => {
  const { defaultBookSources } = await import('../dist/services/bookSource.js');
  const bq = defaultBookSources().find((s) => s.id === 'bqquge');
  assert.ok(bq && bq.kind === 'html', '要内置 bqquge 网文源');

  // 搜索（.item / h3 a / a[href^="/zuozhe/"]）
  const soHtml = `<div class="item"><h3><a href="/5">玄鉴仙族</a></h3><a href="/zuozhe/季越人">作者：季越人</a></div>`;
  const items = searchByHtmlSource(bq, soHtml, 'https://www.bqquge.org');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '玄鉴仙族');
  assert.equal(items[0].author, '季越人', '作者前缀"作者："要剥掉');
  assert.equal(items[0].url, 'https://www.bqquge.org/5');

  // 详情（h1 / .booktxt a / .des / #list a）
  const bookHtml = `<h1>夜无疆</h1><div class="booktxt"><a href="/zuozhe/辰东">作者：辰东</a></div><div class="des">那一天太阳落下</div><div id="list"><a href="/1/1">第1章 永夜</a><a href="/1/2">第2章 火泉</a></div>`;
  const book = parseBookByHtmlSource(bq, bookHtml, 'https://www.bqquge.org');
  assert.equal(book.title, '夜无疆');
  assert.equal(book.author, '辰东');
  assert.equal(book.chapters.length, 2);
  assert.equal(book.intro, '那一天太阳落下');

  // 正文（.con，去掉 h1 章名）
  const chHtml = `<div class="con"><h1>第1章 永夜</h1><p>正文段落内容</p></div>`;
  const content = parseChapterByHtmlSource(bq, chHtml);
  assert.match(content, /正文段落内容/);
  assert.doesNotMatch(content, /第1章 永夜/, '正文里要把章名 h1 去掉');
});

test('榜单：内置了平台榜(热榜) + 玄幻/仙侠/穿越/科幻等类型榜', async () => {
  const { defaultRankBoards } = await import('../dist/services/bookSource.js');
  const all = defaultRankBoards();
  const boards = { platform: all.filter((b) => b.category === 'platform'), genre: all.filter((b) => b.category === 'genre') };
  assert.ok(boards.platform.some((b) => b.key === 'bq-hot'), '要有平台榜');
  for (const k of ['bq-xuanhuan', 'bq-xianxia', 'bq-chuanyue', 'bq-kehuan']) {
    assert.ok(boards.genre.some((b) => b.key === k), `要有类型榜 ${k}`);
  }
});
