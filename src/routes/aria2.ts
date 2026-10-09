import { Router } from 'express';
import { config } from '../core/config';
import { tasksRepo } from '../core/db';
import { kickScheduler } from '../core/scheduler';
import { logger } from '../core/logger';
import { aria2Client } from '../modules/aria2Client';
import { titleForNewTask } from '../modules/aria2';
import { asyncHandler, badRequest } from '../utils/http';

export const aria2Router = Router();

function splitUrls(input: unknown): string[] {
  const raw: string[] = [];
  if (Array.isArray(input)) {
    for (const item of input) raw.push(...String(item).split(/\r?\n/));
  } else if (typeof input === 'string') {
    raw.push(...input.split(/\r?\n/));
  }
  return raw.map((s) => s.trim()).filter(Boolean);
}

aria2Router.post(
  '/urls',
  asyncHandler(async (req, res) => {
    const urls = splitUrls(req.body?.urls ?? req.body?.url ?? '');
    logger.child('aria2').mark('TASK_CREATE', `收到 ${urls.length} 个 URL 提交`, { urls: urls.slice(0, 20), total: urls.length });
    if (urls.length === 0) throw badRequest('请至少输入一个 URL');
    // 上限只做"别把请求撑爆"的防呆：用户手动 `aria2c -i urlfile` 是**没有数量上限**的，
    // 所以这里给到 2000（以前是 200，批量搬站会直接被拒，与用户习惯不符）。
    if (urls.length > 2000) throw badRequest('一次最多提交 2000 个 URL（可分几批）');

    const created: number[] = [];
    const skipped: { url: string; reason: string }[] = [];
    const seen = new Set<string>();

    // 服务端去重 + 收集已用标题：**一次性**把在队列里的任务全拉出来
    // （以前是每提交一个 URL 就查一次库，几百个 URL 就是几百次全表扫描，又慢又容易超时）
    const queuedByUrl = new Map<string, number>();
    const usedTitles = new Set<string>();
    {
      let page = 1;
      for (;;) {
        const res = tasksRepo.list({
          modules: ['aria2'],
          statuses: ['waiting', 'parsing', 'downloading', 'paused', 'archiving', 'encrypting'],
          page,
          pageSize: 1000,
        });
        for (const t of res.items) {
          if (t.url) queuedByUrl.set(t.url, t.id);
          if (t.title) usedTitles.add(t.title);
        }
        if (res.items.length === 0 || queuedByUrl.size >= res.total) break;
        page += 1;
        if (page > 20) break; // 防呆：最多看 2 万个
      }
    }

    for (const url of urls) {
      if (!/^https?:\/\//i.test(url)) {
        skipped.push({ url, reason: 'URL 格式错误（仅支持 http/https）' });
        continue;
      }
      if (seen.has(url)) {
        skipped.push({ url, reason: '重复的 URL（本次提交内去重）' });
        continue;
      }
      seen.add(url);
      const dupId = queuedByUrl.get(url);
      if (dupId) {
        skipped.push({ url, reason: `已在队列中（任务 #${dupId}）` });
        continue;
      }
      // ⚠️ 血案：以前不管像不像文件名都拿路径最后一段当标题，
      //    于是 `.../download?id=xxx` 这类直链**所有任务都叫 "download"**，根本分不清。
      //    现在：像文件名就用文件名；不像就编号 download1/download2/…（用户明确接受的方案）。
      const task = tasksRepo.create({
        module: 'aria2',
        title: titleForNewTask(url, usedTitles),
        platform: 'URL',
        url,
        status: 'waiting',
      });
      created.push(task.id);
    }

    kickScheduler();
    logger.info(`aria2 入队：新增 ${created.length} 个，跳过 ${skipped.length} 个`);
    res.json({
      created: created.length,
      skipped,
      tasks: created.map((id) => tasksRepo.get(id)),
    });
  }),
);

aria2Router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const client = aria2Client();
    let version: string | null = null;
    try {
      version = await client.version();
    } catch {
      version = null;
    }
    res.json({
      running: version !== null,
      rpc: { host: config.aria2Rpc.host, port: config.aria2Rpc.port },
      version,
      pending: tasksRepo.list({ modules: ['aria2'], statuses: ['waiting', 'downloading', 'parsing', 'paused'], pageSize: 1 }).total,
    });
  }),
);
