/**
 * 「小说资源」接口
 *   GET /api/novel/search?q=         聚合搜索（多源）
 *   GET /api/novel/book?source=&url=  书籍详情（章节目录）
 *   GET /api/novel/chapter?source=&url= 章节正文
 *   GET /api/novel/download?source=&url= 下载整本 txt
 *   GET /api/novel/boards            榜单列表（平台榜 / 类型榜）
 *   GET /api/novel/board?key=        某个榜单的内容
 */
import { Router } from 'express';
import { asyncHandler, badRequest } from '../utils/http';
import { downloadNovelTxt, fetchBoard, getNovelBook, getNovelChapter, listBoards, searchNovels } from '../services/novel';
import { loadStore } from '../services/bookSource';

export const novelRouter = Router();

novelRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) throw badRequest('请输入书名', 'MISSING_QUERY');
    const r = await searchNovels(q);
    res.json(r);
  }),
);

novelRouter.get(
  '/book',
  asyncHandler(async (req, res) => {
    const source = String(req.query.source ?? '');
    const url = String(req.query.url ?? '');
    if (!source || !url) throw badRequest('缺少 source / url', 'MISSING_PARAM');
    res.json(await getNovelBook(source, url));
  }),
);

novelRouter.get(
  '/chapter',
  asyncHandler(async (req, res) => {
    const source = String(req.query.source ?? '');
    const url = String(req.query.url ?? '');
    if (!source || !url) throw badRequest('缺少 source / url', 'MISSING_PARAM');
    res.json(await getNovelChapter(source, url));
  }),
);

novelRouter.get(
  '/download',
  asyncHandler(async (req, res) => {
    const source = String(req.query.source ?? '');
    const url = String(req.query.url ?? '');
    if (!source || !url) throw badRequest('缺少 source / url', 'MISSING_PARAM');
    const { filename, text } = await downloadNovelTxt(source, url);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Length', String(Buffer.byteLength(text, 'utf8')));
    res.send(text);
  }),
);

novelRouter.get('/boards', (_req, res) => {
  res.json(listBoards());
});

novelRouter.get(
  '/board',
  asyncHandler(async (req, res) => {
    const key = String(req.query.key ?? '');
    if (!key) throw badRequest('缺少榜单 key', 'MISSING_KEY');
    res.json({ items: await fetchBoard(key) });
  }),
);

novelRouter.get('/sources', (_req, res) => {
  res.json(loadStore().sources);
});
