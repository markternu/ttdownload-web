import { Router } from 'express';
import { config } from '../core/config';
import { tasksRepo } from '../core/db';
import { kickScheduler } from '../core/scheduler';
import { logger } from '../core/logger';
import { aria2Client } from '../modules/aria2Client';
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
    if (urls.length === 0) throw badRequest('请至少输入一个 URL');
    if (urls.length > 200) throw badRequest('一次最多提交 200 个 URL');

    const created: number[] = [];
    const skipped: { url: string; reason: string }[] = [];
    const seen = new Set<string>();

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
      // 服务端再次去重：同 URL 已在队列中则不重复创建
      const dup = tasksRepo
        .list({ modules: ['aria2'], statuses: ['waiting', 'parsing', 'downloading', 'paused', 'archiving', 'encrypting'], pageSize: 200 })
        .items.find((t) => t.url === url);
      if (dup) {
        skipped.push({ url, reason: `已在队列中（任务 #${dup.id}）` });
        continue;
      }
      const name = (() => {
        try {
          return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '') || url;
        } catch {
          return url;
        }
      })();
      const task = tasksRepo.create({
        module: 'aria2',
        title: name,
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
