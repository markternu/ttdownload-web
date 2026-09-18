import { pipeline } from 'node:stream';
import fs from 'node:fs';
import type { NextFunction, Request, Response } from 'express';

export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST'): HttpError => new HttpError(400, code, message);
export const notFound = (message: string, code = 'NOT_FOUND'): HttpError => new HttpError(404, code, message);
export const conflict = (message: string, code = 'CONFLICT'): HttpError => new HttpError(409, code, message);
export const unauthorized = (message: string, code = 'UNAUTHORIZED'): HttpError => new HttpError(401, code, message);

/**
 * 把磁盘文件流给客户端，并且**保证客户端断开时销毁读流**。
 *
 * 血案（用户报的"文件删了但空间不回来"）：以前直接用
 * `fs.createReadStream(path).pipe(res)`。手机端 aria2 会开多条 Range 连接、
 * 拿到需要的分片后**主动放弃**多余连接；此时 `res` 被销毁，但 `pipe()` 不会销毁
 * 源读流 → **fd 一直开着**。文件被 unlink 后 inode 仍被引用，块不归还给文件系统
 * → `df` 看不到空间回来（`lsof +L1` 能看到 `(deleted)` 的句柄）。
 * 用 pipeline() + close/error 兜底销毁，才能确保 fd 立刻释放。
 */
export function streamFileTo(res: import('express').Response, filePath: string, opts: { start?: number; end?: number } = {}): void {
  const src = fs.createReadStream(filePath, {
    ...(opts.start !== undefined ? { start: opts.start } : {}),
    ...(opts.end !== undefined ? { end: opts.end } : {}),
    // 高 RTT（跨洲）链路上，64KB 默认分块会让吞吐被事件循环/往返拖住 → 1MB
    highWaterMark: 1 << 20,
  });
  const destroy = (): void => {
    if (!src.destroyed) src.destroy();
  };
  res.once('close', destroy);   // 客户端断开/响应结束
  res.once('error', destroy);
  pipeline(src, res, () => {
    destroy(); // 正常结束也确保释放
  });
}

