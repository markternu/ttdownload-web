/**
 * 外部命令调用日志：记录 argv、耗时、退出码、stdout/stderr 摘要。
 * 调试期只要用户在网页导出一份日志，就能看到"到底执行了什么、报了什么"。
 */
import type { ChildProcess } from 'node:child_process';
import { logger } from './logger';

const TAIL = 3000;

/** 截取文本尾部（错误信息通常在最后几行） */
export function tailText(text: string, max = TAIL): string {
  const t = (text ?? '').trim();
  if (t.length <= max) return t;
  return `…(前 ${t.length - max} 字省略)\n${t.slice(-max)}`;
}

/** 记录"要启动某命令"，返回开始时间戳（交给 logProcExit 计算耗时） */
export function logProcSpawn(tag: string, bin: string, args: string[], extra?: Record<string, unknown>): number {
  logger.child(tag).mark('PROC_SPAWN', `执行 ${bin}`, { args, ...(extra ?? {}) });
  return Date.now();
}

/** 记录命令退出 */
export function logProcExit(
  tag: string,
  bin: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  startedAt: number,
  out: { stdout?: string; stderr?: string },
  extra?: Record<string, unknown>,
): void {
  const ms = Date.now() - startedAt;
  const scoped = logger.child(tag);
  const payload: Record<string, unknown> = {
    code,
    signal: signal ?? undefined,
    ms,
    ...(extra ?? {}),
  };
  if (out.stdout) payload.stdout = tailText(out.stdout);
  if (out.stderr) payload.stderr = tailText(out.stderr);
  scoped.mark('PROC_EXIT', `${bin} 退出 code=${code}（${ms}ms）`, payload);
  if (code !== 0) {
    // 再打一条 warn，保证「只看到警告级别」时也不会漏掉失败命令
    scoped.warn(`${bin} 非零退出 code=${code}：${tailText(out.stderr || out.stdout || '(无输出)', 800)}`);
  }
}

/**
 * 给一个子进程挂上日志（自动收集 stdout/stderr 摘要并记录退出）。
 * 调用方的既有监听器不受影响。
 */
export function attachProcessLogging(
  child: ChildProcess,
  opts: { tag: string; bin: string; args: string[]; extra?: Record<string, unknown> },
): number {
  const startedAt = logProcSpawn(opts.tag, opts.bin, opts.args, opts.extra);
  const out = { stdout: '', stderr: '' };
  const cap = (cur: string, chunk: string): string => (cur.length > 20000 ? cur.slice(-20000) : cur) + chunk;
  child.stdout?.on('data', (d: Buffer) => {
    out.stdout = cap(out.stdout, d.toString());
    logger.child(opts.tag).trace(`stdout: ${tailText(d.toString(), 400)}`);
  });
  child.stderr?.on('data', (d: Buffer) => {
    out.stderr = cap(out.stderr, d.toString());
    logger.child(opts.tag).trace(`stderr: ${tailText(d.toString(), 400)}`);
  });
  child.on('close', (code, signal) => logProcExit(opts.tag, opts.bin, code, signal, startedAt, out, opts.extra));
  child.on('error', (e) => {
    logger.child(opts.tag).error(`[MARK:PROC_EXIT] 进程启动/运行失败：${e.message}`, { bin: opts.bin, args: opts.args });
  });
  return startedAt;
}
