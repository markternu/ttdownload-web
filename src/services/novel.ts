/**
 * 「小说资源」业务编排：搜索（聚合多源）/ 书籍详情 / 章节正文 / 下载 txt / 榜单。
 *
 * 只做"编排"，真正的抓取在 bookSource.ts。聚合搜索逐源 try/catch：一个源挂了不影响其它源。
 */

import * as cheerio from 'cheerio';
import {
  BookSource,
  NovelBook,
  NovelChapter,
  NovelSearchItem,
  RankBoard,
  RankItem,
  fetchHtml,
  getGutendexBook,
  loadStore,
  parseBookByHtmlSource,
  parseChapterByHtmlSource,
  searchByHtmlSource,
  searchGutendex,
  type HtmlBookSource,
} from './bookSource';

function sourceById(id: string): BookSource | undefined {
  return loadStore().sources.find((s) => s.id === id);
}

/** 聚合搜索：跑遍所有启用的源，某个源失败只记日志、不打断整体 */
export async function searchNovels(q: string): Promise<{ items: NovelSearchItem[]; errors: { source: string; message: string }[] }> {
  const store = loadStore();
  const items: NovelSearchItem[] = [];
  const errors: { source: string; message: string }[] = [];
  const enabled = store.sources.filter((s) => s.enabled !== false);

  for (const src of enabled) {
    try {
      if (src.kind === 'gutendex') {
        items.push(...(await searchGutendex(q)));
      } else {
        const html = await fetchHtml(src.searchUrl.replace('{q}', encodeURIComponent(q)), src.encoding ?? 'utf-8');
        items.push(...searchByHtmlSource(src, html.html, html.finalUrl));
      }
    } catch (e) {
      errors.push({ source: src.name, message: (e as Error).message });
    }
  }
  return { items, errors };
}

export async function getNovelBook(sourceId: string, url: string): Promise<NovelBook> {
  const src = sourceById(sourceId);
  if (!src) throw new Error(`书源不存在：${sourceId}`);
  if (src.kind === 'gutendex') return getGutendexBook(url);
  const html = await fetchHtml(url, src.encoding ?? 'utf-8');
  return parseBookByHtmlSource(src, html.html, html.finalUrl);
}

export async function getNovelChapter(sourceId: string, url: string): Promise<{ title: string; content: string }> {
  const src = sourceById(sourceId);
  if (!src) throw new Error(`书源不存在：${sourceId}`);
  if (src.kind === 'gutendex') {
    // gutendex 是整本书一个文本，没有"章节"概念 —— 直接给全文
    const book = await getGutendexBook(url);
    const text = book.plainTextUrl ? await fetchText(book.plainTextUrl) : '';
    return { title: book.title, content: text };
  }
  const html = await fetchHtml(url, src.encoding ?? 'utf-8');
  // 章节标题优先从 URL 里取个兜底，真正标题在下载时用目录名
  return { title: '', content: parseChapterByHtmlSource(src, html.html) };
}

async function fetchText(url: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 下载整本书 → 拼接成 txt（返回文件名 + 文本）。章节并发抓取（上限 4）。 */
export async function downloadNovelTxt(sourceId: string, url: string): Promise<{ filename: string; text: string }> {
  const src = sourceById(sourceId);
  if (!src) throw new Error(`书源不存在：${sourceId}`);

  let title: string;
  let chapters: NovelChapter[];
  let fullText: string;

  if (src.kind === 'gutendex') {
    const book = await getGutendexBook(url);
    title = book.title;
    fullText = book.plainTextUrl ? await fetchText(book.plainTextUrl) : '';
    chapters = [];
  } else {
    const html0 = await fetchHtml(url, src.encoding ?? 'utf-8');
    const book = parseBookByHtmlSource(src, html0.html, html0.finalUrl);
    title = book.title;
    chapters = book.chapters;
    if (!chapters.length) throw new Error('没解析到章节目录（检查书源的 catalogListSel 配置）');

    const lines: string[] = [];
    // 并发抓章节正文（限 4，别把源打死）
    const CONC = 4;
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < chapters.length) {
        const i = idx++;
        const ch = chapters[i];
        try {
          const h = await fetchHtml(ch.url, src.encoding ?? 'utf-8');
          lines[i] = `\n\n${ch.title}\n\n${parseChapterByHtmlSource(src, h.html).replace(/\n{3,}/g, '\n\n')}`;
        } catch (e) {
          lines[i] = `\n\n${ch.title}\n\n（本章抓取失败：${(e as Error).message}）`;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, chapters.length) }, () => worker()));
    fullText = lines.join('');
  }

  const safe = title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'novel';
  const header = `《${title}》\n\n（由 ttdownload-web 书源抓取，仅供个人试读）\n`;
  return { filename: `${safe}.txt`, text: header + fullText };
}

/* ------------------------------------------------------------------ */
/*  榜单                                                                */
/* ------------------------------------------------------------------ */

export function listBoards(): { platform: RankBoard[]; genre: RankBoard[] } {
  const boards = loadStore().rankBoards;
  return {
    platform: boards.filter((b) => b.category === 'platform'),
    genre: boards.filter((b) => b.category === 'genre'),
  };
}

export async function fetchBoard(key: string): Promise<RankItem[]> {
  const board = loadStore().rankBoards.find((b) => b.key === key);
  if (!board) throw new Error(`榜单不存在：${key}`);
  if (!board.url) return []; // 还没配真实榜单 URL
  const src = sourceById(board.sourceId);
  if (!src || src.kind !== 'html') return [];

  const html = await fetchHtml(board.url, (src as HtmlBookSource).encoding ?? 'utf-8');
  const $ = cheerio.load(html.html);
  const out: RankItem[] = [];
  $(board.listSel).each((_, el) => {
    const node = $(el);
    const title = node.find(board.titleSel).first().text().replace(/\s+/g, ' ').trim();
    const href = node.find(board.urlSel).first().attr('href') || '';
    if (!title || !href) return;
    out.push({
      title,
      author: board.authorSel ? node.find(board.authorSel).first().text().replace(/\s+/g, ' ').trim() || '未知' : '未知',
      url: new URL(href, html.finalUrl).href,
      cover: board.coverSel ? node.find(board.coverSel).first().attr('src') || undefined : undefined,
    });
  });
  return out;
}
