/**
 * 自动获取「访客 cookies」——让需要 cookies 的站点不再依赖人工导出
 *
 * 背景（用户的实际问题）：
 *   抖音报 `Fresh cookies (not necessarily logged in) are needed`，YouTube 有时报
 *   `Sign in to confirm you're not a bot`。用户以为「要天天人工导出 cookies 才能跑」——
 *   其实分两类：
 *
 *   ① **访客 cookies（不需要登录）**：抖音/TikTok 这类站点的网页接口需要「新鲜」的
 *      `__ac_nonce` + `__ac_signature` + `ttwid` 等**由浏览器 JS 挑战生成**的 cookie。
 *      这些 cookie 完全不需要账号，而且过期很快（几小时）——所以人工导出根本跟不上，
 *      正确做法就是**服务端用无头浏览器自动去拿**（也就是本文件的职责）。
 *      yt-dlp 上游对抖音的 TODO 原话就是 "Run verification challenge code to generate
 *      signature cookies"，我们在这里把这一步补上。
 *
 *   ② **登录 cookies（真的需要账号）**：会员专享、年龄限制、私有视频。这类只能用户
 *      自己导出一次（我们的 cookies.txt 通道），或者用专门的账号池 + 定时刷新。
 *
 * 实现：用 Playwright 驱动**系统自带的无头 chromium**（树莓派/Ubuntu 上 `apt install chromium`
 *       即可，不需要额外下载浏览器），打开目标站点等 JS 挑战跑完，导出 cookie 为
 *       Netscape 格式，缓存到 `${state}/cookies-harvested/<站点>.txt`，并按 TTL 自动续期。
 *
 * 安全性：只访问站点首页/视频页拿匿名 cookie，不登录、不提交任何表单、不复用用户凭据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { getSettings } from './settings';

const scoped = logger.child('cookies');

export const COOKIE_MARKER = 'COOKIE_HARVEST';

/** 常见桌面 Chrome UA：浏览器与 yt-dlp 用同一个，避免指纹不一致导致签名 cookie 失效 */
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface CookieSiteProfile {
  id: string;
  name: string;
  /** URL 命中判定 */
  test: (url: string) => boolean;
  /** 用浏览器打开哪个页面来产生 cookie */
  harvestUrl: string;
  /** 等 JS 挑战跑完的时间（毫秒） */
  waitMs: number;
  /** 抓不到至少一个 cookie 时是否视为失败 */
  requireCookies: boolean;
  /** 交给 yt-dlp 的额外参数（Referer / UA 等，实测必需） */
  extraArgs: string[];
  /**
   * 不用浏览器就能拿到 cookie 的途径（优先于无头浏览器：1 秒出结果，也不容易触发风控）。
   * 抖音实测：向 bytedance 的 ttwid 注册接口 POST 一次即可拿到可用的 ttwid。
   */
  httpProvider?: () => Promise<ParsedCookie[]>;
  /** 只认登录 cookies 的内容（说明用，不参与自动化） */
  loginOnlyNote?: string;
}

/**
 * 纯 HTTP 拿「字节系」访客 cookie（抖音/TikTok 用）。
 *
 * 抖音网页接口要的是 `ttwid`（其余 __ac_signature 等是浏览器挑战产物，但实测**只带 ttwid
 * + Referer + 桌面 UA 就能正常解析/下载**）。ttwid 可以直接向官方的注册接口 POST 一次拿到，
 * 不需要浏览器、不需要登录、1 秒出结果 —— 比开无头浏览器稳得多，也不会招来风控。
 *
 * 返回的 cookie 同时挂到 .douyin.com / .tiktok.com 与 .bytedance.com（原始域）。
 */
export async function fetchTtwidCookies(target: 'douyin' | 'tiktok', timeoutMs = 15000): Promise<ParsedCookie[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch('https://ttwid.bytedance.com/ttwid/union/register/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': DESKTOP_UA },
      body: JSON.stringify({
        region: 'cn',
        aid: 1768,
        needFid: false,
        service: 'www.ixigua.com',
        migrate_info: { ticket: '', source: 'node' },
        cbUrlProtocol: 'https',
        union: true,
      }),
      signal: ac.signal,
    });
    const raw = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''];
    const ttwid = raw
      .map((line) => /(?:^|;\s*)ttwid=([^;]+)/.exec(line)?.[1] ?? '')
      .find((v) => !!v);
    if (!ttwid) throw new Error(`注册接口没有返回 ttwid（HTTP ${res.status}）`);

    const expires = Math.floor(Date.now() / 1000) + 86400 * 300;
    // 带前导点 = 包含子域（浏览器对 Domain=bytedance.com 也是这样处理的）
    const domains = ['.bytedance.com', `.${target === 'douyin' ? 'douyin.com' : 'tiktok.com'}`];
    const cookies: ParsedCookie[] = [];
    for (const domain of domains) {
      cookies.push({
        domain,
        includeSubdomains: domain.startsWith('.'),
        path: '/',
        secure: true,
        expires,
        name: 'ttwid',
        value: ttwid,
        httpOnly: true,
      });
    }
    return cookies;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 通用「纯 HTTP 抓首页访客 cookies」：不少站点（如 B站）在首页响应头里就把
 * `buvid3`/`b_nut` 这类访客标识发下来了，不需要跑 JS 挑战。
 * 只保留需要的名字（`want` 为空则全要），并在域名上做基础过滤。
 */
export async function fetchHomepageCookies(
  url: string,
  want: string[] = [],
  timeoutMs = 15000,
): Promise<ParsedCookie[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': DESKTOP_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: ac.signal,
    });
    const host = hostOf(url);
    const lines = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''];
    const out: ParsedCookie[] = [];
    const expires = Math.floor(Date.now() / 1000) + 86400 * 30;
    for (const line of lines) {
      const name = line.split('=')[0]?.trim();
      if (!name) continue;
      if (want.length && !want.includes(name)) continue;
      const value = /^[^=]+=([^;]*)/.exec(line)?.[1] ?? '';
      const domain = /\bdomain=([^;]+)/i.exec(line)?.[1]?.trim();
      // 站点自己没写 Domain 时，挂到该站的主域（带前导点，覆盖子域）
      const rootDomain = host.split('.').slice(-2).join('.');
      out.push({
        domain: domain ? (domain.startsWith('.') ? domain : `.${domain}`) : `.${rootDomain}`,
        includeSubdomains: true,
        path: /\bpath=([^;]+)/i.exec(line)?.[1]?.trim() || '/',
        secure: /;\s*secure/i.test(line),
        expires,
        name,
        value,
        httpOnly: /httponly/i.test(line),
      });
    }
    if (!out.length) throw new Error(`首页没有下发需要的 cookies（HTTP ${res.status}）`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** 取 URL 的 host（失败返回 ''） */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const hostMatches = (host: string, ...domains: string[]): boolean =>
  domains.some((d) => host === d || host.endsWith(`.${d}`));

/**
 * 站点配置。
 * 抖音的 referer 是**实测必需**的：不带 referer 时即便带了正确的签名 cookie，
 * 抖音仍返回 "Fresh cookies ... needed"（树莓派实测）。
 */
export const SITE_PROFILES: CookieSiteProfile[] = [
  {
    id: 'douyin',
    name: '抖音',
    test: (url) => hostMatches(hostOf(url), 'douyin.com', 'iesdouyin.com'),
    harvestUrl: 'https://www.douyin.com/',
    waitMs: 8000,
    requireCookies: true,
    extraArgs: ['--referer', 'https://www.douyin.com/', '--user-agent', DESKTOP_UA],
    httpProvider: () => fetchTtwidCookies('douyin'),
    loginOnlyNote: '抖音不需要登录 cookies；若自动获取后仍失败，再上传 douyin.com 的 cookies.txt 兜底',
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    test: (url) => hostMatches(hostOf(url), 'tiktok.com'),
    harvestUrl: 'https://www.tiktok.com/',
    waitMs: 6000,
    requireCookies: false,
    extraArgs: ['--referer', 'https://www.tiktok.com/'],
    httpProvider: () => fetchTtwidCookies('tiktok'),
  },
  {
    id: 'bilibili',
    name: '哔哩哔哩',
    test: (url) => hostMatches(hostOf(url), 'bilibili.com', 'b23.tv'),
    harvestUrl: 'https://www.bilibili.com/',
    waitMs: 4000,
    requireCookies: false,
    extraArgs: [
      '--referer',
      'https://www.bilibili.com/',
      // B站对 en-US 的 Accept-Language 更容易判定为爬虫（实测复刻 yt-dlp 默认头就 412）
      '--add-header',
      'Accept-Language: zh-CN,zh;q=0.9',
    ],
    httpProvider: () => fetchHomepageCookies('https://www.bilibili.com/', ['buvid3', 'buvid4', 'b_nut', 'buvid_sig']),
  },
  {
    id: 'youtube',
    name: 'YouTube',
    test: (url) => hostMatches(hostOf(url), 'youtube.com', 'youtu.be', 'youtube-nocookie.com'),
    harvestUrl: 'https://www.youtube.com/',
    waitMs: 5000,
    requireCookies: false,
    // 不加 referer/UA：YouTube 用默认指纹最稳，匿名 cookie 只是锦上添花
    extraArgs: [],
    loginOnlyNote: '会员/年龄限制视频需要登录 cookies（在设置里上传）；普通视频不需要 cookies',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    test: (url) => hostMatches(hostOf(url), 'instagram.com'),
    harvestUrl: 'https://www.instagram.com/',
    waitMs: 5000,
    requireCookies: false,
    extraArgs: [],
  },
  {
    id: 'x',
    name: 'X（推特）',
    test: (url) => hostMatches(hostOf(url), 'x.com', 'twitter.com'),
    harvestUrl: 'https://x.com/',
    waitMs: 5000,
    requireCookies: false,
    extraArgs: [],
  },
];

/** 通用兜底：没匹配到具体站点时，只认「需要新鲜 cookie」的站点才抓，且不加额外参数 */
export function profileFor(url: string): CookieSiteProfile | null {
  const host = hostOf(url);
  if (!host) return null;
  const hit = SITE_PROFILES.find((p) => p.test(url));
  if (hit) return hit;
  // 未收录的站点：不抓（避免给正常站点引入变量）；用户可用设置里的 cookies 覆盖
  return null;
}

/**
 * 默认「自动抓取」的站点：只放开**已实测确实需要且能自动拿到**的站点，
 * 其它站点要用 `COOKIE_HARVEST_SITES=youtube,tiktok` 显式打开。
 */
export function defaultHarvestSites(): string[] {
  const raw = String(process.env.COOKIE_HARVEST_SITES ?? '').trim();
  if (raw) return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  // 抖音/TikTok 实测必需；B站的 buvid3 用纯 HTTP 也能拿到，一起放开
  return ['douyin', 'tiktok', 'bilibili'];
}

export function harvestedDir(): string {
  return path.join(config.dirs.state, 'cookies-harvested');
}
export function harvestedFile(siteId: string): string {
  return path.join(harvestedDir(), `${siteId}.txt`);
}
export function harvestedMetaFile(siteId: string): string {
  return path.join(harvestedDir(), `${siteId}.json`);
}

export interface HarvestMeta {
  site: string;
  name: string;
  url: string;
  file: string;
  fetchedAt: string;
  cookieCount: number;
  cookieNames: string[];
  ua: string;
  /** 这批 cookie 是怎么来的：http=纯 HTTP 接口（最快）/ browser=无头浏览器 */
  via: 'http' | 'browser';
}

export function readHarvestMeta(siteId: string): HarvestMeta | null {
  try {
    const raw = fs.readFileSync(harvestedMetaFile(siteId), 'utf8');
    const meta = JSON.parse(raw) as HarvestMeta;
    if (!meta?.fetchedAt || !fs.existsSync(harvestedFile(siteId))) return null;
    return meta;
  } catch {
    return null;
  }
}

/** 缓存是否还算新鲜（默认 6 小时；抖音这类站点 cookie 寿命就是几小时） */
export function harvestTtlMs(): number {
  const raw = String(process.env.COOKIE_HARVEST_TTL_HOURS ?? '').trim();
  const hours = raw ? Number(raw) : 6;
  return (Number.isFinite(hours) && hours > 0 ? hours : 6) * 3600_000;
}

export function harvestAgeMs(siteId: string): number | null {
  const meta = readHarvestMeta(siteId);
  if (!meta) return null;
  const t = Date.parse(meta.fetchedAt);
  return Number.isFinite(t) ? Date.now() - t : null;
}

/** 自动抓取是否可用：设置开关 + 有可用的 chromium + 装得上 playwright */
export function harvestEnabled(): boolean {
  const s = getSettings() as { cookieHarvestEnabled?: boolean };
  return s.cookieHarvestEnabled !== false;
}

/** 找系统里的 chromium（树莓派/Debian: apt install -y chromium） */
export function chromiumPath(): string | null {
  const env = String(process.env.CHROMIUM_PATH ?? '').trim();
  if (env && fs.existsSync(env)) return env;
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  cookie 文件读写（Netscape 格式）                                    */
/* ------------------------------------------------------------------ */

export interface ParsedCookie {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  expires: number;
  name: string;
  value: string;
  httpOnly: boolean;
}

/** Netscape 行 → 结构；非法行返回 null */
export function parseNetscapeLine(line: string): ParsedCookie | null {
  let raw = line.replace(/\r$/, '');
  if (!raw.trim()) return null;
  let httpOnly = false;
  // 关键：HttpOnly 在 Netscape 格式里是 `#HttpOnly_` 前缀，不是普通注释
  if (raw.startsWith('#HttpOnly_')) {
    httpOnly = true;
    raw = raw.slice('#HttpOnly_'.length);
  } else if (raw.startsWith('#')) {
    return null;
  }
  const parts = raw.split('\t');
  if (parts.length < 7) return null;
  const [domain, flag, cpath, secure, expires, name, ...rest] = parts;
  if (!domain || !name) return null;
  return {
    domain,
    includeSubdomains: flag.toUpperCase() === 'TRUE',
    path: cpath || '/',
    secure: secure.toUpperCase() === 'TRUE',
    expires: Number.parseInt(expires, 10) || 0,
    name,
    value: rest.join('\t'),
    httpOnly,
  };
}

/** 结构 → Netscape 行（HttpOnly 必须写回 `#HttpOnly_` 前缀，否则 yt-dlp 报格式非法） */
export function formatNetscapeLine(c: ParsedCookie): string {
  const domain = `${c.httpOnly ? '#HttpOnly_' : ''}${c.domain}`;
  return [
    domain,
    c.includeSubdomains || c.domain.startsWith('.') ? 'TRUE' : 'FALSE',
    c.path || '/',
    c.secure ? 'TRUE' : 'FALSE',
    String(c.expires || Math.floor(Date.now() / 1000) + 86400 * 30),
    c.name,
    c.value,
  ].join('\t');
}

export function readCookieFile(file: string): ParsedCookie[] {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map(parseNetscapeLine)
    .filter((c): c is ParsedCookie => !!c);
}

/** 写 Netscape cookies 文件（权限 0600：里面有登录凭据） */
export function writeCookieFile(file: string, cookies: ParsedCookie[], header = 'ttdownload-web 自动生成'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lines = ['# Netscape HTTP Cookie File', `# ${header}`, ''];
  for (const c of cookies) lines.push(formatNetscapeLine(c));
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
}

/** 判断是不是「登录态」cookie：合并时绝不让匿名值覆盖登录值 */
export function isAuthCookie(name: string): boolean {
  return /^(SID|HSID|SSID|APISID|SAPISID|LOGIN_INFO|__Secure-.*PSID.*|__Host-.*|.*session.*|.*token.*|.*auth.*)$/i.test(
    name,
  );
}

/**
 * 合并多个 cookies 文件（后来的更新鲜，但**不覆盖登录态 cookie**）。
 * 返回写出的 cookie 条数。
 */
export function mergeCookieFiles(files: string[], outFile: string): number {
  const map = new Map<string, ParsedCookie>();
  const key = (c: ParsedCookie): string => `${c.domain}\t${c.path}\t${c.name}`;
  for (const f of files) {
    for (const c of readCookieFile(f)) {
      const k = key(c);
      const prev = map.get(k);
      // 已有登录态 cookie 时保留原值（匿名抓取不可能拿到登录态，别把用户的登录态冲掉）
      if (prev && isAuthCookie(prev.name)) continue;
      map.set(k, c);
    }
  }
  const merged = [...map.values()];
  writeCookieFile(outFile, merged, `合并自 ${files.length} 个 cookies 文件（用户上传 + 自动获取）`);
  return merged.length;
}

/* ------------------------------------------------------------------ */
/*  用无头浏览器抓 cookie                                              */
/* ------------------------------------------------------------------ */

type LaunchFn = (profile: CookieSiteProfile) => Promise<ParsedCookie[]>;

/** 测试可注入的启动器 */
let launcherOverride: LaunchFn | null = null;
export function __setHarvesterLauncher(fn: LaunchFn | null): void {
  launcherOverride = fn;
}

/** 同一站点同时只抓一次，避免并发下载把浏览器开爆 */
const inflight = new Map<string, Promise<HarvestMeta | null>>();

/**
 * 真正启动浏览器抓 cookie。
 * 这里用 Playwright 驱动**系统 chromium**；playwright 用动态 import，缺失时给出明确指引。
 */
async function launchAndHarvest(profile: CookieSiteProfile): Promise<ParsedCookie[]> {
  const exe = chromiumPath();
  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    throw new Error(
      `未安装 playwright，无法自动获取 cookies（npm i playwright 或重新执行 deploy.sh）。原始错误：${(e as Error).message}`,
    );
  }

  let browser;
  try {
    browser = await chromium.launch({
      ...(exe ? { executablePath: exe } : {}),
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    });
  } catch (e) {
    throw new Error(
      `启动无头浏览器失败（chromium=${exe ?? 'playwright 自带'}）：${(e as Error).message}。` +
        `Debian/Ubuntu/树莓派可执行：sudo apt install -y chromium`,
    );
  }

  try {
    const ctx = await browser.newContext({
      userAgent: DESKTOP_UA,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1366, height: 900 },
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(profile.harvestUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // 等 JS 挑战（抖音的 __ac_signature / 谷歌的同意页）跑完
    await page.waitForTimeout(profile.waitMs);
    const cookies = await ctx.cookies();
    await ctx.close();
    return cookies.map((c) => ({
      domain: c.domain,
      includeSubdomains: c.domain.startsWith('.'),
      path: c.path || '/',
      secure: !!c.secure,
      expires: Math.floor(c.expires && c.expires > 0 ? c.expires : Date.now() / 1000 + 86400 * 30),
      name: c.name,
      value: c.value,
      httpOnly: !!c.httpOnly,
    }));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * 抓取某站点的访客 cookies（带缓存）。
 * @param force true=忽略缓存强制重抓（用于「上一次被判定 cookie 失效」后的自愈）
 */
export async function ensureHarvested(
  profile: CookieSiteProfile,
  opts: { force?: boolean } = {},
): Promise<HarvestMeta | null> {
  const fresh = readHarvestMeta(profile.id);
  if (!opts.force && fresh && (harvestAgeMs(profile.id) ?? Infinity) < harvestTtlMs()) return fresh;

  const existing = inflight.get(profile.id);
  if (existing) return existing;

  const task = (async (): Promise<HarvestMeta | null> => {
    const t0 = Date.now();
    scoped.info(`[MARK:${COOKIE_MARKER}] 开始自动获取 cookies：${profile.name}（${profile.harvestUrl}）`);
    try {
      // ① 优先不用浏览器（快、稳、不招风控）
      let via: 'http' | 'browser' = 'http';
      let cookies: ParsedCookie[] = [];
      if (profile.httpProvider && !launcherOverride) {
        try {
          cookies = await profile.httpProvider();
          scoped.info(`[MARK:${COOKIE_MARKER}] ${profile.name}：HTTP 接口直接拿到 ${cookies.length} 条 cookie（未启动浏览器）`);
        } catch (e) {
          scoped.warn(`[MARK:${COOKIE_MARKER}] ${profile.name} 的 HTTP 途径失败，改用无头浏览器：${(e as Error).message}`);
          cookies = [];
        }
      }
      // ② 退到无头浏览器
      if (!cookies.length) {
        via = 'browser';
        cookies = launcherOverride ? await launcherOverride(profile) : await launchAndHarvest(profile);
      }
      if (!cookies.length && profile.requireCookies) {
        throw new Error('没能拿到任何 cookie（HTTP 接口与无头浏览器都失败，站点可能改了流程）');
      }
      if (cookies.length) {
        writeCookieFile(harvestedFile(profile.id), cookies, `由无头浏览器自动获取（${profile.name}）`);
      }
      const meta: HarvestMeta = {
        site: profile.id,
        name: profile.name,
        url: profile.harvestUrl,
        file: harvestedFile(profile.id),
        fetchedAt: new Date().toISOString(),
        cookieCount: cookies.length,
        cookieNames: cookies.map((c) => c.name),
        ua: DESKTOP_UA,
        via,
      };
      fs.mkdirSync(harvestedDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(harvestedMetaFile(profile.id), JSON.stringify(meta, null, 1), { mode: 0o600 });
      scoped.info(
        `[MARK:${COOKIE_MARKER}] 自动获取成功：${profile.name} ${cookies.length} 条（via=${via}，${Date.now() - t0}ms）`,
        { cookies: meta.cookieNames.slice(0, 20) },
      );
      return meta;
    } catch (e) {
      scoped.error(`[MARK:${COOKIE_MARKER}] 自动获取失败：${profile.name}：${(e as Error).message}`);
      return null;
    } finally {
      inflight.delete(profile.id);
    }
  })();

  inflight.set(profile.id, task);
  return task;
}

/* ------------------------------------------------------------------ */
/*  对外的「这次请求用哪套 cookies / 参数」                             */
/* ------------------------------------------------------------------ */

export interface ResolvedCookies {
  /** 交给 yt-dlp 的 --cookies 文件（可能不存在 → null） */
  cookiesFile: string | null;
  /** 站点专用的额外参数（referer/UA） */
  extraArgs: string[];
  /** 站点名（错误提示用） */
  siteName: string | null;
  /** 是否用了自动获取的 cookies */
  harvested: boolean;
  /** 说明（写日志/页面展示） */
  note: string;
}

/**
 * yt-dlp 用的「工作副本」。
 *
 * ⚠️ 实测踩到的坑：**yt-dlp 会把 `--cookies` 指向的文件回写**（每次运行 mtime 都变）。
 *    我们以前直接把**用户上传的原件**交给它，结果 YouTube 一旦下发"会话失效"的响应，
 *    yt-dlp 就把「SID 被清掉」之后的状态写回用户文件 —— 用户的登录态就这么被工具悄悄毁了，
 *    而且文件没有 .bak、日志里也没有上传记录，完全看不出来（用户会以为"登录态也失败"）。
 *    所以：**永远只把副本交给 yt-dlp**，原件保持原样（那是用户唯一的凭据备份）。
 */
export function workingCopyOf(source: string): string {
  const dir = path.join(config.dirs.state, 'cookies-work');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = path.basename(source).replace(/[^\w.-]/g, '_') || 'cookies.txt';
  const out = path.join(dir, base);
  try {
    const src = fs.statSync(source);
    const dst = fs.existsSync(out) ? fs.statSync(out) : null;
    // 源文件更新了（用户重新上传）或副本丢了/大小不符 → 重新拷贝
    if (!dst || dst.mtimeMs < src.mtimeMs || dst.size !== src.size) {
      fs.copyFileSync(source, out);
      fs.chmodSync(out, 0o600);
    }
  } catch (e) {
    scoped.warn(`[MARK:${COOKIE_MARKER}] 建立 cookies 工作副本失败，退回原件：${(e as Error).message}`);
    return source;
  }
  return out;
}

/** 合并后的临时文件路径（每个站点一份，避免每次请求都新建） */
function mergedFileFor(profile: CookieSiteProfile | null, userFile: string | null, harvested: string | null): string {
  const tag = profile?.id ?? 'generic';
  const stamp = [userFile, harvested].filter(Boolean).map((f) => fs.statSync(f as string).mtimeMs).join('-');
  return path.join(config.dirs.state, 'cookies-merged', `${tag}-${Math.round(Number(stamp) || 0)}.txt`);
}

/**
 * 决定「这个 URL 用哪套 cookies / 额外参数」。
 *   - 用户上传的 cookies（如果有）优先保留登录态；
 *   - 站点需要新鲜访客 cookies 时自动抓取并合并（抖音这类，人工导出根本跟不上）；
 *   - 两者都没有就不带 cookies（大多数公开视频本来就不需要）。
 */
export async function cookiesForUrl(
  url: string,
  userCookiesFile: string | null,
  opts: { forceHarvest?: boolean } = {},
): Promise<ResolvedCookies> {
  const profile = profileFor(url);
  const base: ResolvedCookies = {
    cookiesFile: userCookiesFile,
    extraArgs: profile?.extraArgs ?? [],
    siteName: profile?.name ?? null,
    harvested: false,
    note: userCookiesFile ? '使用上传的 cookies.txt' : '未使用 cookies',
  };

  // ★ 无论如何都不能把用户原件交给 yt-dlp（它会回写）：统一换成工作副本
  if (base.cookiesFile) {
    base.cookiesFile = workingCopyOf(base.cookiesFile);
    base.note = `${base.note}（已用工作副本，保护上传的原件）`;
  }

  const wantHarvest =
    !!profile &&
    harvestEnabled() &&
    defaultHarvestSites().includes(profile.id) &&
    // 有纯 HTTP 途径的站点（抖音/TikTok）不需要浏览器
    (!!profile.httpProvider || !!chromiumPath());
  if (!wantHarvest || !profile) return base;

  const meta = await ensureHarvested(profile, { force: opts.forceHarvest });
  if (!meta) {
    base.note = `${profile.name} 无法自动获取 cookies${userCookiesFile ? '，改用上传的 cookies.txt' : ''}`;
    return base;
  }

  const harvestedPath = fs.existsSync(meta.file) ? meta.file : null;
  if (!harvestedPath) return base;

  if (!userCookiesFile) {
    base.cookiesFile = harvestedPath;
    base.harvested = true;
    base.note = `自动获取的 ${profile.name} 访客 cookies（${meta.cookieCount} 条）`;
    return base;
  }

  // 两边都有 → 合并（登录态保留用户的，其余用新鲜的）
  try {
    const out = mergedFileFor(profile, userCookiesFile, harvestedPath);
    if (!fs.existsSync(out)) {
      fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
      mergeCookieFiles([userCookiesFile, harvestedPath], out);
    }
    base.cookiesFile = out;
    base.harvested = true;
    base.note = `上传的 cookies + 自动获取的 ${profile.name} 访客 cookies（已合并）`;
  } catch (e) {
    scoped.warn(`[MARK:${COOKIE_MARKER}] 合并 cookies 失败，改用上传的文件：${(e as Error).message}`);
  }
  return base;
}

/** 各站点 cookies 状态（给设置页/诊断用） */
export function harvestStatus(): {
  enabled: boolean;
  chromium: string | null;
  available: boolean;
  sites: {
    id: string;
    name: string;
    auto: boolean;
    hasCookies: boolean;
    cookieCount: number;
    ageMinutes: number | null;
    url: string;
    /** 是否需要无头浏览器（false = 纯 HTTP 就能拿到，没装 chromium 也能用） */
    needsBrowser: boolean;
    via: 'http' | 'browser' | null;
  }[];
  harvestSites: string[];
} {
  const enabled = harvestEnabled();
  const exe = chromiumPath();
  const auto = defaultHarvestSites();
  return {
    enabled,
    chromium: exe,
    // 有 HTTP 途径的站点不需要浏览器，所以可用性不能只看 chromium
    available: enabled && (!!exe || SITE_PROFILES.some((p) => p.httpProvider && auto.includes(p.id))),
    harvestSites: auto,
    sites: SITE_PROFILES.map((p) => {
      const meta = readHarvestMeta(p.id);
      const age = harvestAgeMs(p.id);
      return {
        id: p.id,
        name: p.name,
        auto: auto.includes(p.id),
        hasCookies: !!meta,
        cookieCount: meta?.cookieCount ?? 0,
        ageMinutes: age === null ? null : Math.round(age / 60000),
        url: p.harvestUrl,
        needsBrowser: !p.httpProvider,
        via: meta?.via ?? null,
      };
    }),
  };
}

/** 手动触发一次抓取（设置页「立即刷新」/自愈用） */
export async function harvestNow(siteId: string): Promise<HarvestMeta | null> {
  const profile = SITE_PROFILES.find((p) => p.id === siteId);
  if (!profile) throw Object.assign(new Error(`未知站点：${siteId}`), { status: 400 });
  if (!profile.httpProvider && !chromiumPath()) {
    throw Object.assign(new Error('服务器上没有 chromium，请先安装：sudo apt install -y chromium'), { status: 400 });
  }
  const meta = await ensureHarvested(profile, { force: true });
  if (!meta) throw Object.assign(new Error(`${profile.name} 的 cookies 自动获取失败（详见日志 [MARK:${COOKIE_MARKER}]）`), { status: 500 });
  return meta;
}
