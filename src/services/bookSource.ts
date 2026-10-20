/**
 * 书源引擎 —— 「小说资源」模块的核心。
 *
 * 支持两种书源（`BookSource` 联合类型）：
 *   1. `html`  通用网页书源：用 CSS 选择器描述「搜索页/详情页/目录/正文」的抓取方式，
 *      可接起点/晋江/番茄/七猫/笔趣阁等任意网页源（沿用 legado「书源」的思路，格式更简单：
 *      纯 CSS 选择器 + 可选正则清洗，不引入 legado 的 JS 规则）。
 *   2. `gutendex` 内置公版书源：Gutenberg（古登堡计划）公开 JSON API，**公版、合法、稳定**，
 *      开箱即用 —— 作为"公开资源"的示范源。
 *
 * 安全与健壮：
 *   · 每次请求带超时 + 统一 UA，单源失败不影响其它源（聚合搜索逐源 try/catch）；
 *   · 支持 utf-8 / gbk 解码（iconv-lite）；
 *   · 相对链接一律用 baseUrl / 响应最终 URL 转绝对地址。
 */

import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/* ------------------------------------------------------------------ */
/*  类型                                                                 */
/* ------------------------------------------------------------------ */

export interface HtmlBookSource {
  kind: 'html';
  id: string;
  name: string;
  /** 是否启用（false 就不参与搜索/榜单） */
  enabled?: boolean;
  /** 相对链接转绝对用（例如 https://www.example.com） */
  baseUrl: string;
  encoding?: 'utf-8' | 'gbk';
  /** 搜索 URL，`{q}` 会被替换成搜索词（encodeURIComponent） */
  searchUrl: string;
  searchListSel: string;
  searchTitleSel: string;
  searchAuthorSel?: string;
  searchUrlSel: string;
  searchCoverSel?: string;
  searchIntroSel?: string;
  bookTitleSel: string;
  bookAuthorSel?: string;
  bookCoverSel?: string;
  bookIntroSel?: string;
  catalogListSel: string;
  catalogTitleSel: string;
  catalogUrlSel: string;
  chapterContentSel: string;
  /** 正文里要去掉的节点选择器（广告/推荐等） */
  removeSel?: string[];
}

export interface GutendexSource {
  kind: 'gutendex';
  id: string;
  name: string;
  enabled?: boolean;
}

export type BookSource = HtmlBookSource | GutendexSource;

export interface NovelSearchItem {
  sourceId: string;
  sourceName: string;
  title: string;
  author: string;
  /** 详情页绝对地址（html 源）；gutendex 用 id */
  url: string;
  cover?: string;
  intro?: string;
}

export interface NovelChapter {
  title: string;
  url: string;
}

export interface NovelBook {
  title: string;
  author: string;
  intro: string;
  cover?: string;
  chapters: NovelChapter[];
  /** gutendex 公版书的纯文本下载地址 */
  plainTextUrl?: string;
}

export interface RankBoard {
  key: string;
  category: 'platform' | 'genre';
  label: string;
  sourceId: string;
  /** 榜单页地址 */
  url: string;
  listSel: string;
  titleSel: string;
  authorSel?: string;
  urlSel: string;
  coverSel?: string;
}

export interface RankItem {
  title: string;
  author: string;
  url: string;
  cover?: string;
}

/* ------------------------------------------------------------------ */
/*  基础工具                                                             */
/* ------------------------------------------------------------------ */

function clean(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function abs(href: string | undefined, base: string): string {
  if (!href) return '';
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/** 选择器为空 / 为 "." 时返回节点本身 */
// cheerio 的节点泛型在不同版本里名字不同（AnyNode），这里用 any 兼容
type AnyCheerio = cheerio.Cheerio<any>;
function find(node: AnyCheerio, sel?: string): AnyCheerio {
  if (!sel || sel === '.') return node;
  return node.find(sel).first();
}

export async function fetchHtml(url: string, encoding: 'utf-8' | 'gbk' = 'utf-8', timeoutMs = 12_000): Promise<{ html: string; finalUrl: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, redirect: 'follow', signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const html = encoding === 'gbk' ? iconv.decode(buf, 'gbk') : buf.toString('utf8');
    return { html, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T>(url: string, timeoutMs = 12_000): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, redirect: 'follow', signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/*  HTML 通用书源                                                       */
/* ------------------------------------------------------------------ */

export function searchByHtmlSource(source: HtmlBookSource, html: string, baseUrl: string): NovelSearchItem[] {
  const $ = cheerio.load(html);
  const out: NovelSearchItem[] = [];
  $(source.searchListSel).each((_, el) => {
    const node = $(el);
    const title = clean(find(node, source.searchTitleSel).text());
    const url = abs(find(node, source.searchUrlSel).attr('href'), baseUrl);
    if (!title || !url) return;
    out.push({
      sourceId: source.id,
      sourceName: source.name,
      title,
      author: clean(find(node, source.searchAuthorSel).text()) || '未知',
      url,
      cover: source.searchCoverSel ? abs(find(node, source.searchCoverSel).attr('src'), baseUrl) || undefined : undefined,
      intro: source.searchIntroSel ? clean(find(node, source.searchIntroSel).text()) || undefined : undefined,
    });
  });
  return out;
}

export function parseBookByHtmlSource(source: HtmlBookSource, html: string, baseUrl: string): NovelBook {
  const $ = cheerio.load(html);
  const title = clean(find($('body'), source.bookTitleSel).text()) || '未知书名';
  const chapters: NovelChapter[] = [];
  $(source.catalogListSel).each((_, el) => {
    const node = $(el);
    const t = clean(find(node, source.catalogTitleSel).text());
    const u = abs(find(node, source.catalogUrlSel).attr('href'), baseUrl);
    if (t && u) chapters.push({ title: t, url: u });
  });
  return {
    title,
    author: source.bookAuthorSel ? clean(find($('body'), source.bookAuthorSel).text()) || '未知' : '未知',
    intro: source.bookIntroSel ? clean(find($('body'), source.bookIntroSel).text()) : '',
    cover: source.bookCoverSel ? abs(find($('body'), source.bookCoverSel).attr('src'), baseUrl) || undefined : undefined,
    chapters,
  };
}

export function parseChapterByHtmlSource(source: HtmlBookSource, html: string): string {
  const $ = cheerio.load(html);
  const node = $((source.chapterContentSel as string) || 'body');
  for (const rm of source.removeSel ?? []) node.find(rm).remove();
  return node.text();
}

/* ------------------------------------------------------------------ */
/*  Gutenberg（gutendex）公版书源                                       */
/* ------------------------------------------------------------------ */

interface GutendexResult {
  id: number;
  title: string;
  authors?: { name: string }[];
  formats?: Record<string, string>;
}
interface GutendexResponse {
  count: number;
  results?: GutendexResult[];
}

function gutendexItem(r: GutendexResult): NovelSearchItem {
  return {
    sourceId: 'gutendex',
    sourceName: '古登堡计划（公版书）',
    title: clean(r.title),
    author: (r.authors ?? []).map((a) => a.name).join('、') || '佚名',
    url: String(r.id),
  };
}

export async function searchGutendex(q: string): Promise<NovelSearchItem[]> {
  const data = await fetchJson<GutendexResponse>(`https://gutendex.com/books?search=${encodeURIComponent(q)}`);
  return (data.results ?? []).slice(0, 30).map(gutendexItem);
}

export async function getGutendexBook(id: string): Promise<NovelBook> {
  const data = await fetchJson<GutendexResult>(`https://gutendex.com/books/${encodeURIComponent(id)}`);
  const plain = data.formats?.['text/plain'] ?? data.formats?.['text/plain; charset=utf-8'] ?? data.formats?.['text/plain; charset=us-ascii'];
  return {
    title: clean(data.title),
    author: (data.authors ?? []).map((a) => a.name).join('、') || '佚名',
    intro: '古登堡计划（Project Gutenberg）公版电子书。',
    chapters: [],
    plainTextUrl: plain,
  };
}

/* ------------------------------------------------------------------ */
/*  书源清单（可持久化到 state/book-sources.json，用户可自行增删）        */
/* ------------------------------------------------------------------ */

export function defaultBookSources(): BookSource[] {
  return [
    { kind: 'gutendex', id: 'gutendex', name: '古登堡计划（公版书）', enabled: true },
    // 示例：一个通用的网页书源（默认不启用，格式参考 docs/BOOK-SOURCE.md）
    // 换成真实的起点/番茄/七猫/笔趣阁源时，把 enabled 打开，或直接在网页/文件里新增。
    {
      kind: 'html',
      id: 'demo',
      name: '示例网页源（未启用）',
      enabled: false,
      baseUrl: 'https://www.example.com',
      searchUrl: 'https://www.example.com/search?kw={q}',
      searchListSel: '.result',
      searchTitleSel: '.title',
      searchUrlSel: 'a',
      searchAuthorSel: '.author',
      bookTitleSel: 'h1',
      bookAuthorSel: '.author',
      catalogListSel: '.catalog li',
      catalogTitleSel: 'a',
      catalogUrlSel: 'a',
      chapterContentSel: '.content',
      removeSel: ['.ad', 'script', 'style'],
    },
  ];
}

/** 启用的书源（enabled !== false 即启用；gutendex 默认启用） */
export function enabledSources(sources: BookSource[]): BookSource[] {
  return sources.filter((s) => s.enabled !== false);
}

/** 合并用户源：内置默认 + 用户文件里的源（同 id 覆盖）。返回合并后的列表。 */
export function mergeSources(user: BookSource[]): BookSource[] {
  const map = new Map<string, BookSource>();
  for (const s of [...defaultBookSources(), ...user]) map.set(s.id, s);
  return [...map.values()];
}

/* ------------------------------------------------------------------ */
/*  持久化：state/book-sources.json（用户可自行增删书源与榜单）          */
/* ------------------------------------------------------------------ */

export interface BookSourceStore {
  sources: BookSource[];
  rankBoards: RankBoard[];
}

function storeFile(): string {
  return path.join(config.dirs.state, 'book-sources.json');
}

export function defaultRankBoards(): RankBoard[] {
  // 榜单是"书源 + 榜单页选择器"的组合。默认给几个占位（source 未启用时页面显示"暂无数据"），
  // 接真实书源后在这里/文件里改成真实榜单 URL 与选择器即可。
  return [
    { key: 'platform-qidian', category: 'platform', label: '起点 · 热门', sourceId: 'demo', url: '', listSel: '.rank-list li', titleSel: '.name', urlSel: 'a' },
    { key: 'platform-fanqie', category: 'platform', label: '番茄 · 热榜', sourceId: 'demo', url: '', listSel: '.rank-list li', titleSel: '.name', urlSel: 'a' },
    { key: 'genre-xuanhuan', category: 'genre', label: '玄幻 · 热榜', sourceId: 'demo', url: '', listSel: '.rank-list li', titleSel: '.name', urlSel: 'a' },
    { key: 'genre-kehuan', category: 'genre', label: '科幻 · 热榜', sourceId: 'demo', url: '', listSel: '.rank-list li', titleSel: '.name', urlSel: 'a' },
  ];
}

/** 读盘（文件不存在/损坏则回落到默认） */
export function loadStore(): BookSourceStore {
  try {
    if (fs.existsSync(storeFile())) {
      const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Partial<BookSourceStore>;
      return {
        sources: mergeSources(Array.isArray(raw.sources) ? (raw.sources as BookSource[]) : []),
        rankBoards: Array.isArray(raw.rankBoards) ? (raw.rankBoards as RankBoard[]) : defaultRankBoards(),
      };
    }
  } catch (e) {
    /* 文件坏掉就回落默认 */
    console.warn(`[book-source] 读取 book-sources.json 失败：${(e as Error).message}`);
  }
  return { sources: mergeSources([]), rankBoards: defaultRankBoards() };
}

export function saveStore(store: BookSourceStore): void {
  try {
    fs.mkdirSync(config.dirs.state, { recursive: true });
    fs.writeFileSync(storeFile(), JSON.stringify(store, null, 2));
  } catch (e) {
    throw new Error(`写书源配置失败：${(e as Error).message}`);
  }
}
