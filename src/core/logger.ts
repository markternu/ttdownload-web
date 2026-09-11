/**
 * 统一日志（调试期专用增强版）
 *
 * 目标：**遇到任何问题，用户把日志文件发过来就能直接定位**。因此：
 *  - 所有关键路径都打上稳定的「标记」：[MARK:XXX]，可直接 grep 过滤
 *  - 支持 error/warn/info/debug/trace 五级，运行时可切换（网页「日志」页 / API）
 *  - 写文件带大小轮转（app.log / app.log.1 … ），同时保留内存环形缓冲给网页实时查看
 *  - 每次外部命令调用都记录 argv、耗时、退出码、stdout/stderr 摘要
 *  - 敏感值（token/密码/Authorization）自动脱敏
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { logsRepo } from './db';
import { bus } from './events';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

/**
 * 全局标记表：日志里出现 [MARK:XXX] 的地方都能在这里查到含义。
 * 新增埋点时请在此登记；网页「日志」页与诊断包都会列出这张表。
 */
export const MARKERS: Record<string, string> = {
  BOOT: '服务启动/关闭、版本、运行环境摘要',
  CONFIG: '配置加载（下载根目录/端口/并发/保留空间等）',
  HTTP_REQ: 'HTTP 请求进入（方法/路径/来源 IP）',
  HTTP_RES: 'HTTP 响应完成（状态码/耗时/字节数）',
  HTTP_ERR: 'HTTP 处理异常（含 4xx/5xx 与堆栈）',
  SSE: 'SSE 事件推送（task/stats/file/log/space）',
  DISK: '磁盘空间查询',
  DISK_GATE: '调度器磁盘门控判定（放行/等待/暂停）',
  SCHED_TICK: '调度器每一拍（等待数/运行数/各模块并发）',
  TASK_CREATE: '任务创建（模块/URL/来源）',
  TASK_STATE: '任务状态流转（waiting→parsing→downloading→…）',
  TASK_FAIL: '任务失败（含是否走自动重试）',
  TASK_RETRY: '自动重试/手动重试',
  TASK_CANCEL: '取消/删除任务',
  SPACE_FREED: '空间腾挪广播（space-freed）',
  PIPELINE: '归档→加密→发布流水线',
  ARCHIVE: '归档打包（zip/命名/目录移动）',
  ENCRYPT: 'AES 加密与 V-L-T 标记',
  PUBLISH: '发布到消费者目录',
  CLEANUP: '消费者上报完成后的清理',
  BT_EVICT: 'BT 出清判定（10 小时门槛/停滞/极慢）',
  BT_CLEANUP: 'BT 目录清理',
  ANDROID: '安卓端接口调用（鉴权/清单/上报）',
  SETTINGS: '设置读取/更新',
  PROC_SPAWN: '启动外部命令（完整 argv）',
  PROC_EXIT: '外部命令退出（退出码/耗时/stdout/stderr 摘要）',
  ARIA2_RPC: 'aria2 JSON-RPC 调用与结果',
  ARIA2_DAEMON: 'aria2c 守护进程拉起/健康检查',
  TR_RPC: 'transmission JSON-RPC 调用与结果',
  YTDLP_PARSE: 'yt-dlp 解析元数据（-J）',
  YTDLP_ATTEMPT: 'yt-dlp 下载方式切换（策略阶梯）',
  YTDLP_EXIT: 'yt-dlp 单次尝试退出与错误摘要',
  YTDLP_DONE: 'yt-dlp 下载完成与产物文件',
  NET_CHECK: '网络自检（DNS/HTTPS/YouTube/yt-dlp/CDN）',
  DIAG: '诊断包导出',
  TOOL_STATUS: '外部工具可用性探测（--version）',
  ERROR: '未捕获异常/兜底错误（含堆栈）',
};

const levelFromEnv = (): LogLevel => {
  const raw = (process.env.LOG_LEVEL ?? '').toLowerCase().trim();
  if (raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug' || raw === 'trace') return raw;
  // 调试期默认全量：DEBUG=0 可显式降到 info
  if (process.env.DEBUG === '0' || process.env.DEBUG === 'false') return 'info';
  return 'debug';
};

let currentLevel: LogLevel = levelFromEnv();

export function logDir(): string {
  return path.dirname(config.logPath);
}

/** 日志文件（含轮转副本）列表 */
export function listLogFiles(): { name: string; sizeBytes: number; mtime: string }[] {
  const dir = logDir();
  const base = path.basename(config.logPath);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n === base || n.startsWith(`${base}.`));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        return { name, sizeBytes: st.size, mtime: st.mtime.toISOString() };
      } catch {
        return { name, sizeBytes: 0, mtime: new Date(0).toISOString() };
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 读取日志文件（默认当前文件，取尾部 maxBytes 字节） */
export function readLogFile(name?: string, maxBytes = 4 * 1024 * 1024): { name: string; content: string; truncated: boolean } {
  const base = path.basename(config.logPath);
  const target = name && listLogFiles().some((f) => f.name === name) ? name : base;
  const full = path.join(logDir(), target);
  try {
    const st = fs.statSync(full);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(full, 'r');
    try {
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return { name: target, content: buf.toString('utf8'), truncated: start > 0 };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { name: target, content: '', truncated: false };
  }
}

/** 清空所有日志文件 */
export function clearLogs(): { cleared: number; bytes: number } {
  let cleared = 0;
  let bytes = 0;
  for (const f of listLogFiles()) {
    try {
      bytes += f.sizeBytes;
      fs.truncateSync(path.join(logDir(), f.name), 0);
      cleared += 1;
    } catch {
      /* ignore */
    }
  }
  ring.length = 0;
  return { cleared, bytes };
}

/* ------------------------------------------------------------------ */
/* 内存环形缓冲（网页实时查看用）                                        */
/* ------------------------------------------------------------------ */

const RING_MAX = 4000;
const ring: string[] = [];

export interface TailOptions {
  lines?: number;
  level?: LogLevel | 'all';
  q?: string;
  marker?: string;
}

/** 读取最近日志（内存环形缓冲，最新在最后） */
export function tailLogs(opts: TailOptions = {}): string[] {
  const { lines = 300, level = 'all', q = '', marker = '' } = opts;
  let items = ring.slice();
  if (level !== 'all') {
    const min = ORDER[level as LogLevel] ?? 2;
    items = items.filter((l) => {
      const m = l.match(/\[(ERROR|WARN|INFO|DEBUG|TRACE)\s*\]/);
      if (!m) return true;
      return (ORDER[m[1].toLowerCase() as LogLevel] ?? 2) <= min;
    });
  }
  if (marker) items = items.filter((l) => l.includes(`[MARK:${marker}]`));
  if (q) items = items.filter((l) => l.includes(q));
  return items.slice(-lines);
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

const MAX_BYTES = (): number => {
  const mb = Number(process.env.LOG_MAX_MB ?? 20);
  return (Number.isFinite(mb) && mb > 0 ? mb : 20) * 1024 * 1024;
};
const KEEP_FILES = (): number => {
  const n = Number(process.env.LOG_KEEP_FILES ?? 5);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
};

function rotateIfNeeded(): void {
  let size = 0;
  try {
    size = fs.statSync(config.logPath).size;
  } catch {
    return;
  }
  if (size < MAX_BYTES()) return;
  try {
    const keep = KEEP_FILES();
    for (let i = keep - 1; i >= 1; i -= 1) {
      const from = i === 1 ? config.logPath : `${config.logPath}.${i - 1}`;
      const to = `${config.logPath}.${i}`;
      if (!fs.existsSync(from)) continue;
      if (i === keep - 1 && fs.existsSync(to)) fs.unlinkSync(to);
      fs.renameSync(from, to);
    }
  } catch {
    /* 轮转失败不影响写日志 */
  }
}

/** 敏感信息脱敏：同时覆盖 key=value 与 JSON 的 "key":"value" 两种形态 */
export function redact(text: string): string {
  return String(text)
    // "token":"xxx" / 'password': 'xxx' / token=xxx
    .replace(/(["']?)(token|password|passwd|secret|authorization|api[_-]?key)\1(\s*[:=]\s*)(["']?)([^"'\s,&}]+)/gi, '$1$2$1$3$4***')
    .replace(/(X-Auth-Token:\s*)(\S+)/gi, '$1***')
    .replace(/(--rpc-secret[=\s]+)(\S+)/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/g, '$1***');
}

/** 安全序列化（截断超长内容） */
export function dump(data: unknown, maxLen = 2000): string {
  if (data === undefined) return '';
  let text: string;
  try {
    text = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    text = String(data);
  }
  text = redact(text ?? '');
  return text.length > maxLen ? `${text.slice(0, maxLen)}…(截断 ${text.length - maxLen} 字)` : text;
}

function emit(level: LogLevel, marker: string | null, scope: string | null, message: string, data?: unknown): void {
  const at = new Date().toISOString();
  const markerPart = marker ? ` [MARK:${marker}]` : '';
  const scopePart = scope ? ` [${scope}]` : '';
  const dataPart = data === undefined ? '' : ` :: ${dump(data)}`;
  const line = `${at} [${level.toUpperCase().padEnd(5)}]${markerPart}${scopePart} ${redact(message)}${dataPart}`;

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  try {
    fs.mkdirSync(path.dirname(config.logPath), { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(config.logPath, `${line}\n`);
  } catch {
    /* 日志写失败不影响主流程 */
  }

  ring.push(line);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);

  if (ORDER[level] <= ORDER.info) {
    try {
      logsRepo.add(level, `${marker ? `[${marker}] ` : ''}${scope ? `[${scope}] ` : ''}${message}${dataPart}`);
    } catch {
      /* DB 可能尚未就绪 */
    }
  }
  if (ORDER[level] <= ORDER.debug) {
    try {
      bus.emit('log', { level, marker, scope, message: redact(message), at });
    } catch {
      /* ignore */
    }
  }
}

export interface ScopedLogger {
  error(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
  trace(message: string, data?: unknown): void;
  /** 带标记：mark('YTDLP_ATTEMPT', '切换方式', {...}) */
  mark(marker: string, message: string, data?: unknown): void;
  child(scope: string): ScopedLogger;
}

function makeScoped(scope: string | null): ScopedLogger {
  const build = (marker: string | null, level: LogLevel, message: string, data?: unknown): void => {
    if (ORDER[level] > ORDER[currentLevel]) return;
    emit(level, marker, scope, message, data);
  };
  return {
    error: (m, d) => build(null, 'error', m, d),
    warn: (m, d) => build(null, 'warn', m, d),
    info: (m, d) => build(null, 'info', m, d),
    debug: (m, d) => build(null, 'debug', m, d),
    trace: (m, d) => build(null, 'trace', m, d),
    mark: (marker, m, d) => build(marker, 'info', m, d),
    child: (s) => makeScoped(scope ? `${scope}>${s}` : s),
  };
}

export const logger = {
  ...makeScoped(null),
  setLevel(level: LogLevel): void {
    currentLevel = level;
    emit('info', 'SETTINGS', 'logger', `日志级别切换为 ${level}`);
  },
  getLevel: (): LogLevel => currentLevel,
  isDebug: (): boolean => ORDER[currentLevel] >= ORDER.debug,
  isTrace: (): boolean => currentLevel === 'trace',
  filePath: (): string => config.logPath,
  markers: (): { marker: string; description: string }[] =>
    Object.entries(MARKERS).map(([marker, description]) => ({ marker, description })),
  /** 已经出现过的标记（网页过滤下拉用） */
  usedMarkers: (): string[] => {
    const set = new Set<string>();
    for (const line of ring) {
      const m = line.match(/\[MARK:([A-Z0-9_]+)\]/g);
      if (m) for (const one of m) set.add(one.slice(6, -1));
    }
    return Array.from(set).sort();
  },
};

/** 任务作用域日志：taskLog(12, 'ytdlp').mark('YTDLP_ATTEMPT', ...) */
export function taskLog(taskId: number, sub?: string): ScopedLogger {
  return logger.child(sub ? `task#${taskId}>${sub}` : `task#${taskId}`);
}
