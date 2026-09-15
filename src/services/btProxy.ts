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
  nginxRunning?: boolean | string;
  /** 实测：这个反代地址到底通不通（true=已到达 transmission） */
  verified?: boolean | string | null;
  verifyDetail?: string;
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
  /** authRequired 是怎么来的：session-get（transmission 自己报的）/ probe（无凭据探测 401）/ unknown */
  authRequiredSource: 'session-get' | 'probe' | 'unknown';
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
  /** url 是怎么来的（guessed = 从应用端口直连，按 nginx 默认端口推断，可能不准） */
  urlSource: 'public_base_url' | 'forwarded' | 'guessed' | 'none';
  urlHint: string;
  snippet: string;
  serverFile: string;
  nginxVersion: string;
  /** nginx 服务是否在运行：false = 配置写对了但外网照样打不开；null = 无法判断 */
  nginxRunning: boolean | null;
  /**
   * 实测结论：反代地址是否真的能访问到 transmission。
   * true=已到达（transmission 回 401/409 等）；false=没转发成功；null=未开启/无法判断。
   * 「配置写进去了」不等于「能访问」——这一项才是开关的真正标准。
   */
  verified: boolean | null;
  verifyDetail: string;
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
  } catch (e) {
    // 结果行不是合法 JSON 时绝不能静默返回 null：那样调用方会拿到一份「全是空值」的状态，
    // 页面看起来一切正常却什么都不知道（踩过：脚本输出了裸字符串 unknown）。
    scoped.error(
      `[MARK:${BT_PROXY_MARKER}] 脚本结果行不是合法 JSON（${(e as Error).message}）：${m[1].slice(0, 400)}`,
    );
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
    authRequiredSource: 'unknown',
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
    info.whitelistEnabled = s?.['rpc-whitelist-enabled'] ?? null;
    info.peerPort = s?.['peer-port'] ?? null;
    if (typeof s?.['rpc-authentication-required'] === 'boolean') {
      info.authRequired = s['rpc-authentication-required'];
      info.authRequiredSource = 'session-get';
    }
  } catch (e) {
    scoped.debug(`[MARK:${BT_PROXY_MARKER}] 读取 transmission 会话信息失败：${(e as Error).message}`);
  }
  // transmission 某些版本（实测 4.1.0-beta）的 session-get **不返回** rpc-authentication-required，
  // 那就直接问真正重要的问题：不带任何凭据去访问 WebUI，会不会被拦？
  //   401 + WWW-Authenticate → 需要密码（安全）；200 → 谁都能进（危险）
  if (info.reachable && info.authRequired === null) {
    info.authRequired = await probeAuthRequired(info.rpcHost, info.rpcPort);
    info.authRequiredSource = info.authRequired === null ? 'unknown' : 'probe';
  }
  return info;
}

/** 无凭据探测 transmission WebUI 是否要求登录（401 = 需要密码） */
export async function probeAuthRequired(host: string, port: number, timeoutMs = 4000): Promise<boolean | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/transmission/web/`, {
      method: 'GET',
      redirect: 'manual',
      signal: ac.signal,
    });
    if (res.status === 401 || res.status === 403) return true;
    if (res.status === 200) return false;
    return null;
  } catch (e) {
    scoped.debug(`[MARK:${BT_PROXY_MARKER}] 无凭据探测 WebUI 失败：${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface ProxyOrigin {
  /** 外网基地址（形如 http://1.2.3.4 或 https://example.com），用于拼出可直接点开的链接 */
  base: string;
  /** 这个地址有多可信：public_base_url（最准）/ forwarded（经过反代，准）/ guessed（按 nginx 默认端口猜的） */
  source: 'public_base_url' | 'forwarded' | 'guessed';
  /** 给用户看的说明（guessed 时要提示可能不准） */
  hint: string;
}

/**
 * 推断「用户从外网访问 nginx」的基地址。
 *
 * 坑：反向代理挂在 nginx 的 80/443 上，而我们这个服务可能在 8080 —— 请求的 Host 里带的
 * 是**应用自己的端口**，直接拿来拼 `http://IP:8080/transmission/web/` 是错的（8080 上没有这个路径）。
 * 所以：① PUBLIC_BASE_URL 优先；② 经过反代时用 X-Forwarded-*；③ 直连应用端口时只取主机名、
 * 丢掉应用自己的端口（nginx 默认 80），并在 UI 上注明是推断值。
 */
export function originFromRequest(req: {
  protocol?: string;
  headers?: Record<string, unknown>;
  get?: (name: string) => string | undefined;
  /** 本服务实际监听的端口（Express 的 req.socket.localPort），用来判断请求是不是直连应用端口 */
  socket?: { localPort?: number };
}): ProxyOrigin {
  const envBase = String(process.env.PUBLIC_BASE_URL ?? '').trim();
  if (envBase) {
    return { base: envBase.replace(/\/+$/, ''), source: 'public_base_url', hint: '来自 PUBLIC_BASE_URL 配置' };
  }
  const header = (name: string): string => {
    if (typeof req.get === 'function') return String(req.get(name) ?? '');
    const v = req.headers?.[name.toLowerCase()];
    return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
  };
  const proto = (header('x-forwarded-proto').split(',')[0] || req.protocol || 'http').trim();
  const host = (header('host')).trim();
  const fwdHost = header('x-forwarded-host').split(',')[0].trim();

  if (fwdHost) {
    // 经过反代：X-Forwarded-Host 才是用户看到的域名（可能带自定端口），原样用
    return { base: `${proto}://${fwdHost}`, source: 'forwarded', hint: '按反向代理传来的 X-Forwarded-Host 推断' };
  }

  // 直连：Host 里若是应用自己的端口，说明用户是从 8080 进来的，反代地址要走 nginx 的默认端口
  let hostname = host;
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(host);
  if (m) {
    const port = Number(m[2]);
    const appPort = req.socket?.localPort ?? config.port;
    if (port === appPort) hostname = m[1];
  }
  const guessed = hostname !== host;
  return {
    base: `${proto}://${hostname}`,
    source: guessed ? 'guessed' : 'forwarded',
    hint: guessed
      ? `你是直接从应用端口 ${req.socket?.localPort ?? config.port} 访问的，这里按 nginx 默认端口（80/443）推断；如果反代挂在别的端口，请在 .env 里设 PUBLIC_BASE_URL`
      : '按请求的 Host 推断',
  };
}

export interface BtProxyStatusOptions {
  /** 外网访问地址前缀（形如 http://1.2.3.4），用于拼出可直接点开的链接 */
  origin?: string;
  /** origin 的可信度说明（由 originFromRequest 给出） */
  originHint?: string;
  originSource?: 'public_base_url' | 'forwarded' | 'guessed';
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

  const nginxRunning = script?.nginxRunning === true ? true : script?.nginxRunning === false ? false : null;
  if (script?.verified === false) {
    warnings.push(
      `反代配置已写入，但**实测访问失败**：${script.verifyDetail || '未知原因'}。` +
        `开关虽然显示已开启，但地址现在打不开 —— 请检查 nginx 是否在运行、transmission 是否在 9091 上`,
    );
  }

  if (nginxRunning === false) {
    warnings.push(
      `nginx 服务当前没有在运行（systemctl status ${process.env.NGINX_SERVICE || 'nginx'}）—— 反代配置即使写进去了，外网也打不开，请先启动 nginx`,
    );
  }

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
    urlSource: o.origin ? (o.originSource ?? 'forwarded') : 'none',
    urlHint: o.origin
      ? o.originSource === 'guessed'
        ? o.originHint ||
          `地址是按 nginx 默认端口（80/443）推断的；如果反代挂在别的端口，请在 .env 里设 PUBLIC_BASE_URL`
        : o.originHint || '按请求地址推断'
      : '拿不到请求地址（请用域名/IP 打开本页面）',
    snippet: script?.snippet ?? '',
    serverFile: script?.serverFile ?? '',
    nginxVersion: script?.nginxVersion ?? '',
    nginxRunning,
    verified: script?.verified === true ? true : script?.verified === false ? false : null,
    verifyDetail: script?.verifyDetail ?? '',
    reason: script?.reason ?? scriptError,
    scriptPath,
    scriptFound,
    enabledSubPaths: enabledSubPaths(),
    transmission,
    warnings,
  };
}

/** 开启：先做安全检查（transmission 必须有密码），再交给脚本改 nginx */
export async function enableBtProxy(
  opts: ToggleOptions & BtProxyStatusOptions & { force?: boolean } = {},
): Promise<BtProxyStatus> {
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
  return getBtProxyStatus(opts);
}

export async function disableBtProxy(opts: ToggleOptions & BtProxyStatusOptions = {}): Promise<BtProxyStatus> {
  runToggleScript('disable', opts);
  return getBtProxyStatus(opts);
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
