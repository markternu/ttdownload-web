/**
 * 网络自检：把「在线视频下载」真正依赖的每一段链路都测一遍，结果直接显示在网页上。
 *
 * 背景：项目跑在树莓派上，网线接 OpenWrt 路由器；git clone / 部署都正常，
 * 但「出网下载视频」还依赖 DNS、YouTube 可达性、yt-dlp 解析、googlevideo CDN 可达性。
 * 这里逐项测试并给出中文原因与修复建议。
 */
import dns from 'node:dns/promises';
import { execFileSync, spawn } from 'node:child_process';
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
  /** 结果是否来自过期缓存（报告里会标注） */
  stale?: boolean;
  overall: 'ok' | 'partial' | 'fail';
  summary: string;
  proxy: { env: Record<string, string>; extraArgs: string };
  checks: NetworkCheck[];
}

/**
 * YouTube 元数据自检用的候选视频（都很老、很公开）。
 * 不同地区/出口对单个视频的可用性判断并不一致，所以逐个试，任一成功即通过。
 */
const TEST_VIDEOS = [
  { id: 'jNQXAC9IVRw', name: 'Me at the zoo（YouTube 第一个视频）' },
  { id: 'aqz-KE-bpKQ', name: 'Big Buck Bunny' },
  { id: 'BaW_jenozKc', name: 'yt-dlp 官方测试视频' },
];
const TEST_VIDEO = `https://www.youtube.com/watch?v=${TEST_VIDEOS[0].id}`;

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

export async function probeHttp(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; latencyMs: number; detail: string; reachable: boolean }> {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    const latencyMs = Date.now() - started;
    // 4xx 说明 TCP/TLS/HTTP 全通了（只是目标站拒绝/限流），不该报「网络不通」；
    // 只有 5xx 或连不上才算链路有问题。
    const reachable = res.status > 0 && res.status < 500;
    const note = res.status >= 400 ? '（链路可达，但目标站拒绝/限流）' : '';
    return { ok: reachable, status: res.status, latencyMs, detail: `HTTP ${res.status}${note}`, reachable };
  } catch (e) {
    const latencyMs = Date.now() - started;
    const msg = (e as Error).name === 'AbortError' ? `超时（>${timeoutMs}ms）` : (e as Error).message;
    return { ok: false, status: 0, latencyMs, detail: msg, reachable: false };
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
      url: 'https://github.com/robots.txt',
      hint: 'GitHub 不通：部署/更新（git pull）会失败，检查 DNS 与防火墙/代理',
    },
  ];

  // ---- 2) HTTPS 直连（Google / YouTube / GitHub）：三个探测并发 ----
  const httpsTasks = httpTargets.map(async (t) => {
    const r = await probeHttp(t.url, 8000);
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

    // 逐个候选视频尝试解析（有的地区对某个视频会返回 "This video is unavailable"）
    let okVideo: { id: string; name: string } | null = null;
    let firstFormatUrl: string | null = null;
    let title = '';
    const failures: string[] = [];
    for (const candidate of TEST_VIDEOS) {
      const url = `https://www.youtube.com/watch?v=${candidate.id}`;
      const args = ['-J', ...commonYtDlpArgs(extraArgs, cookiesFile, cookiesFromBrowser), url];
      const r = await runYtDlp(args, 20000);
      if (r.code === 0) {
        okVideo = candidate;
        try {
          const info = JSON.parse(r.stdout) as { title?: string; formats?: { url?: string; format_id?: string }[] };
          title = info.title ?? '';
          firstFormatUrl = (info.formats ?? []).find((f) => typeof f.url === 'string')?.url ?? null;
        } catch {
          /* JSON 解析失败也算通过 */
        }
        break;
      }
      const err = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).pop() ?? '未知错误';
      failures.push(`${candidate.name}(${candidate.id}) → ${r.timedOut ? '超时' : `退出码 ${r.code}`}：${err.slice(0, 160)}`);
      scoped.warn('[MARK:NET_CHECK] 候选视频解析失败', { id: candidate.id, code: r.code, timedOut: r.timedOut, err: err.slice(0, 300) });
      // 自检本身不能变成"连打"：一旦被判定为机器人/限流，立即停止后续候选（否则会把出口 IP 拖进风控）
      if (/not a bot|sign in to confirm|too many requests|429|unusual traffic/i.test(err)) {
        failures.push('（已停止后续候选：YouTube 判定为机器人/限流，继续试只会加剧风控）');
        scoped.warn('[MARK:NET_CHECK] 检测到机器人/限流，停止剩余候选探测');
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (okVideo) {
      out.push({
        id: 'ytdlp-youtube-meta',
        label: 'yt-dlp 解析 YouTube 元数据',
        status: 'ok',
        latencyMs: null,
        detail: `成功：${title || '(已取得元数据)'}（${okVideo.name} ${okVideo.id}）${
          failures.length ? `；另有 ${failures.length} 个候选失败（不影响结论）` : ''
        }`,
        group: 'ytdlp',
      });
      scoped.mark('NET_CHECK', 'yt-dlp 解析 YouTube 成功', { video: okVideo.id, title });
    } else {
      out.push({
        id: 'ytdlp-youtube-meta',
        label: 'yt-dlp 解析 YouTube 元数据',
        status: 'fail',
        latencyMs: null,
        detail: `全部候选视频都失败：${failures.join(' ｜ ').slice(0, 500)}`,
        hint: 'YouTube 元数据拿不到：多为出口被 YouTube 拦截/需要登录校验；在「设置 → 公开视频（yt-dlp）」填代理参数（--proxy ...）或上传 cookies.txt 后重试；首页此面板下方有网络自检详情',
        group: 'ytdlp',
      });
      return out;
    }

    const urlArgs = ['-f', 'worst', '--get-url', ...commonYtDlpArgs(extraArgs, cookiesFile, cookiesFromBrowser), `https://www.youtube.com/watch?v=${okVideo.id}`];
    const u = await runYtDlp(urlArgs, 20000);
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
      const { aria2Client, ensureAria2Daemon } = await import('../modules/aria2Client');
      const installed = await toolStatus(config.bins.aria2, ['--version']);
      const started = Date.now();
      let ok = await aria2Client().ping();
      let booted = '';
      if (!ok && installed.ok) {
        // 已安装但没在跑：按应用逻辑尝试自动拉起（url 直链模块本来就依赖它）
        const r = await ensureAria2Daemon();
        ok = await aria2Client().ping();
        booted = r.message;
      }
      out.push({
        id: 'aria2-rpc',
        label: 'aria2 RPC（URL 直链模块）',
        status: ok ? 'ok' : 'fail',
        latencyMs: Date.now() - started,
        detail: ok
          ? `可用（${config.aria2Rpc.host}:${config.aria2Rpc.port}）${booted ? `；本次自检已自动拉起：${booted}` : ''}${
              installed.version ? `；${installed.version}` : ''
            }`
          : installed.ok
            ? `aria2c 已安装（${installed.version}）但 RPC ${config.aria2Rpc.host}:${config.aria2Rpc.port} 连不上${
                booted ? `，自动拉起也未成功：${booted}` : ''
              }`
            : `aria2c 未安装`,
        hint: ok
          ? undefined
          : installed.ok
            ? `aria2c 装了但守护进程起不来：看日志 grep 'MARK:ARIA2_DAEMON'；常见原因：端口 ${config.aria2Rpc.port} 被占用（改 .env 的 ARIA2_RPC_PORT）、aria2c 无执行权限、${
                config.dirs.state
              } 不可写`
            : '安装：sudo apt install -y aria2（部署脚本会自动装），装好后重启服务',
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

  /**
   * JS 运行时检查：yt-dlp 需要一个受支持的 JS 运行时（deno/bun/quickjs，或 node >= 22）
   * 才能求解 YouTube 的 n challenge。实测缺失时表现为
   * "No video formats found!" / "The page needs to be reloaded."（非常容易被误判成网络问题）。
   */
  const jsRuntimeTask = (async (): Promise<NetworkCheck[]> => {
    const probe = (bin: string, args: string[]): string | null => {
      try {
        const out = execFileSync(bin, args, { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return out.trim().split('\n')[0] ?? '';
      } catch {
        return null;
      }
    };
    const deno = probe('deno', ['--version']);
    const bun = probe('bun', ['--version']);
    const qjs = probe('qjs', ['--version']) ?? probe('quickjs', ['--version']);
    const nodeRaw = probe('node', ['--version']);
    const nodeMajor = nodeRaw ? Number(nodeRaw.replace(/^v/, '').split('.')[0]) : 0;
    const found: string[] = [];
    if (deno) found.push(`deno ${deno.split(' ')[1] ?? deno}`);
    if (bun) found.push(`bun ${bun}`);
    if (qjs) found.push(`quickjs ${qjs}`);
    if (nodeRaw) found.push(`node ${nodeRaw.replace(/^v/, '')}${nodeMajor >= 22 ? '' : '（yt-dlp 视为 unsupported）'}`);
    const usable = Boolean(deno) || Boolean(bun) || Boolean(qjs) || nodeMajor >= 22;
    return [
      {
        id: 'ytdlp-jsruntime',
        label: 'yt-dlp JS 运行时（解 YouTube n challenge）',
        status: usable ? 'ok' : 'fail',
        latencyMs: null,
        detail: usable
          ? `可用：${found.join('，')}`
          : found.length
            ? `不可用：${found.join('，')}。yt-dlp 需要 deno/bun/quickjs，或 node >= 22 才能解 n challenge`
            : '未检测到任何 JS 运行时（yt-dlp 需要 deno/bun/quickjs 或 node >= 22）',
        hint: usable
          ? undefined
          : '安装 deno（约 40MB，独立二进制，不影响项目 Node）：网页「修复脚本」页上传执行 deploy/scripts/fix-ytdlp.sh；装完 yt-dlp 才能拿到视频格式',
        group: 'ytdlp',
      },
    ];
  })();

  const cookiesTask = (async (): Promise<NetworkCheck[]> => {
    const { inspectCookiesFile } = await import('../modules/webvideo');
    if (!cookiesFile) {
      return [
        {
          id: 'cookies',
          label: 'cookies（会员/登录视频）',
          status: 'skip',
          latencyMs: null,
          detail: '未配置 cookies：公开视频不受影响；会员专享 / 需登录 / 年龄限制的视频必须用它',
          hint: '在「设置 → 公开视频（yt-dlp）」上传 cookies.txt（用登录了目标账号的浏览器导出）',
          group: 'ytdlp',
        },
      ];
    }
    const r = inspectCookiesFile(cookiesFile);
    const domains = Object.entries(r.stats.byDomain)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([d, n]) => `${d}×${n}`)
      .join('，');
    const keys = Object.entries(r.stats.keys)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join('、');
    return [
      {
        id: 'cookies',
        label: 'cookies（会员/登录视频）',
        status: r.valid ? 'ok' : 'fail',
        latencyMs: null,
        detail: `${cookiesFile}｜${r.stats.total} 条 cookie（${domains || '无域名'}）｜关键字段：${keys || '无'}｜已过期 ${r.stats.expiredCount} 条${
          r.warnings.length ? `｜问题：${r.warnings.join('；')}` : '｜结构检查通过'
        }`,
        hint: r.valid
          ? undefined
          : '按上面的问题说明重新导出 cookies（务必：先登录目标账号、导出 Netscape 格式、包含 google.com 与 youtube.com、只用该账号的 Chrome Profile）',
        group: 'ytdlp',
      },
    ];
  })();

  const [httpsChecks, ytdlpChecks, localChecks, cookiesChecks, jsRuntimeChecks] = await Promise.all([
    Promise.all(httpsTasks),
    ytdlpTask,
    localTask,
    cookiesTask,
    jsRuntimeTask,
  ]);
  checks.push(...httpsChecks, ...ytdlpChecks, ...cookiesChecks, ...jsRuntimeChecks, ...localChecks);

  // ---- 结论 ----
  const netFail = checks.filter((c) => c.group === 'net' && c.id !== 'proxy' && c.status === 'fail');
  const ytFail = checks.filter((c) => c.group === 'ytdlp' && c.status === 'fail' && c.id !== 'cookies');
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

/**
 * 带时间预算的自检：用于「一键诊断报告」这类不能久等的场景。
 * 超过预算就返回一个带说明的占位结果（报告里会写明可单独下载完整网络报告）。
 */
export async function networkReportWithBudget(budgetMs = 8000): Promise<NetworkReport> {
  const fresh = cache && Date.now() - cache.at < TTL_MS ? { ...cache.report, cached: true } : null;
  if (fresh) return fresh;
  // 没有新鲜缓存时，宁可给"上次的结果"（标注过期）也不要给空占位 —— 诊断报告里这份数据很重要
  if (cache) {
    return { ...cache.report, cached: true, stale: true, summary: `${cache.report.summary}（注意：这是 ${Math.round((Date.now() - cache.at) / 60000)} 分钟前的结果）` };
  }
  const timeout = new Promise<NetworkReport>((resolve) =>
    setTimeout(
      () =>
        resolve({
          checkedAt: new Date().toISOString(),
          cached: false,
          overall: 'partial',
          summary: `网络自检未在 ${Math.round(budgetMs / 1000)} 秒内完成，已跳过（报告页可单独下载「网络自检报告」以等待完整结果）`,
          proxy: { env: proxyEnv(), extraArgs: '' },
          checks: [],
        }),
      budgetMs,
    ).unref?.(),
  );
  try {
    return await Promise.race([networkReport(false), timeout]);
  } catch (e) {
    return {
      checkedAt: new Date().toISOString(),
      cached: false,
      overall: 'fail',
      summary: `网络自检执行失败：${(e as Error).message}`,
      proxy: { env: proxyEnv(), extraArgs: '' },
      checks: [],
    };
  }
}

/** 供测试用：清掉缓存 */
export function resetNetworkCache(): void {
  cache = null;
  inflight = null;
}
