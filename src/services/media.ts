/**
 * 媒体处理小工具（「播放器」和「归档前转封装」共用）：
 *   · 识别 zip（加密归档里多文件会被打成 zip）
 *   · 从解压目录里挑出最大的视频文件
 *   · 判断 mp4 的 moov（封装头）是不是在文件前面 —— 只有 moov 在前（faststart）
 *     浏览器才能边下边播、拖动进度；moov 在尾巴上就得先整份下完才能播。
 *   · 用 ffmpeg 把非 mp4 / moov 在后的视频**重封装**成 mp4 + faststart（-c copy，
 *     不重新编码，几乎只耗 I/O，树莓派也扛得住）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { runCommand } from './archive';

/** 认作"视频"的扩展名（挑选要播放的文件时用） */
export const VIDEO_EXTS = new Set([
  '.mp4', '.m4v', '.mkv', '.avi', '.flv', '.ts', '.m2ts', '.webm',
  '.mov', '.wmv', '.rmvb', '.rm', '.3gp', '.mpg', '.mpeg', '.vob', '.ogv',
]);

export function isVideoExt(file: string): boolean {
  return VIDEO_EXTS.has(path.extname(file).toLowerCase());
}

/** 文件头是不是 zip（PK\x03\x04 / PK\x05\x06 / PK\x07\x08） */
export function isZipFile(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(4);
      if (fs.readSync(fd, buf, 0, 4, 0) < 4) return false;
      return buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07) && (buf[3] === 0x04 || buf[3] === 0x06 || buf[3] === 0x08);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** 递归找目录里**所有**视频文件（按体积从大到小；zip 里可能有很多集） */
export function pickVideoFiles(dir: string, maxDepth = 6): string[] {
  const found: { p: string; size: number }[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      if (!e.isFile() || !isVideoExt(e.name)) continue;
      try {
        found.push({ p, size: fs.statSync(p).size });
      } catch {
        /* ignore */
      }
    }
  };
  walk(dir, 0);
  found.sort((a, b) => b.size - a.size);
  return found.map((f) => f.p);
}

/** 递归找目录里**最大**的视频文件（BT 里常见多集、多 CD，取最大的那个） */
export function pickVideoFile(dir: string, maxDepth = 6): string | null {
  return pickVideoFiles(dir, maxDepth)[0] ?? null;
}

/**
 * mp4 的 moov（封装头/索引用）是否在文件前面（faststart）。
 *
 * 遍历顶层 box：遇到 moov 在 mdat 之前 → true；mdat 先出现 → false。
 * 只读 box 头（8/16 字节），不会把整个文件读进来。
 */
export function isMp4Faststart(file: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return false;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let offset = 0;
    // 最多扫 4096 个 box 头，防止坏文件把循环拖死
    for (let i = 0; i < 4096 && offset + 8 <= size; i += 1) {
      const hdr = Buffer.alloc(8);
      if (fs.readSync(fd, hdr, 0, 8, offset) < 8) return false;
      let boxSize = hdr.readUInt32BE(0);
      const type = hdr.subarray(4, 8).toString('latin1');
      if (boxSize === 1) {
        if (offset + 16 > size) return false;
        const big = Buffer.alloc(8);
        fs.readSync(fd, big, 0, 8, offset + 8);
        boxSize = Number(big.readBigUInt64BE(0));
      } else if (boxSize === 0) {
        boxSize = size - offset; // 延续到文件尾
      }
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (!Number.isFinite(boxSize) || boxSize < 8) return false;
      offset += boxSize;
    }
    return false;
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 把任意视频**重封装**成 mp4 + faststart（-c copy，不重新编码）。
 * 先试纯复制；mp4 装不下音频编码时，退化为"视频复制 + 音频转 AAC"。
 */
export async function remuxToMp4(input: string, output: string): Promise<{ ok: boolean; error?: string }> {
  const baseArgs = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:v:0?', '-map', '0:a:0?'];

  const tryOnce = async (codecArgs: string[], label: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      fs.rmSync(output, { force: true });
    } catch {
      /* ignore */
    }
    const r = await runCommand(
      config.bins.ffmpeg,
      [...baseArgs, ...codecArgs, '-movflags', '+faststart', output],
      undefined,
      { label, hideArgs: true, hideOutput: true },
    );
    if (r.code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0) return { ok: true };
    return { ok: false, error: (r.stderr || r.stdout || `ffmpeg 退出码 ${r.code}`).trim().slice(-300) };
  };

  // ① 纯封装复制（最快，音频视频都不动）
  const first = await tryOnce(['-c', 'copy'], '重封装成 mp4（-c copy）');
  if (first.ok) return first;
  // ② 兜底：视频复制，音频转 AAC（有些音频编码 mp4 容器装不下）
  const second = await tryOnce(['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k'], '重封装成 mp4（音频转 AAC）');
  if (second.ok) return second;
  return { ok: false, error: `重封装失败：${second.error || first.error || '未知错误'}` };
}


/**
 * 归档/加密前：把要归档的视频**统一转成 mp4 + faststart**。
 *
 * 为什么：加密归档之后再想播就要每次临时解密+重封装；在归档前转一次，
 * 以后成品天然就是浏览器能边下边播的 mp4（moov 在文件头）。
 *
 * 安全：转封装失败**绝不阻断归档** —— 保留原文件继续走（顶多以后播放时再临时转）。
 */
export async function normalizeVideosForArchive(
  files: string[],
): Promise<{ files: string[]; converted: number; skipped: string[] }> {
  const out: string[] = [];
  const skipped: string[] = [];
  let converted = 0;
  for (const f of files) {
    const ext = path.extname(f);
    if (!isVideoExt(f) || isMp4Faststart(f)) {
      out.push(f);
      continue;
    }
    const dest = path.join(path.dirname(f), `${path.basename(f, ext)}.mp4`);
    const tmp = `${dest}.remux_${process.pid}_${Date.now()}`;
    const r = await remuxToMp4(f, tmp);
    if (!r.ok) {
      skipped.push(f);
      out.push(f);
      continue;
    }
    try {
      if (dest !== f) fs.rmSync(f, { force: true });
      fs.renameSync(tmp, dest);
      out.push(dest);
      converted += 1;
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      out.push(f);
    }
  }
  return { files: out, converted, skipped };
}
