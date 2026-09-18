/**
 * 直接从 .torrent 文件里读出元数据（bencode），**不需要先丢给 transmission**。
 *
 * 用户诉求：批量入队前就要知道「这个种子我们要下载的资源到底多大」，才能合理判断
 * 能不能下、下几个；而不是一股脑全丢给 transmission 产生十几个任务再逐个失败。
 * 这里解析 torrent 的 info 字典：单文件看 `length`，多文件看 `files[]` 的 `length` 之和，
 * 并额外算出"视频资源总大小"（与 transmission 里只挑视频的口径一致）。
 */
import { config } from '../core/config';

export interface TorrentMeta {
  /** 种子内所有资源的总大小（字节） */
  totalBytes: number;
  /** 文件个数 */
  fileCount: number;
  /** 视频资源总大小（字节）—— 这就是我们要下载的那部分 */
  videoBytes: number;
}

const VIDEO_EXT = new Set((config.videoExts ?? []).map((e) => String(e).toLowerCase()));

function extOfName(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** 极简 bencode 解码器（torrent 用得到的那部分：int / string / list / dict） */
function bdecode(buf: Buffer): unknown {
  let pos = 0;
  function decode(): unknown {
    const c = buf[pos];
    if (c === 0x69) {
      // 'i' integer
      pos += 1;
      const end = buf.indexOf(0x65, pos);
      const n = Number.parseInt(buf.slice(pos, end).toString('ascii'), 10);
      pos = end + 1;
      return Number.isFinite(n) ? n : 0;
    }
    if (c === 0x6c) {
      // 'l' list
      pos += 1;
      const arr: unknown[] = [];
      while (buf[pos] !== 0x65) arr.push(decode());
      pos += 1;
      return arr;
    }
    if (c === 0x64) {
      // 'd' dict
      pos += 1;
      const obj: Record<string, unknown> = {};
      while (buf[pos] !== 0x65) {
        const key = decode() as Buffer | string;
        obj[String(key)] = decode();
      }
      pos += 1;
      return obj;
    }
    if (c >= 0x30 && c <= 0x39) {
      // 'N:' string
      const colon = buf.indexOf(0x3a, pos);
      const len = Number.parseInt(buf.slice(pos, colon).toString('ascii'), 10);
      pos = colon + 1;
      const str = buf.slice(pos, pos + len);
      pos += len;
      return str;
    }
    throw new Error('bencode: 不支持的字节');
  }
  return decode();
}

/** 解析 .torrent，失败抛异常（调用方自行兜底，别阻断主流程） */
export function parseTorrentFile(filePath: string): TorrentMeta {
  const buf = fsRead(filePath);
  const root = bdecode(buf) as Record<string, unknown>;
  const info = (root.info ?? root) as Record<string, unknown>;

  let totalBytes = 0;
  let fileCount = 0;
  let videoBytes = 0;

  const single = Number(info.length ?? 0);
  if (single > 0) {
    totalBytes = single;
    fileCount = 1;
    const name = String(info.name ?? '');
    if (VIDEO_EXT.has(extOfName(name))) videoBytes = single;
  } else {
    const files = Array.isArray(info.files) ? (info.files as Record<string, unknown>[]) : [];
    for (const f of files) {
      const len = Number(f.length ?? 0);
      const pathArr = Array.isArray(f.path) ? (f.path as (Buffer | string)[]) : [];
      const name = pathArr.length ? String(pathArr[pathArr.length - 1]) : '';
      totalBytes += len;
      fileCount += 1;
      if (len > 0 && VIDEO_EXT.has(extOfName(name))) videoBytes += len;
    }
  }
  // 兜底：万一没识别出视频（比如全是没见过的扩展名），就按全量算，宁可估大也别估小放行过头
  if (videoBytes <= 0) videoBytes = totalBytes;

  return { totalBytes, fileCount, videoBytes };
}

import fs from 'node:fs';
function fsRead(p: string): Buffer {
  return fs.readFileSync(p);
}
