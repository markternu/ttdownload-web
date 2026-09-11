import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { logsRepo } from './db';
import { bus } from './events';

type Level = 'debug' | 'info' | 'warn' | 'error';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function rotateIfNeeded(): void {
  try {
    const st = fs.statSync(config.logPath);
    if (st.size > MAX_LOG_BYTES) {
      fs.renameSync(config.logPath, `${config.logPath}.1`);
    }
  } catch {
    /* 文件不存在，忽略 */
  }
}

function write(level: Level, message: string): void {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
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

  if (level !== 'debug') {
    try {
      logsRepo.add(level, message);
    } catch {
      /* DB 可能尚未就绪 */
    }
    bus.emit('log', { level, message, at: new Date().toISOString() });
  }
}

export const logger = {
  debug: (m: string) => write('debug', m),
  info: (m: string) => write('info', m),
  warn: (m: string) => write('warn', m),
  error: (m: string) => write('error', m),
};
