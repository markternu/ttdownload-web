/**
 * 网络自检：把「在线视频下载」真正依赖的每一段链路都测一遍，结果直接显示在网页上。
 *
 * 背景：项目跑在树莓派上，网线接 OpenWrt 路由器；git clone / 部署都正常，
 * 但「出网下载视频」还依赖 DNS、YouTube 可达性、yt-dlp 解析、googlevideo CDN 可达性。
 * 这里逐项测试并给出中文原因与修复建议。
 */
import dns from 'node:dns/promises';
import { spawn } from 'node:child_process';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { toolStatus } from '../core/disk';
import { getSettings } from './settings';
import { parseExtraArgs, resolveCookiesFile } from '../modules/webvideo';

export type CheckStatus = 'ok' | 'fail' | 'skip' | 'running';
export type CheckGroup = 'net' | 'ytdlp' | 'local';

export interface NetworkCheck {
  id: string;
  label: string;
  status: CheckStatus;
  latencyMs: number | null;
  detail: string;
  hint?: string;
  group: CheckGroup;
}

export interface NetworkReport {
  checkedAt: string;
  cached: boolean;
  overall: 'ok' | 'partial' | 'fail';
  summary: string;
  proxy: { env: Record<string, string>; extraArgs: string };
  checks: NetworkCheck[];
}

/** YouTube 上 yt-dlp 官方长期存在的测试视频（公开、稳定） */
const TEST_VIDEO = 'https://www.youtube.com/watch?v=BaW_jenozKc';

function maskProxy(value: string): string {
  return value.replace(/\/\/([^/@\s]+)@/, '//***@');
}

function proxyEnv(): Record<string, string> {
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v) out[k] = maskProxy(String(v));
  }
  return out;
}

async function fetchProbe(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; latencyMs: number; detail: string }> {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    const latencyMs = Date.now() - started;
    return { ok: res.status < 400, status: res.status, latencyMs, detail: `HTTP ${res.status}` };
  } catch (e) {
    const latencyMs = Date.now() - started;
    const msg = (e as Error).name === 'AbortError' ? `超时（>${timeoutMs}ms）` : (e as Error).message;
    return { ok: false, status: 0, latencyMs, detail: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** 运行 yt-dlp 并收集输出（网络自检用，带超时） */
function runYtDlp(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(config.bins.ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

function commonYtDlpArgs(extraArgs: string[], cookiesFile: string | null, cookiesFromBrowser: string): string[] {
  return [
    '--no-warnings',
    '--no-playlist',
    '--socket-timeout',
    '15',
    ...(cookiesFile ? ['--cookies', cookiesFile] : cookiesFromBrowser ? ['--cookies-from-browser', cookiesFromBrowser] : []),
    ...extraArgs,
  ];
}

/** 执行一次完整自检 */
async function runChecks(): Promise<NetworkReport> {
  const scoped = logger.child('netcheck');
  scoped.mark('NET_CHECK', '开始网络自检', { testVideo: TEST_VIDEO });

  const settings = getSettings();
  const extraArgsRaw = String(settings.webvideoExtraArgs ?? '');
  const extraArgs = parseExtraArgs(extraArgsRaw);
  const cookiesFile = resolveCookiesFile(settings);
  const cookiesFromBrowser = cookiesFile ? '' : String(settings.webvideoCookiesFromBrowser ?? '').trim();
  const env = proxyEnv();
  const checks: NetworkCheck[] = [];

  // ---- 0) 代理配置（信息项） ----
  checks.push({
    id: 'proxy',
    label: '代理配置',
    status: 'ok',
    latencyMs: null,
    detail:
      Object.keys(env).length || extraArgsRaw.trim()
        ? `环境变量：${Object.entries(env)
            .map(([k, v]) => `${k}=${v}`)
            .join('，') || '(无)'}；yt-dlp 额外参数：${extraArgsRaw.trim() || '(无)'}`
        : '未配置代理（直连）',
    group: 'net',
  });

  // ---- 1) DNS ----
  const hosts = ['www.youtube.com', 'redirector.googlevideo.com', 'github.com'];
  {
    const started = Date.now();
    const results = await Promise.all(
      hosts.map(async (h) => {
        try {
          const r = await dns.lookup(h);
          return { host: h, ok: true, ip: r.address };
        } catch (e) {
          return { host: h, ok: false, ip: (e as Error).message };
        }
      }),
    );
    const bad = results.filter((r) => !r.ok);
    checks.push({
      id: 'dns',
      label: 'DNS 解析（YouTube / googlevideo / GitHub）',
      status: bad.length === 0 ? 'ok' : bad.length === hosts.length ? 'fail' : 'ok',
      latencyMs: Date.now() - started,
      detail: results.map((r) => `${r.host} → ${r.ip}`).join('；'),
      hint:
        bad.length > 0
          ? '解析失败：把树莓派的 DNS 指到路由器(OpenWrt)或公共 DNS（223.5.5.5 / 1.1.1.1），并检查 OpenWrt 的 DNS 转发是否正常'
          : undefined,
      group: 'net',
    });
  }

  const httpTargets: { id: string; label: string; url: string; hint: string }[] = [
    {
      id: 'https-google',
      label: 'HTTPS 直连 Google',
      url: 'https://www.google.com/generate_204',
      hint: '基础外网不通：检查树莓派的网关/DNS（OpenWrt 是否对它做了限速或防火墙隔离），或给 yt-dlp 配代理参数 --proxy',
    },
    {
      id: 'https-youtube',
      label: 'HTTPS 直连 YouTube 首页',
      url: 'https://www.youtube.com/robots.txt',
      hint: 'YouTube 首页不通：确认 OpenWrt 上该设备的分流/代理规则是否覆盖树莓派 IP，或改用 --proxy 让 yt-dlp 走代理',
    },
    {
      id: 'https-github',
      label: 'HTTPS 直连 GitHub',
      url: 'https://api.github.com/zen',
      hint: 'GitHub 不通：部署/更新会失败，检查 DNS 与防火墙',
    },
  ];

  // ---- 2) HTTPS 直连（Google / YouTube / GitHub）：三个探测并发 ----
  const httpsTasks = httpTargets.map(async (t) => {
    const r = await fetchProbe(t.url, 8000);
    return {
      id: t.id,
      label: t.label,
      status: (r.ok ? 'ok' : 'fail') as CheckStatus,
      latencyMs: r.latencyMs,
      detail: r.ok ? `${r.detail}，耗时 ${r.latencyMs}ms` : `${t.url} 失败：${r.detail}`,
      hint: r.ok ? undefined : t.hint,
      group: 'net' as CheckGroup,
    };
  });

  // ---- 3) yt-dlp 与 6) 本机 RPC 互不依赖：并发跑，缩短等待 ----
  const ytdlpTask = (async (): Promise<NetworkCheck[]> => {
    const out: NetworkCheck[] = [];
    const ytVersion = await toolStatus(config.bins.ytdlp, ['--version']);
    out.push({
      id: 'ytdlp-version',
      label: 'yt-dlp 可执行',
      status: ytVersion.ok ? 'ok' : 'fail',
      latencyMs: null,
      detail: ytVersion.ok ? `${config.bins.ytdlp} → ${ytVersion.version}` : `不可用：${ytVersion.error ?? '未安装'}`,
      hint: ytVersion.ok ? undefined : '安装：sudo apt install -y yt-dlp 或 pip3 install -U yt-dlp（部署脚本会自动装）',
      group: 'ytdlp',
    });
    if (!ytVersion.ok) {
      out.push({
        id: 'ytdlp-youtube-meta',
        label: 'yt-dlp 解析 YouTube 元数据',
        status: 'skip',
        latencyMs: null,
        detail: 'yt-dlp 不可用，跳过',
        group: 'ytdlp',
      });
      out.push({
        id: 'youtube-cdn',
        label: '视频 CDN（googlevideo）可达',
        status: 'skip',
        latencyMs: null,
        detail: 'yt-dlp 不可用，跳过',
        group: 'ytdlp',
      });
      return out;
    }

    const args = ['-J', ...commonYtDlpArgs(extraArgs, cookiesFile, cookiesFromBrowser), TEST_VIDEO];
    const r = await runYtDlp(args, 30000);
    let firstFormatUrl: string | null = null;
    if (r.code === 0) {
      let title = '(解析成功)';
      try {
        const info = JSON.parse(r.stdout) as { title?: string; formats?: { url?: string; format_id?: string }[] };
        title = info.title ?? title;
        firstFormatUrl = (info.formats ?? []).find((f) => typeof f.url === 'string')?.url ?? null;
      } catch {
        /* 解析 JSON 失败也算通过 */
      }
      out.push({
        id: 'ytdlp-youtube-meta',
        label: 'yt-dlp 解析 YouTube 元数据',
        status: 'ok',
        latencyMs: null,
        detail: `成功：${title}（测试视频 ${TEST_VIDEO}）`,
        group: 'ytdlp',
      });
      scoped.mark('NET_CHECK', 'yt-dlp 解析 YouTube 成功', { title });
    } else {
      const err = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).pop() ?? '未知错误';
      out.push({
        id: 'ytdlp-youtube-meta',
        label: 'yt-dlp 解析 YouTube 元数据',
        status: 'fail',
        latencyMs: null,
        detail: `${r.timedOut ? '超时' : `退出码 ${r.code}`}：${err.slice(0, 300)}`,
        hint: 'YouTube 元数据拿不到：多为出口无法访问 YouTube 或需要登录校验；在「设置 → 公开视频（yt-dlp）」填代理参数（--proxy ...）或上传 cookies.txt 后重试',
        group: 'ytdlp',
      });
      scoped.warn('[MARK:NET_CHECK] yt-dlp 解析 YouTube 失败', { code: r.code, timedOut: r.timedOut, err: err.slice(0, 400) });
      return out;
    }

    const urlArgs = ['-f', 'worst', '--get-url', ...commonYtDlpArgs(extraArgs, cookiesFile, cookiesFromBrowser), TEST_VIDEO];
    const u = await runYtDlp(urlArgs, 30000);
    const cdnUrl = (u.stdout || firstFormatUrl || '').trim().split('\n')[0] || '';
    if (!cdnUrl.startsWith('http')) {
      out.push({
        id: 'youtube-cdn',
        label: '视频 CDN（googlevideo）可达',
        status: 'skip',
        latencyMs: null,
        detail: `未能取得视频直链：${(u.stderr || u.stdout).trim().slice(0, 200)}`,
        group: 'ytdlp',
      });
      return out;
    }
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    try {
      const res = await fetch(cdnUrl, { headers: { Range: 'bytes=0-0' }, signal: ac.signal });
      out.push({
        id: 'youtube-cdn',
        label: '视频 CDN（googlevideo）可达',
        status: res.status < 400 ? 'ok' : 'fail',
        latencyMs: Date.now() - started,
        detail: `HTTP ${res.status}，耗时 ${Date.now() - started}ms（能拿到直链并可访问，说明真的能下载）`,
        hint: res.status < 400 ? undefined : '拿到了视频地址但 CDN 拒绝访问：通常是出口被限制，给 yt-dlp 配 --proxy 或检查 OpenWrt 的分流规则',
        group: 'ytdlp',
      });
    } catch (e) {
      out.push({
        id: 'youtube-cdn',
        label: '视频 CDN（googlevideo）可达',
        status: 'fail',
        latencyMs: Date.now() - started,
        detail: `连接失败：${(e as Error).name === 'AbortError' ? '超时（>10s）' : (e as Error).message}`,
        hint: 'googlevideo 连不上：多数是代理/分流没覆盖该域名（yt-dlp 的 --proxy 可解决），或 OpenWrt 防火墙拦了',
        group: 'ytdlp',
      });
    } finally {
      clearTimeout(timer);
    }
    return out;
  })();

  const localTask = (async (): Promise<NetworkCheck[]> => {
    const out: NetworkCheck[] = [];
    try {
      const { aria2Client } = await import('../modules/aria2Client');
      const started = Date.now();
      const ok = await aria2Client().ping();
      out.push({
        id: 'aria2-rpc',
        label: 'aria2 RPC（URL 直链模块）',
        status: ok ? 'ok' : 'fail',
        latencyMs: Date.now() - started,
        detail: ok ? `可用（${config.aria2Rpc.host}:${config.aria2Rpc.port}）` : `不可用（${config.aria2Rpc.host}:${config.aria2Rpc.port}）`,
        hint: ok ? undefined : 'aria2c 未安装或未启动：sudo apt install -y aria2（服务会自动拉起守护进程），端口被占用时改 .env 的 ARIA2_RPC_PORT',
        group: 'local',
      });
    } catch (e) {
      out.push({ id: 'aria2-rpc', label: 'aria2 RPC（URL 直链模块）', status: 'fail', latencyMs: null, detail: `检测异常：${(e as Error).message}`, group: 'local' });
    }
    try {
      const { transmissionClient } = await import('../modules/transmission');
      const started = Date.now();
      const ok = await transmissionClient().ping();
      out.push({
        id: 'transmission-rpc',
        label: 'transmission RPC（BT 模块）',
        status: ok ? 'ok' : 'fail',
        latencyMs: Date.now() - started,
        detail: ok
          ? `可用（${config.transmissionRpc.host}:${config.transmissionRpc.port}）`
          : `不可用（${config.transmissionRpc.host}:${config.transmissionRpc.port}）`,
        hint: ok
          ? undefined
          : 'transmission 未装/未启动，或 RPC 需要认证：用 deploy/ubuntutr.sh 安装并设置密码，然后在「设置 → transmission RPC」填 用户 opengl + 密码',
        group: 'local',
      });
    } catch (e) {
      out.push({ id: 'transmission-rpc', label: 'transmission RPC（BT 模块）', status: 'fail', latencyMs: null, detail: `检测异常：${(e as Error).message}`, group: 'local' });
    }
    return out;
  })();

  const [httpsChecks, ytdlpChecks, localChecks] = await Promise.all([Promise.all(httpsTasks), ytdlpTask, localTask]);
  checks.push(...httpsChecks, ...ytdlpChecks, ...localChecks);

  // ---- 结论 ----
  const netFail = checks.filter((c) => c.group === 'net' && c.id !== 'proxy' && c.status === 'fail');
  const ytFail = checks.filter((c) => c.group === 'ytdlp' && c.status === 'fail');
  const overall: NetworkReport['overall'] = netFail.length > 0 ? 'fail' : ytFail.length > 0 ? 'partial' : 'ok';
  const summary =
    overall === 'ok'
      ? '网络链路正常：YouTube 元数据解析成功、视频 CDN 可达 —— 在线视频下载可用'
      : overall === 'partial'
        ? `基础网络正常，但 yt-dlp / YouTube 链路有问题（${ytFail.map((c) => c.label).join('、')}）—— 在线视频可能下载失败，请看下方建议`
        : `基础外网不通（${netFail.map((c) => c.label).join('、')}）—— 请先解决树莓派的出网/DNS/代理`;

  scoped.mark('NET_CHECK', '网络自检完成', { overall, summary });
  return {
    checkedAt: new Date().toISOString(),
    cached: false,
    overall,
    summary,
    proxy: { env, extraArgs: extraArgsRaw },
    checks,
  };
}

/* ------------------------------------------------------------------ */
/* 缓存（默认 60 秒，网页刷新按钮可强刷）                                */
/* ------------------------------------------------------------------ */

let cache: { at: number; report: NetworkReport } | null = null;
const TTL_MS = 60_000;
let inflight: Promise<NetworkReport> | null = null;

export async function networkReport(force = false): Promise<NetworkReport> {
  const now = Date.now();
  if (!force && cache && now - cache.at < TTL_MS) {
    return { ...cache.report, cached: true };
  }
  if (inflight) return inflight;
  inflight = runChecks()
    .then((report) => {
      cache = { at: Date.now(), report };
      return report;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 供测试用：清掉缓存 */
export function resetNetworkCache(): void {
  cache = null;
  inflight = null;
}
