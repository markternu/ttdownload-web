/**
 * transmission 反向代理开关（把 127.0.0.1:9091 通过 nginx 子路径暴露到外网）
 *
 * 背景：远程服务器通常只开放 22/80/443，transmission 的 WebUI/RPC 只监听
 *       127.0.0.1:9091，外网直接访问不到（这正是 BT 种子页面上「打开 transmission」
 *       按钮点不动的原因）。这里提供一个开关：开启后在 nginx 里加一个 location，
 *       把 http://<域名>/transmission/ 反代到 127.0.0.1:9091；关闭则彻底移除，
 *       外界再也访问不到（不是靠防火墙，是配置里真的没有了）。
 *
 * 实现方式：调用 deploy/scripts/nginx-proxy-toggle.sh（同一份脚本也能手工跑），
 *          由它负责备份 / 插入 include / nginx -t / 失败回滚 / reload。
 *          本服务只做参数校验、结果解析、日志埋点与状态汇总。
 *
 * 安全：暴露 9091 等于把 BT 控制台放到公网，所以：
 *        - transmission 若未开启 rpc 密码（rpc-authentication-required=false），默认**拒绝开启**，
 *          必须显式 force 才允许（页面上会红字警告）；
 *        - 所有动作打 [MARK:NGINX_PROXY] 日志，便于排查。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { transmissionClient } from '../modules/transmission';
import { HttpError } from '../utils/http';

const scoped = logger.child('bt-proxy');

/** 默认子路径：transmission WebUI 自带 /transmission 前缀，去掉会 404 */
const DEFAULT_SUB_PATH = process.env.BT_PROXY_SUBPATH || '/transmission';

export const BT_PROXY_MARKER = 'NGINX_PROXY';

export interface BtProxyScriptResult {
  enabled: boolean;
  subPath: string;
  target: string;
  snippet: string;
  serverFile: string;
  nginxVersion: string;
  reason: string;
}

export interface BtProxyTransmissionInfo {
  reachable: boolean;
  version: string | null;
  rpcHost: string;
  rpcPort: number;
  /** RPC 用户名（密码绝不外传；仅用于提示用户在 WebUI 登录时填什么） */
  rpcUser: string;
  /** 是否要求用户名密码（false = 谁能连上谁就能控制，公网暴露非常危险） */
  authRequired: boolean | null;
  whitelistEnabled: boolean | null;
  peerPort: number | null;
}

export interface BtProxyStatus {
  /** 开关是否可用（脚本存在 + nginx 可用） */
  available: boolean;
  enabled: boolean;
  subPath: string;
  target: string;
  /** 开启后外网访问地址（形如 http://1.2.3.4/transmission/web/） */
  url: string | null;
  rpcUrl: string | null;
  snippet: string;
  serverFile: string;
  nginxVersion: string;
  /** 不可用/需人工处理的原因（'' 表示一切正常） */
  reason: string;
  scriptPath: string;
  scriptFound: boolean;
  /** 当前 nginx 里所有已生效的子路径反代（一般只有一个） */
  enabledSubPaths: string[];
  transmission: BtProxyTransmissionInfo;
  warnings: string[];
}

export function btProxySubPath(): string {
  const raw = (process.env.BT_PROXY_SUBPATH || DEFAULT_SUB_PATH).trim();
  const withSlash = `/${raw.replace(/^\/+/, '')}`;
  return withSlash.replace(/\/+$/, '') || '/transmission';
}

export function btProxyTarget(): string {
  return process.env.BT_PROXY_TARGET || `127.0.0.1:${config.transmissionRpc.port}`;
}

/** 脚本位置：dist/services → ../../deploy/scripts（开发态 src/services → 同样相对路径） */
export function btProxyScriptPath(): string {
  const override = process.env.BT_PROXY_SCRIPT;
  if (override) return override;
  return path.resolve(__dirname, '..', '..', 'deploy', 'scripts', 'nginx-proxy-toggle.sh');
}

function parseResult(stdout: string): BtProxyScriptResult | null {
  const m = stdout.match(/TTDL_NGINX_PROXY_RESULT=(\{.*\})/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as BtProxyScriptResult;
  } catch {
    return null;
  }
}

/** 子路径/目标先把格式校验收在前面：否则会以 500 的形式把脚本的报错抛给用户 */
function assertSubPath(p?: string): void {
  if (!p) return;
  if (!/^\/?[A-Za-z0-9._/-]+$/.test(p)) {
    throw new HttpError(400, 'BAD_SUBPATH', `子路径只能包含字母数字与 . _ - /：${p}`);
  }
}

function assertTarget(t?: string): void {
  if (!t) return;
  const m = /^([A-Za-z0-9._-]+):(\d{1,5})$/.exec(t);
  const port = m ? Number(m[2]) : 0;
  if (!m || port < 1 || port > 65535) {
    throw new HttpError(400, 'BAD_TARGET', `反代目标需形如 127.0.0.1:9091（端口 1-65535）：${t}`);
  }
}

interface ToggleOptions {
  subPath?: string;
  target?: string;
  /** 测试用：绝不 reload（只写配置） */
  noReload?: boolean;
}

/**
 * 调用开关脚本。脚本自己会在改完配置后跑 nginx -t，失败会回滚并以非 0 退出，
 * 这里把 stderr 摘要抛出去，页面上直接展示给用户。
 */
export function runToggleScript(
  action: 'status' | 'preview' | 'enable' | 'disable',
  opts: ToggleOptions = {},
): { result: BtProxyScriptResult | null; stdout: string; stderr: string } {
  assertSubPath(opts.subPath);
  assertTarget(opts.target);
  const script = btProxyScriptPath();
  if (!fs.existsSync(script)) {
    throw new HttpError(500, 'BT_PROXY_SCRIPT_MISSING', `开关脚本不存在：${script}（请先 deploy.sh --update 同步代码）`);
  }
  const args = [script, action, '--path', opts.subPath || btProxySubPath(), '--target', opts.target || btProxyTarget()];
  if (opts.noReload) args.push('--no-reload');
  const startedAt = Date.now();
  scoped.info(`[MARK:${BT_PROXY_MARKER}] ${action}：bash ${args.join(' ')}`);
  try {
    const stdout = execFileSync('bash', args, {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = parseResult(stdout);
    scoped.info(
      `[MARK:${BT_PROXY_MARKER}] ${action} 完成（${Date.now() - startedAt}ms）：enabled=${result?.enabled ?? 'unknown'} subPath=${result?.subPath ?? '-'} target=${result?.target ?? '-'}`,
      { serverFile: result?.serverFile, reason: result?.reason },
    );
    return { result, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string; signal?: string };
    const stderr = String(err.stderr ?? '');
    const stdout = String(err.stdout ?? '');
    scoped.error(`[MARK:${BT_PROXY_MARKER}] ${action} 失败（退出码 ${err.status ?? 'n/a'}）：${stderr.trim() || err.message}`, {
      args,
    });
    throw new HttpError(
      500,
      'BT_PROXY_FAILED',
      `nginx 反代「${action}」失败：${(stderr.trim() || err.message || '未知错误').slice(-800)}`,
    );
  }
}

async function transmissionInfo(): Promise<BtProxyTransmissionInfo> {
  const info: BtProxyTransmissionInfo = {
    reachable: false,
    version: null,
    rpcHost: config.transmissionRpc.host,
    rpcPort: config.transmissionRpc.port,
    rpcUser: config.transmissionRpc.user,
    authRequired: null,
    whitelistEnabled: null,
    peerPort: null,
  };
  try {
    const s = await transmissionClient().call<{
      version?: string;
      'rpc-authentication-required'?: boolean;
      'rpc-whitelist-enabled'?: boolean;
      'peer-port'?: number;
    }>('session-get', {}, 5000);
    info.reachable = true;
    info.version = s?.version ?? 'unknown';
    info.authRequired = s?.['rpc-authentication-required'] ?? null;
    info.whitelistEnabled = s?.['rpc-whitelist-enabled'] ?? null;
    info.peerPort = s?.['peer-port'] ?? null;
  } catch (e) {
    scoped.debug(`[MARK:${BT_PROXY_MARKER}] 读取 transmission 会话信息失败：${(e as Error).message}`);
  }
  return info;
}

/** 从请求头推断外网访问地址（反向代理下用 x-forwarded-*） */
export function originFromRequest(req: {
  protocol?: string;
  headers?: Record<string, unknown>;
  get?: (name: string) => string | undefined;
}): string {
  const envBase = String(process.env.PUBLIC_BASE_URL ?? '').trim();
  if (envBase) return envBase.replace(/\/+$/, '');
  const header = (name: string): string => {
    if (typeof req.get === 'function') return String(req.get(name) ?? '');
    const v = req.headers?.[name.toLowerCase()];
    return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
  };
  const proto = (header('x-forwarded-proto').split(',')[0] || req.protocol || 'http').trim();
  const host = (header('x-forwarded-host').split(',')[0] || header('host')).trim();
  return `${proto}://${host}`;
}

export interface BtProxyStatusOptions {
  /** 外网访问地址前缀（形如 http://1.2.3.4），用于拼出可直接点开的链接 */
  origin?: string;
  /** 查看哪个子路径的状态（默认取 BT_PROXY_SUBPATH） */
  subPath?: string;
  target?: string;
}

/** 扫描 snippets 目录，列出所有已生效的托管反代 */
export function enabledSubPaths(): string[] {
  const dir = path.join(process.env.NGINX_CONF_DIR || '/etc/nginx', 'snippets');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('ttdownload-proxy-') && f.endsWith('.conf'))
      .map((f) => `/${f.slice('ttdownload-proxy-'.length, -'.conf'.length)}`)
      .sort();
  } catch {
    return [];
  }
}

export async function getBtProxyStatus(opts: BtProxyStatusOptions | string = {}): Promise<BtProxyStatus> {
  // 兼容旧调用：getBtProxyStatus('http://1.2.3.4')
  const o: BtProxyStatusOptions = typeof opts === 'string' ? { origin: opts } : opts;
  const scriptPath = btProxyScriptPath();
  const scriptFound = fs.existsSync(scriptPath);
  const transmission = await transmissionInfo();
  const warnings: string[] = [];

  let script: BtProxyScriptResult | null = null;
  let scriptError = '';
  if (scriptFound) {
    try {
      script = runToggleScript('status', { subPath: o.subPath, target: o.target }).result;
    } catch (e) {
      scriptError = (e as Error).message;
    }
  }

  const subPath = script?.subPath || o.subPath || btProxySubPath();
  const target = script?.target || o.target || btProxyTarget();
  const enabled = script?.enabled ?? false;
  const available = scriptFound && !!script && !!script.nginxVersion && !script.reason;

  if (!scriptFound) warnings.push(`反代开关脚本不存在（${scriptPath}），请先执行 deploy.sh --update 同步最新代码`);
  else if (scriptError) warnings.push(scriptError);
  else if (script?.reason) warnings.push(script.reason);

  if (!transmission.reachable) {
    warnings.push('当前连不上 transmission RPC（先确认 BT 服务已在跑），开启反代后也可能打不开 WebUI');
  } else if (transmission.authRequired === false) {
    warnings.push(
      '⚠️ transmission 没有设置 RPC 密码（rpc-authentication-required=false）。此时把 9091 暴露到公网 = 任何人都能控制你的 BT，请先在 transmission 设置里加用户名密码',
    );
  }

  const base = o.origin?.replace(/\/+$/, '') || '';
  const url = base ? `${base}${subPath}/web/` : null;
  const rpcUrl = base ? `${base}${subPath}/rpc` : null;

  return {
    available: enabled || available,
    enabled,
    subPath,
    target,
    url,
    rpcUrl,
    snippet: script?.snippet ?? '',
    serverFile: script?.serverFile ?? '',
    nginxVersion: script?.nginxVersion ?? '',
    reason: script?.reason ?? scriptError,
    scriptPath,
    scriptFound,
    enabledSubPaths: enabledSubPaths(),
    transmission,
    warnings,
  };
}

/** 开启：先做安全检查（transmission 必须有密码），再交给脚本改 nginx */
export async function enableBtProxy(opts: ToggleOptions & { force?: boolean } = {}): Promise<BtProxyStatus> {
  const info = await transmissionInfo();
  if (info.reachable && info.authRequired === false && !opts.force) {
    scoped.warn(`[MARK:${BT_PROXY_MARKER}] 拒绝开启：transmission 未要求密码，暴露到公网不安全`);
    throw new HttpError(
      400,
      'BT_PROXY_NO_AUTH',
      'transmission 没有设置 RPC 密码，拒绝把它暴露到公网。请先在 transmission 里设置用户名/密码；确实要开可勾选「我已了解风险」强制开启',
    );
  }
  const { result } = runToggleScript('enable', opts);
  if (!result?.enabled) {
    throw new HttpError(500, 'BT_PROXY_NOT_ENABLED', `脚本执行完毕但状态仍为未开启：${result?.reason || '未知原因'}`);
  }
  return getBtProxyStatus({ subPath: opts.subPath, target: opts.target });
}

export async function disableBtProxy(opts: ToggleOptions = {}): Promise<BtProxyStatus> {
  runToggleScript('disable', opts);
  return getBtProxyStatus({ subPath: opts.subPath, target: opts.target });
}

export function previewBtProxy(opts: ToggleOptions = {}): { config: string; include: string } {
  const { result, stdout } = runToggleScript('preview', opts);
  const subPath = result?.subPath || opts.subPath || btProxySubPath();
  const snippet = result?.snippet || '';
  const body = stdout
    .split('\n')
    .filter((l) => !l.startsWith('TTDL_NGINX_PROXY_RESULT=') && !l.startsWith('[nginx-proxy]'))
    .join('\n')
    .trim();
  return { config: body, include: snippet ? `include ${snippet}; # ttdownload-web managed (${subPath})` : '' };
}
