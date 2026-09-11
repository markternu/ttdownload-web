import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../core/config';
import { logger, taskLog } from '../core/logger';
import { markVlt, nextPublishName, safeFileName } from './crypto';

/** 执行外部命令（数组参数，无 shell 注入风险） */
export function runCommand(bin: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    logger.child('proc').mark('PROC_SPAWN', `执行 ${bin}`, { bin, args, cwd });
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const done = (code: number): void => {
      const payload = { bin, code, ms: Date.now() - t0, stdout: stdout.slice(-1500), stderr: stderr.slice(-1500) };
      if (code === 0) logger.child('proc').mark('PROC_EXIT', `${bin} 退出 code=0（${payload.ms}ms）`, payload);
      else logger.child('proc').warn(`[MARK:PROC_EXIT] ${bin} 非零退出 code=${code}（${payload.ms}ms）：${(stderr || stdout).slice(-400)}`, payload);
      resolve({ code, stdout, stderr });
    };
    child.on('error', (e) => {
      logger.child('proc').error(`[MARK:PROC_EXIT] ${bin} 启动失败: ${e.message}`, { bin, args, cwd });
      resolve({ code: -1, stdout, stderr: e.message });
    });
    child.on('close', (code) => done(code ?? -1));
  });
}

export interface ArchiveResult {
  ok: boolean;
  archivePath?: string;
  publishedName?: string;
  originalName?: string;
  sizeBytes?: number;
  error?: string;
}

/**
 * 归档一个任务的产物到 downd_ok_p2：
 *  - 多文件 -> 打 zip（名字含 zip，扁平存放）
 *  - 单文件 -> 原样使用
 *  - 统一重命名为 <随机前缀><序号>，并把原始名写入 V-L-T 标记
 */
export async function archiveTaskFiles(
  files: string[],
  opts: { originalName: string; multiFileHint?: boolean; title?: string },
): Promise<ArchiveResult> {
  const existing = files.filter((f) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  });
  if (existing.length === 0) return { ok: false, error: '没有可归档的文件（可能已被移动或删除）' };

  fs.mkdirSync(config.dirs.archiveReady, { recursive: true });
  fs.mkdirSync(config.dirs.state, { recursive: true });

  const publishedName = nextPublishName();
  const target = path.join(config.dirs.archiveReady, publishedName);
  const originalName = safeFileName(opts.originalName || path.basename(existing[0]));

  try {
    if (existing.length > 1) {
      // 多文件 -> zip（扁平），先放临时 zip 再移动为目标名
      const tmpZip = path.join(config.dirs.archiveReady, `.tmp_${publishedName}.zip`);
      const args = ['-j', '-q', tmpZip, ...existing];
      const res = await runCommand(config.bins.zip, args);
      if (res.code !== 0) {
        fs.rmSync(tmpZip, { force: true });
        return { ok: false, error: `打包失败: ${res.stderr || res.stdout || res.code}` };
      }
      fs.renameSync(tmpZip, target);
    } else {
      // 单文件：优先硬链接/复制到目标（跨设备时 rename 会失败，直接 rename 更快）
      try {
        fs.renameSync(existing[0], target);
      } catch {
        fs.copyFileSync(existing[0], target);
        fs.rmSync(existing[0], { force: true });
      }
    }

    if (!markVlt(target, originalName)) {
      return { ok: false, error: '写入 V-L-T 标记失败' };
    }
    const sizeBytes = fs.statSync(target).size;
    logger.child('archive').mark('ARCHIVE', `归档完成: ${originalName} -> ${publishedName}`, {
      sizeBytes,
      archivePath: target,
      publishedName,
    });
    return { ok: true, archivePath: target, publishedName, originalName, sizeBytes };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 移动一个文件，目标重名时自动加 _dup_N */
export function moveWithDedup(src: string, destDir: string, destName?: string): string {
  fs.mkdirSync(destDir, { recursive: true });
  const base = destName ?? path.basename(src);
  let dest = path.join(destDir, base);
  let n = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(destDir, `${base}_dup_${n}`);
    n += 1;
  }
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
    fs.rmSync(src, { force: true });
  }
  return dest;
}
