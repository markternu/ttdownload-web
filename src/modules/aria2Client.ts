import net from 'node:net';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { aria2Rpc } from '../services/settings';

/**
 * 极简 aria2 JSON-RPC 客户端（HTTP POST，支持 token）。
 *
 * 默认值走 aria2Rpc()（**设置页优先、回落 .env**）：以前直接绑 config.aria2Rpc，
 * 于是网页「设置 → aria2 RPC」里改的 host/port/secret 完全不生效（和 transmission 同一处血案）。
 */
export class Aria2Client {
  constructor(
    private readonly host = aria2Rpc().host,
    private readonly port = aria2Rpc().port,
    private readonly secret = aria2Rpc().secret,
  ) {}

  get url(): string {
    return `http://${this.host}:${this.port}/jsonrpc`;
  }

  async call<T = unknown>(method: string, params: unknown[] = [], timeoutMs = 8000): Promise<T> {
    const payload = {
      jsonrpc: '2.0',
      id: `web-${Date.now()}`,
      method,
      params: this.secret ? [`token:${this.secret}`, ...params] : params,
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const startedAt = Date.now();
    const scoped = logger.child('aria2');
    scoped.debug(`[MARK:ARIA2_RPC] -> ${method}`, { params: params.length ? params : undefined, timeoutMs });
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      const text = await res.text();
      let json: { result?: T; error?: { code: number; message: string } };
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`aria2 RPC 响应无法解析: ${text.slice(0, 200)}`);
      }
      if (!res.ok || json.error) {
        scoped.warn(`[MARK:ARIA2_RPC] <- ${method} 失败 http=${res.status}（${Date.now() - startedAt}ms）`, {
          error: json.error,
          body: text.slice(0, 400),
        });
        throw new Error(`aria2 RPC 错误: ${json.error?.message ?? res.status}`);
      }
      scoped.debug(`[MARK:ARIA2_RPC] <- ${method} ok（${Date.now() - startedAt}ms）`, { result: json.result });
      return json.result as T;
    } catch (e) {
      scoped.warn(`[MARK:ARIA2_RPC] <- ${method} 异常（${Date.now() - startedAt}ms）: ${(e as Error).message}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async version(): Promise<string> {
    const r = await this.call<{ version: string }>('aria2.getVersion');
    return r?.version ?? 'unknown';
  }

  async ping(): Promise<boolean> {
    try {
      await this.call('aria2.getVersion', [], 3000);
      return true;
    } catch {
      return false;
    }
  }
}

export function portOpen(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v: boolean): void => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

export function aria2Client(): Aria2Client {
  return new Aria2Client();
}

let lastSpawnAttempt = 0;
let lastSpawnError = '';
const SPAWN_COOLDOWN_MS = 60_000;

/** 若 aria2 RPC 未在监听，尝试自动拉起 aria2c 守护进程（一键部署/免手工） */
export async function ensureAria2Daemon(): Promise<{ ok: boolean; message: string }> {
  const client = aria2Client();
  if (await client.ping()) {
    try {
      return { ok: true, message: `aria2 RPC 已就绪 (${await client.version()})` };
    } catch {
      return { ok: true, message: 'aria2 RPC 已就绪' };
    }
  }
  // 避免在 aria2c 缺失时每个调度周期都尝试拉起并刷屏
  if (Date.now() - lastSpawnAttempt < SPAWN_COOLDOWN_MS && lastSpawnError) {
    return { ok: false, message: lastSpawnError };
  }
  lastSpawnAttempt = Date.now();

  const { spawn } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');
  // 用"设置页优先"的 RPC 参数拉起守护进程，保证监听端口/secret 与调用侧一致
  const rpc = aria2Rpc();
  fs.mkdirSync(config.dirs.aria2, { recursive: true });
  const session = path.join(config.dirs.state, 'aria2.session');
  const pidFile = path.join(config.dirs.state, 'aria2.pid');
  try {
    if (!fs.existsSync(session)) fs.writeFileSync(session, '');
    const args = [
      '--enable-rpc',
      '--rpc-listen-all=false',
      `--rpc-listen-port=${rpc.port}`,
      '--continue=true',
      '--rpc-allow-origin-all=true',
      `--dir=${config.dirs.aria2}`,
      `--input-file=${session}`,
      `--save-session=${session}`,
      '--save-session-interval=5',
      '--max-concurrent-downloads=5',
      '--split=10',
      '--max-connection-per-server=16',
      '--min-split-size=10M',
      '--check-certificate=false',
      '--file-allocation=none',
      '--disable-ipv6=true',
      '--quiet=true',
      ...(rpc.secret ? [`--rpc-secret=${rpc.secret}`] : []),
    ];
    let spawnError: string | null = null;
    logger.child('aria2').mark('ARIA2_DAEMON', '拉起 aria2c 守护进程', { bin: config.bins.aria2, args });
    const child = spawn(config.bins.aria2, args, { detached: true, stdio: 'ignore' });
    child.on('error', (e) => {
      // 必须消费 error 事件，否则会变成 uncaughtException 拖垮进程
      spawnError = e.message;
    });
    child.unref();
    if (child.pid) fs.writeFileSync(pidFile, String(child.pid));

    for (let i = 0; i < 12; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      if (spawnError) {
        lastSpawnError = `aria2 启动失败：${spawnError}（请安装 aria2：sudo apt install -y aria2）`;
        logger.error(lastSpawnError);
        return { ok: false, message: lastSpawnError };
      }
      if (await client.ping()) {
        lastSpawnError = '';
        return { ok: true, message: 'aria2 守护进程已自动启动' };
      }
    }
    lastSpawnError =
      `aria2 已尝试启动（${config.bins.aria2}）但 RPC ${rpc.host}:${rpc.port} 仍未监听` +
      `（常见原因：端口被占用、二进制不可执行、${config.dirs.state} 不可写、aria2c 立即退出）`;
    logger.child('aria2').error(`[MARK:ARIA2_DAEMON] ${lastSpawnError}`, {
      bin: config.bins.aria2,
      port: rpc.port,
      stateDir: config.dirs.state,
    });
    return { ok: false, message: lastSpawnError };
  } catch (e) {
    lastSpawnError = `aria2 不可用: ${(e as Error).message}`;
    logger.error(lastSpawnError);
    return { ok: false, message: lastSpawnError };
  }
}
