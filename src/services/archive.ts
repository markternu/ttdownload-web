import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../core/config';
import { logger, taskLog } from '../core/logger';
import { markVlt, nextPublishName, safeFileName } from './crypto';
import { hideText } from './btAnon';

/**
 * 执行外部命令（数组参数，无 shell 注入风险）。
 *
 * `opts.hideArgs` / `opts.hideOutput`：**BT 相关调用必须传**。
 * 血案级原因：给 zip 传的 argv 就是所有源文件的完整路径（含视频文件名），
 * `PROC_SPAWN` 会把它整个打进日志；zip/unzip 的 stderr 也可能回显条目名。
 * 用户要求 BT 日志里不出现种子名与内容名，所以这类调用一律只记"有几项参数"。
 */
export interface RunCommandOpts {
  /** 参数里含文件名/路径时置 true（日志只记参数个数） */
  hideArgs?: boolean;
  /** 子进程输出里可能含文件名/路径时置 true（日志只记退出码与耗时） */
  hideOutput?: boolean;
  /** 日志里的中文说明（代替裸 argv，便于排查） */
  label?: string;
}

export function runCommand(
  bin: string,
  args: string[],
  cwd?: string,
  opts: RunCommandOpts = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const what = opts.label ? `${opts.label}（${bin}）` : bin;
    const argsForLog = opts.hideArgs ? `（${args.length} 项参数已隐藏）` : args;
    logger.child('proc').mark('PROC_SPAWN', `执行 ${what}`, { bin, args: argsForLog, cwd });
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
      const ms = Date.now() - t0;
      const payload = opts.hideOutput
        ? { bin, code, ms, outputHidden: true }
        : { bin, code, ms, stdout: stdout.slice(-1500), stderr: stderr.slice(-1500) };
      if (code === 0) logger.child('proc').mark('PROC_EXIT', `${what} 退出 code=0（${ms}ms）`, payload);
      else {
        const tail = opts.hideOutput ? '（输出已隐藏）' : (stderr || stdout).slice(-400);
        logger.child('proc').warn(`[MARK:PROC_EXIT] ${what} 非零退出 code=${code}（${ms}ms）：${tail}`, payload);
      }
      resolve({ code, stdout, stderr });
    };
    child.on('error', (e) => {
      logger.child('proc').error(`[MARK:PROC_EXIT] ${what} 启动失败: ${e.message}`, { bin, args: argsForLog, cwd });
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
 * 多文件打包前的"扁平化暂存"。
 *
 * `zip -j` 会把所有文件的**基名**放在 zip 根下 —— 一旦有两个同名文件（`CD1/movie.mp4` 与
 * `CD2/movie.mp4`，BT 里非常常见），zip 直接报 "cannot repeat names" 退出码 16：
 * 归档永久失败 → 扫货每 2 分钟重建任务再失败 → 目录永远清不掉。
 *
 * 做法：**只有真出现重名时**才建一个暂存目录，用硬链接（同分区零拷贝）铺一份改过名的副本，
 * 名字重复的加 `_2`、`_3`…；没有重名就返回 { dir: null } 走原来的零拷贝路径。
 */
function stageForZip(files: string[], tag: string): { dir: string | null; files: string[] } {
  const baseNames = files.map((f) => path.basename(f));
  if (new Set(baseNames).size === baseNames.length) return { dir: null, files };
  const dir = fs.mkdtempSync(path.join(config.dirs.state, `zipstage_${tag}_`));
  const used = new Set<string>();
  const staged: string[] = [];
  for (const f of files) {
    const base = path.basename(f);
    const ext = path.extname(base);
    const stem = ext ? base.slice(0, base.length - ext.length) : base;
    let cand = base;
    let n = 2;
    while (used.has(cand)) {
      cand = `${stem}_${n}${ext}`;
      n += 1;
    }
    used.add(cand);
    const dest = path.join(dir, cand);
    try {
      fs.linkSync(f, dest);
    } catch {
      fs.copyFileSync(f, dest);
    }
    staged.push(dest);
  }
  return { dir, files: staged };
}

/**
 * 归档一个任务的产物到 downd_ok_p2：
 *  - 多文件 -> 打 zip（名字含 zip，扁平存放）
 *  - 单文件 -> 原样使用
 *  - 统一重命名为 <随机前缀><序号>，并把原始名写入 V-L-T 标记
 */
export async function archiveTaskFiles(
  files: string[],
  opts: { originalName: string; multiFileHint?: boolean; title?: string; logName?: string; hideNames?: boolean },
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
      // ⚠️ `zip -j` 遇到**同名文件**直接报 "cannot repeat names" 并以非 0 退出
      //    （例如 CD1/movie.mp4 + CD2/movie.mp4）。这在 BT 里很常见，而归档失败会让扫货
      //    每个 tick 重建任务反复失败、目录永远清不掉。所以先做一次"扁平化 + 去重命名"。
      const stage = stageForZip(existing, publishedName);
      let args: string[];
      if (stage.dir) {
        args = ['-j', '-q', tmpZip, ...stage.files];
      } else {
        args = ['-j', '-q', tmpZip, ...existing];
      }
      // ⚠️ args 里就是所有源文件的真实路径（BT 内容名）→ 必须隐藏 argv 与可能回显条目名的输出
      const res = await runCommand(config.bins.zip, args, undefined, {
        hideArgs: opts.hideNames === true,
        hideOutput: opts.hideNames === true,
        label: '多文件打包为 zip',
      });
      if (stage.dir) fs.rmSync(stage.dir, { recursive: true, force: true });
      if (res.code !== 0) {
        fs.rmSync(tmpZip, { force: true });
        const why = opts.hideNames ? `退出码 ${res.code}` : (res.stderr || res.stdout || res.code);
        return { ok: false, error: `打包失败: ${why}` };
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
    logger.child('archive').mark('ARCHIVE', `归档完成: ${opts.logName ?? originalName} -> ${publishedName}`, {
      sizeBytes,
      archivePath: target,
      publishedName,
    });
    return { ok: true, archivePath: target, publishedName, originalName, sizeBytes };
  } catch (e) {
    // fs 报错信息里会带上源文件路径（BT 内容名）→ 按需脱敏
    const msg = (e as Error).message;
    return { ok: false, error: opts.hideNames ? hideText(msg) : msg };
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
