import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config';

const pexec = promisify(execFile);

/** 分区可用/总容量（字节）。statfs 在 Node 18.15+ 可用；失败则回退。 */
export function statfsBytes(dir: string): { free: number; total: number } {
  try {
    const st = fs.statfsSync(dir);
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch {
    // 保守策略：读不到就用 0（宁可不下载，也不要把磁盘写满）
    return { free: 0, total: 0 };
  }
}

export function freeBytes(dir: string = config.dirs.root): number {
  return statfsBytes(dir).free;
}

/** 目录/文件占用大小（字节） */
export function pathSizeBytes(p: string): number {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    let total = 0;
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      total += pathSizeBytes(path.join(p, entry.name));
    }
    return total;
  } catch {
    return 0;
  }
}

/** 目标目录所在分区，在保留 reserve 后还剩多少可用（字节） */
export function usableBytes(reserveBytes: number = config.reserveFreeBytes, dir: string = config.dirs.root): number {
  return freeBytes(dir) - reserveBytes;
}

/** 目录占用统计（用于设置页系统状态展示） */
export function dirUsage(dir: string): { path: string; bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return { path: dir, bytes, files };
}

/** 检测外部命令是否存在并取版本（用于设置页工具状态） */
export async function toolStatus(bin: string, args: string[] = ['--version']): Promise<{ ok: boolean; version: string | null; error?: string }> {
  if (!bin) return { ok: false, version: null, error: '未配置命令' };
  try {
    const { stdout, stderr } = await pexec(bin, args, { timeout: 5000 });
    const text = `${stdout || ''}${stderr || ''}`.trim().split('\n')[0] ?? '';
    return { ok: true, version: text.slice(0, 160) };
  } catch (e) {
    return { ok: false, version: null, error: (e as Error).message };
  }
}
