import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../core/config';
import {
  COOKIE_MARKER,
  cookiesForUrl,
  harvestNow,
  harvestStatus,
  profileFor,
  SITE_PROFILES,
} from '../services/cookieHarvest';
import { logger, taskLog } from '../core/logger';
import { tailText } from '../core/procLog';
import { toolStatus } from '../core/disk';
import type { FormatOption } from '../types';
import type { ModuleAdapter, PollResult, TaskWithPayload } from './types';

/* ------------------------------------------------------------------ */
/* 平台识别                                                            */
/* ------------------------------------------------------------------ */

const PLATFORM_RULES: { name: string; match: RegExp }[] = [
  { name: 'YouTube', match: /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/i },
  { name: 'Bilibili', match: /(^|\.)bilibili\.com$|(^|\.)b23\.tv$/i },
  { name: 'Vimeo', match: /(^|\.)vimeo\.com$/i },
  { name: 'X', match: /(^|\.)x\.com$|(^|\.)twitter\.com$/i },
  { name: 'TikTok', match: /(^|\.)tiktok\.com$/i },
  { name: 'Instagram', match: /(^|\.)instagram\.com$/i },
  { name: '抖音', match: /(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/i },
];

export function detectPlatform(url: string): string {
  try {
    const host = new URL(url).hostname;
    for (const rule of PLATFORM_RULES) {
      if (rule.match.test(host)) return rule.name;
    }
    return host;
  } catch {
    return '未知';
  }
}

export function supportedPlatforms(): string[] {
  return PLATFORM_RULES.map((r) => r.name);
}

/* ------------------------------------------------------------------ */
/* 元数据解析（yt-dlp -J）                                              */
/* ------------------------------------------------------------------ */

interface YtDlpFormat {
  format_id?: string;
  ext?: string;
  resolution?: string;
  width?: number;
  height?: number;
  vcodec?: string;
  acodec?: string;
  filesize?: number;
  filesize_approx?: number;
  format_note?: string;
  abr?: number;
}

interface YtDlpInfo {
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
  webpage_url?: string;
  formats?: YtDlpFormat[];
  is_live?: boolean;
}

export interface ParseResult {
  platform: string;
  title: string;
  thumbnail: string | null;
  durationSec: number | null;
  author: string | null;
  formats: FormatOption[];
  defaultFormatId: string | null;
  expectedBytes: number;
}

function normalizeFormat(f: YtDlpFormat): FormatOption | null {
  const id = f.format_id;
  if (!id) return null;
  const ext = (f.ext ?? 'mp4').toLowerCase();
  const vcodec = f.vcodec ?? 'none';
  const acodec = f.acodec ?? 'none';
  const hasVideo = vcodec !== 'none' && !!vcodec;
  const hasAudio = acodec !== 'none' && !!acodec;
  // 质量标签统一成 "1080p" 这种写法，取**短边**（YouTube/TikTok 都这么标：1080p = 短边 1080）。
  // 坑（用户实际踩到）：yt-dlp 同时知道宽高时的 resolution 是 "1920x1080"，
  // 前端若按「第一个数字」取高度会得到宽度 1920 → 与 1080P/720P 等选项全对不上 →
  // 质量下拉框只剩「仅音频」。所以这里直接按数值算，不把字符串丢给前端去猜。
  let resolution: string;
  if (hasVideo) {
    const w = typeof f.width === 'number' && f.width > 0 ? f.width : 0;
    const h = typeof f.height === 'number' && f.height > 0 ? f.height : 0;
    const shortSide = w && h ? Math.min(w, h) : h || w;
    if (shortSide) resolution = `${shortSide}p`;
    else {
      // 连宽高都没有：从 "1080p60" / "1920x1080" 里兜底取最后一个 3~4 位数
      const m = (f.resolution ?? '').match(/\d{3,4}/g);
      resolution = m && m.length ? `${Number.parseInt(m[m.length - 1], 10)}p` : (f.resolution || '?');
    }
  } else {
    resolution = 'audio';
  }
  const filesize = f.filesize ?? f.filesize_approx ?? null;
  const sizeText = filesize && filesize > 0 ? ` · ${(filesize / 1024 / 1024).toFixed(0)} MB` : '';
  const kind = hasVideo ? (hasAudio ? '视频+音频' : '仅视频') : '仅音频';
  const label = `${resolution} · ${ext.toUpperCase()} · ${kind}${sizeText}`;
  return {
    id,
    ext,
    resolution,
    label,
    filesize,
    vcodec,
    acodec,
  };
}

export interface ParseOptions {
  /** 上传/指定的 cookies 文件（存在才带） */
  cookiesFile?: string | null;
  /** 从浏览器读取 cookies（''=不启用） */
  cookiesFromBrowser?: string;
  /** 额外参数（如代理），与下载保持一致 */
  extraArgs?: string[];
}

/** 调用 yt-dlp 解析视频信息（超时保护） */
export async function parseVideo(
  url: string,
  ytdlpBin = config.bins.ytdlp,
  timeoutMs = 60000,
  opts: ParseOptions = {},
): Promise<ParseResult> {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL 格式错误（仅支持 http/https）');
  const tool = await toolStatus(ytdlpBin, ['--version']);
  if (!tool.ok) throw new Error(`未安装 yt-dlp（或路径不正确）：${tool.error ?? ''}，请先安装：sudo apt install -y yt-dlp 或 pip3 install -U yt-dlp`);

  // 解析同样带上 cookies/代理：会员或需登录的视频，只有带登录态才拿得到元数据
  const cookiesArgs: string[] = opts.cookiesFile
    ? ['--cookies', opts.cookiesFile]
    : opts.cookiesFromBrowser
      ? ['--cookies-from-browser', opts.cookiesFromBrowser]
      : [];
  const args = [
    '-J',
    '--no-warnings',
    '--no-playlist',
    '--socket-timeout',
    '20',
    ...cookiesArgs,
    ...(opts.extraArgs ?? []),
    url,
  ];
  const scoped = logger.child('ytdlp');
  const parseStartedAt = Date.now();
  scoped.mark('YTDLP_PARSE', `解析视频元数据: ${url}`, {
    bin: ytdlpBin,
    args,
    cookies: opts.cookiesFile ? opts.cookiesFile : opts.cookiesFromBrowser ? `browser:${opts.cookiesFromBrowser}` : '(无)',
  });
  const info = await new Promise<YtDlpInfo>((resolve, reject) => {
    const child = spawn(ytdlpBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      scoped.warn(`[MARK:YTDLP_PARSE] 解析超时（${timeoutMs}ms）: ${url}`);
      reject(new Error('解析超时（网络较慢或视频较大），请稍后重试'));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      scoped.trace(`解析 stderr: ${tailText(d.toString(), 500)}`);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      scoped.error(`[MARK:YTDLP_PARSE] 解析进程启动失败: ${e.message}`, { bin: ytdlpBin, args });
      reject(new Error(`解析失败：${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - parseStartedAt;
      if (code !== 0) {
        scoped.warn(`[MARK:YTDLP_PARSE] 解析失败 code=${code}（${ms}ms）: ${url}`, {
          stderr: tailText(stderr, 1500),
          stdout: tailText(stdout, 500),
        });
        reject(new Error(humanizeYtDlpError(stderr || stdout, url)));
        return;
      }
      scoped.mark('YTDLP_PARSE', `解析成功 code=0（${ms}ms）: ${url}`, {
        stdoutBytes: stdout.length,
        stderr: stderr ? tailText(stderr, 300) : undefined,
      });
      try {
        resolve(JSON.parse(stdout) as YtDlpInfo);
      } catch {
        scoped.error(`[MARK:YTDLP_PARSE] 解析结果无法识别（yt-dlp 输出异常）`, { stdout: tailText(stdout, 800) });
        reject(new Error('解析结果无法识别（yt-dlp 输出异常）'));
      }
    });
  });

  const formatsRaw = Array.isArray(info.formats) ? info.formats : [];
  const formats = formatsRaw.map(normalizeFormat).filter((f): f is FormatOption => !!f);
  // 优先视频+音频且体积已知的 mp4
  const scored = formats
    .filter((f) => f.resolution !== 'audio' && f.ext === 'mp4')
    .sort((a, b) => (b.filesize ?? 0) - (a.filesize ?? 0));
  const fallback = formats.filter((f) => f.resolution !== 'audio').sort((a, b) => (b.filesize ?? 0) - (a.filesize ?? 0));
  const best = scored[0] ?? fallback[0] ?? formats[0] ?? null;

  return {
    platform: detectPlatform(url),
    title: info.title ?? url,
    thumbnail: info.thumbnail ?? null,
    durationSec: info.duration ?? null,
    author: info.uploader ?? info.channel ?? null,
    formats,
    defaultFormatId: best?.id ?? null,
    expectedBytes: best?.filesize ?? 0,
  };
}

/** yt-dlp 错误信息人性化（中文）—— 不预设「不绕过登录」，只说明该怎么办 */
export function humanizeYtDlpError(raw: string, url = ''): string {
  const s = raw.toLowerCase();
  const has = (...keys: string[]): boolean => keys.some((k) => s.includes(k));
  const site = url ? profileFor(url) : null;

  // ① 需要「新鲜访客 cookies」：抖音/TikTok 这类站点要浏览器 JS 挑战生成的签名 cookie，
  //    不需要登录，而且我们**会自动获取**（人工导出根本跟不上它的过期速度）。
  if (isCookieRequiredError(raw)) {
    if (site?.id === 'douyin' || site?.id === 'tiktok') {
      return `${site.name}需要「新鲜的访客 cookies」（不需要登录）：程序会自动用内置无头浏览器获取并重试；` +
        `若仍失败，可在「设置 → 公开视频（yt-dlp）」上传一份 ${site.id === 'douyin' ? 'douyin.com' : 'tiktok.com'} 的 cookies.txt 兜底`;
    }
    return '该平台需要 cookies（可能只是访客 cookies，不需要登录）。程序会自动尝试用无头浏览器获取；' +
      '若仍失败，请在「设置 → 公开视频（yt-dlp）」上传该站点的 cookies.txt';
  }

  // 频道会员专享（如 YouTube「高级VIP会员」）
  if (
    has("available to this channel's members", 'members-only', 'members only', 'join this channel', 'channel members', '会员专享', '会员可看')
  ) {
    return '该视频是「频道会员专享」（如高级VIP会员，只有会员账号能看）。若你本人是该频道会员，请在网页「设置 → 公开视频（yt-dlp）」上传该网站的 cookies.txt（用会员账号登录后导出），然后重试';
  }
  // 年龄限制
  if (has('confirm your age', 'age-restricted', 'age restricted', 'inappropriate for some users')) {
    return '该视频有年龄限制，必须带登录态：请在「设置 → 公开视频（yt-dlp）」上传 cookies.txt（或填「从浏览器读取 cookies」），然后重试';
  }
  // 登录 / 人机校验 / 需要 cookies
  // yt-dlp 已知问题：YouTube 返回 "The page needs to be reloaded."（多为版本/瞬时问题，见 issue #14610）
  if (has('the page needs to be reloaded', 'page needs to be reloaded')) {
    return 'YouTube 返回「The page needs to be reloaded.」：这是 yt-dlp 的已知问题（多与版本/瞬时风控有关，不是你的网络）。程序会自动换客户端/重试；若持续出现，请把 yt-dlp 升级到最新版（可用网页「修复脚本」页跑 deploy/scripts/fix-ytdlp.sh），或改用「跳过网页抓取」方式';
  }
  if (has('not a bot', 'sign in to confirm')) {
    return site?.id === 'youtube'
      ? 'YouTube 判定这台服务器的出口 IP「像机器人」（这是 IP 信誉问题，不是你的账号或 cookies 坏了；公开视频本来就不需要 cookies）。' +
        '请等 10~30 分钟再试，或换出口 IP（设置里加 --proxy）；服务器上已有登录 cookies 时会自动带上'
      : '该平台要求先通过人机校验（多与出口 IP 信誉有关）：稍后重试，或在设置里配置代理换出口 IP';
  }
  if (has('login required', 'please log in', 'this video requires login', 'use --cookies', 'cookies')) {
    return '该内容需要登录后才能访问：请在「设置 → 公开视频（yt-dlp）」上传该网站的 cookies.txt（或填「从浏览器读取 cookies」）后重试';
  }
  // 私有视频
  if (has('private video', 'this video is private')) {
    return '该视频为私有视频，只有有权限的账号能看：若你有权限，请在设置里上传 cookies.txt 后重试';
  }
  if (has('unsupported url')) return '当前平台不支持解析该链接';
  if (has('video unavailable') || s.includes('not available')) return '视频不可访问（可能已删除、地区限制或需要登录）';
  if (has('drm')) return '该视频受 DRM 保护（Widevine 等），任何下载工具都无法直接下载';
  if (has('timed out', 'timeout')) return '网络超时，请稍后重试';
  if (has('http error 404')) return '视频不存在（404）';
  if (has('no space left')) return '磁盘空间不足';
  if (has('is not a valid url')) return 'URL 格式错误';
  const firstLine = raw.trim().split('\n').filter(Boolean).pop() ?? raw;
  return `下载失败：${firstLine.replace(/^ERROR:\s*/i, '').slice(0, 300)}`;
}

/* ------------------------------------------------------------------ */
/* cookies / 额外参数（会员、登录、年龄限制视频）                        */
/* ------------------------------------------------------------------ */

export interface CookiesStatus {
  /** 当前生效的 cookies 文件路径 */
  cookiesFile: string;
  /** 默认路径（DOWNLOAD_ROOT/state/cookies.txt） */
  defaultPath: string;
  exists: boolean;
  sizeBytes: number;
  updatedAt: string | null;
  /** 设置里的「从浏览器读取 cookies」 */
  fromBrowser: string;
  /** 结构校验结论（上传后立刻能看出 cookies 有没有问题） */
  valid: boolean;
  /** 需要用户处理的问题（中文，可直接展示；为空才算 valid） */
  warnings: string[];
  /** 只是提示性说明（不影响可用性，例如多账号注意事项） */
  notes: string[];
  /**
   * 这份 cookies.txt 覆盖了哪些站点（按域名），以及各站点是不是「能自动获取、不需要人工导出」。
   * 用户最容易误解的就是「我传了 Google 的 cookies，为什么抖音还是不行」—— cookies 是按站点隔离的。
   */
  sites: { domain: string; count: number; auto: boolean; note: string }[];
  /** 自动获取访客 cookies 的总体情况 */
  harvest: ReturnType<typeof harvestStatus> | null;
  stats: {
    total: number;
    byDomain: Record<string, number>;
    /** 关键 cookie 是否存在（YouTube 登录态必需） */
    keys: Record<string, boolean>;
    expiredCount: number;
    hasHeader: boolean;
    hasGoogleDomain: boolean;
    hasYoutubeDomain: boolean;
  };
}

/** YouTube 登录态真正依赖的关键 cookie 名 */
const CRITICAL_COOKIE_KEYS = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO'];

/**
 * 校验 Netscape 格式的 cookies.txt：
 * 只看结构与关键字段（不联网），把常见"上传了但没用"的原因直接说清楚。
 */
export function inspectCookiesFile(file: string): {
  valid: boolean;
  warnings: string[];
  notes: string[];
  stats: CookiesStatus['stats'];
} {
  const stats: CookiesStatus['stats'] = {
    total: 0,
    byDomain: {},
    // 关键字段全部列出（false = 缺失），前端直接照搬即可，不必自己维护一份清单
    keys: Object.fromEntries(CRITICAL_COOKIE_KEYS.map((k) => [k, false])),
    expiredCount: 0,
    hasHeader: false,
    hasGoogleDomain: false,
    hasYoutubeDomain: false,
  };
  const warnings: string[] = [];
  const notes: string[] = [];
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { valid: false, warnings: [`读取 cookies 文件失败：${(e as Error).message}`], notes, stats };
  }
  const lines = text.split('\n');
  stats.hasHeader = /^#\s*(Netscape )?HTTP Cookie File/i.test(lines[0] ?? '') || text.includes('HTTP Cookie File');
  const nowSec = Math.floor(Date.now() / 1000);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [domain, , , , expiry, name] = parts;
    stats.total += 1;
    const d = (domain || '').replace(/^\./, '');
    stats.byDomain[d] = (stats.byDomain[d] ?? 0) + 1;
    if (/youtube\.com$/.test(d) || d === 'youtube.com') stats.hasYoutubeDomain = true;
    if (/google\.com$/.test(d) || d === 'google.com') stats.hasGoogleDomain = true;
    if (CRITICAL_COOKIE_KEYS.includes(name)) stats.keys[name] = true;
    const exp = Number(expiry);
    if (Number.isFinite(exp) && exp > 0 && exp < nowSec) stats.expiredCount += 1;
  }

  if (stats.total === 0) {
    warnings.push('文件里没解析出任何 cookie 行：可能不是 Netscape 格式（用 "Get cookies.txt LOCALLY" 导出，别手改）');
  }
  if (!stats.hasHeader) {
    warnings.push('缺少 "# Netscape HTTP Cookie File" 头：导出方式不对（不要用 JSON/zip 导出）');
  }
  if (!stats.hasYoutubeDomain) warnings.push('没有 youtube.com 的 cookie：导出时请先打开并登录 youtube.com');
  if (!stats.hasGoogleDomain) {
    warnings.push('没有 google.com 的 cookie：YouTube 登录态依赖它，导出时选"全部/当前站点"都行但要包含 google.com');
  }
  const missingKeys = CRITICAL_COOKIE_KEYS.filter((k) => !stats.keys[k]);
  if (stats.total > 0 && missingKeys.length >= 5) {
    warnings.push(
      `缺少关键登录 cookie（${missingKeys.slice(0, 5).join('、')}…）：说明导出时其实没有登录态，请确认导出前已登录 YouTube`,
    );
  }
  if (stats.expiredCount > 0) {
    warnings.push(`有 ${stats.expiredCount} 条 cookie 已过期：重新导出一次最常见的过期项是 __Secure-1PSID/3PSID`);
  }
  if (Object.keys(stats.byDomain).some((d) => d.includes('youtube') || d.includes('google'))) {
    // 多账号提示：无法从 cookies 判断账号，但这是最常见的坑，作为"提示"给出（不算错误）
    notes.push('多账号提醒：cookies 代表导出时 Chrome 配置里的「主账号」；若目标（会员）账号是次要账号，请新建 Profile 只登录它再导出');
  }
  notes.push('cookies 会过期：以后突然报「Sign in to confirm you\'re not a bot」，重新导出上传即可');
  return { valid: warnings.length === 0, warnings, notes, stats };
}

/** 把 "a --b 'c d'" 解析成参数数组（支持单双引号） */
export function parseExtraArgs(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const v = m[1] ?? m[2] ?? m[3] ?? '';
    if (v) out.push(v);
  }
  return out;
}

/** 生效的 cookies 路径（设置值优先，否则用默认路径） */
export function cookiesPathOf(settings?: { webvideoCookiesFile?: string }): string {
  const p = String(settings?.webvideoCookiesFile ?? '').trim();
  return p || config.webvideo.defaultCookiesFile;
}

/** 存在且可读的 cookies 文件（不存在返回 null） */
export function resolveCookiesFile(settings?: { webvideoCookiesFile?: string }): string | null {
  const p = cookiesPathOf(settings);
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/** 由设置推导解析参数（cookies / 额外参数），保证「解析」与「下载」用同一套凭据 */
export function parseOptionsFromSettings(settings?: {
  webvideoCookiesFile?: string;
  webvideoCookiesFromBrowser?: string;
  webvideoExtraArgs?: string;
}): ParseOptions {
  const cookiesFile = resolveCookiesFile(settings);
  return {
    cookiesFile,
    cookiesFromBrowser: cookiesFile ? '' : String(settings?.webvideoCookiesFromBrowser ?? '').trim(),
    extraArgs: parseExtraArgs(String(settings?.webvideoExtraArgs ?? '')),
  };
}

/**
 * 把 cookies 文件里出现的域名整理成「站点说明」：
 * 让用户一眼看到「这份 cookies 是给谁的」以及「哪些站点其实不用人工导出」。
 */
function describeCookieSites(byDomain: Record<string, number>): CookiesStatus['sites'] {
  const harvest = harvestStatus();
  return Object.entries(byDomain)
    .sort((a, b) => b[1] - a[1])
    .map(([domain, count]) => {
      const profile = SITE_PROFILES.find((p) => {
        const host = domain.replace(/^\./, '');
        return hostMatchesHost(host, p.id);
      });
      const auto = !!profile && harvest.harvestSites.includes(profile.id);
      return {
        domain,
        count,
        auto,
        note: auto
          ? `${profile?.name ?? domain} 可以自动获取访客 cookies，不必人工导出（这份只是备用）`
          : profile?.loginOnlyNote ?? '需要登录态的内容才用得上这份 cookies',
      };
    });
}

/** 域名是否属于某个站点配置（按 profile 的 harvestUrl 主机名判断） */
function hostMatchesHost(host: string, siteId: string): boolean {
  const p = SITE_PROFILES.find((x) => x.id === siteId);
  if (!p) return false;
  return p.test(`https://${host}/`);
}

/** 查询 cookies 状态（给 /api/webvideo/cookies 用） */export async function cookiesStatus(): Promise<CookiesStatus> {
  const { getSettings } = await import('../services/settings');
  const s = getSettings();
  const file = cookiesPathOf(s);
  let exists = false;
  let sizeBytes = 0;
  let updatedAt: string | null = null;
  try {
    const st = fs.statSync(file);
    exists = st.isFile();
    sizeBytes = st.size;
    updatedAt = st.mtime.toISOString();
  } catch {
    /* 不存在 */
  }
  const inspected = exists
    ? inspectCookiesFile(file)
    : {
        valid: false,
        warnings: ['还没有上传 cookies：会员专享 / 需登录 / 年龄限制的视频需要它'],
        notes: [] as string[],
        stats: {
          total: 0,
          byDomain: {} as Record<string, number>,
          keys: Object.fromEntries(CRITICAL_COOKIE_KEYS.map((k) => [k, false])) as Record<string, boolean>,
          expiredCount: 0,
          hasHeader: false,
          hasGoogleDomain: false,
          hasYoutubeDomain: false,
        },
      };
  const sites = describeCookieSites(inspected.stats.byDomain);
  const notes = [...inspected.notes];
  // 关键澄清：cookies 是按站点隔离的；能用自动化拿到的站点不需要人工导出
  if (sites.length) {
    const autoSites = sites.filter((x) => x.auto).map((x) => x.domain);
    const otherSites = sites.filter((x) => !x.auto).map((x) => x.domain);
    notes.push(
      `这份 cookies 覆盖：${sites.map((x) => `${x.domain}(${x.count})`).join('、')}。` +
        `cookies 是**按站点隔离**的 —— 它只对上面这些站点生效；` +
        (autoSites.length ? `${autoSites.join('、')} 这类站点由服务器自动获取，不需要人工导出；` : '') +
        (otherSites.length ? `${otherSites.join('、')} 的登录内容才需要你手工导出这一份。` : ''),
    );
  }
  return {
    cookiesFile: file,
    defaultPath: config.webvideo.defaultCookiesFile,
    exists,
    sizeBytes,
    updatedAt,
    fromBrowser: String(s.webvideoCookiesFromBrowser ?? ''),
    valid: inspected.valid,
    warnings: inspected.warnings,
    notes,
    sites,
    harvest: harvestStatus(),
    stats: inspected.stats,
  };
}

/* ------------------------------------------------------------------ */
/* 「想尽办法」下载策略阶梯                                             */
/* ------------------------------------------------------------------ */

export interface DownloadAttempt {
  /** 展示给用户/日志用的中文名字 */
  label: string;
  /** 追加到本次 yt-dlp 调用的参数 */
  args: string[];
}

export interface AttemptContext {
  formatId: string;
  /** 已确认存在的 cookies 文件路径 */
  cookiesFile: string | null;
  /** ''=不启用 */
  cookiesFromBrowser: string;
  isYouTube: boolean;
  /** 站点专用额外参数（Referer/UA 等；抖音必需，实测不带 referer 就一定失败） */
  siteExtraArgs?: string[];
}

/**
 * YouTube 多客户端回退：某个客户端被限流/要求登录时换下一个。
 * 实测（树莓派 + cookies + deno 挑战求解）web_safari 成功率最高，放在最前；
 * mweb 基本必失败，已移出列表。
 */
export const YOUTUBE_TRY_CLIENTS = 'youtube:player_client=web_safari,default,tv,android_vr,web_embedded';
/** 只走网页内嵌播放器（对部分受限视频可绕过 web 端校验） */
export const YOUTUBE_EMBEDDED_CLIENT = 'youtube:player_client=web_embedded,tv_embedded';
/**
 * 跳过网页/配置抓取，直接打 player API。
 * 用于 yt-dlp 报 "The page needs to be reloaded." 的场景（见 yt-dlp issue #14610 等）。
 */
export const YOUTUBE_SKIP_WEBPAGE = 'youtube:player_skip=webpage,configs;player_client=web_safari,web';

/** 常见桌面 Chrome UA（有些站点会因 UA/语言不匹配而拒绝） */
export const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 生成按「成功率优先」排序的下载方式序列：
 * 指定格式 -> cookies -> 最佳画质 -> 多客户端 -> 长重试/放宽校验 -> 浏览器指纹 ->
 * 单文件（跳过合并）-> 仅视频流 -> 仅音频保底。
 * 只有全部失败才会把任务判为失败。
 */
export function buildDownloadAttempts(ctx: AttemptContext): DownloadAttempt[] {
  const attempts: DownloadAttempt[] = [];
  const seen = new Set<string>();
  const push = (label: string, args: string[]): void => {
    const key = args.join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({ label, args });
  };

  const cookieArgs: string[] = ctx.cookiesFile
    ? ['--cookies', ctx.cookiesFile]
    : ctx.cookiesFromBrowser
      ? ['--cookies-from-browser', ctx.cookiesFromBrowser]
      : [];
  // 站点专用参数（如抖音的 --referer）必须**每一次**尝试都带上，否则带对了 cookie 也会被拒
  const siteArgs = ctx.siteExtraArgs ?? [];
  const withCookies = (args: string[]): string[] => [...cookieArgs, ...siteArgs, ...args];

  const best = ['-f', 'bv*+ba/b'];
  const singleFile = ['-f', 'b[ext=mp4]/b/bv*+ba'];
  const videoOnly = ['-f', 'bv*/bv'];
  const audioOnly = ['-f', 'ba/b'];
  const multiClient = ['--extractor-args', YOUTUBE_TRY_CLIENTS];
  const embedded = ['--extractor-args', YOUTUBE_EMBEDDED_CLIENT];

  // 1) 用户明确选定的格式（+cookies）
  if (ctx.formatId) {
    const f = `${ctx.formatId}+ba/${ctx.formatId}/bv*+ba/b`;
    if (cookieArgs.length) push('登录态 + 指定格式', withCookies(['-f', f]));
    push('指定格式', ['-f', f]);
  }
  // 2) 带登录态的各个档位（会员/风控视频成功率最高，因此全部排在最前）
  if (cookieArgs.length) {
    push('登录态 + 最佳画质', withCookies(best));
    if (ctx.isYouTube) {
      // 实测最稳的一档（需要 deno 解 n challenge；没有 JS 运行时这档也会失败）
      push('登录态 + web_safari', withCookies(['--extractor-args', 'youtube:player_client=web_safari', ...best]));
      push('登录态 + 多客户端', withCookies([...multiClient, ...best]));
    }
    push('登录态 + 浏览器 UA/语言', withCookies(['--user-agent', DESKTOP_CHROME_UA, '--add-header', 'Accept-Language:en-US,en;q=0.9', ...best]));
    // 「The page needs to be reloaded.」的绕法：跳过网页抓取直接请求 player API（有 cookies 时最有效）
    if (ctx.isYouTube) push('登录态 + 跳过网页抓取', withCookies(['--extractor-args', YOUTUBE_SKIP_WEBPAGE, ...best]));
  }
  // 3) 无登录态的各种尝试
  push('最佳画质', best);
  if (ctx.isYouTube) push('多客户端回退', [...multiClient, ...best]);
  if (ctx.isYouTube) push('跳过网页抓取（player API 直连）', ['--extractor-args', YOUTUBE_SKIP_WEBPAGE, ...best]);
  push('长重试 + 放宽校验', [
    '--retries',
    '20',
    '--fragment-retries',
    '20',
    '--retry-sleep',
    '5',
    '--no-check-certificates',
    '--geo-bypass',
    ...best,
  ]);
  push('模拟浏览器指纹', ['--impersonate', 'chrome', ...best]);
  if (ctx.isYouTube) push('内嵌播放器客户端', [...embedded, ...singleFile]);
  push('单文件直下（跳过合并）', singleFile);
  push('仅视频流（可能无音轨）', videoOnly);
  push('仅音频（保底）', audioOnly);
  return attempts;
}


/* ------------------------------------------------------------------ */
/* 退避策略（机器人校验/限流）                                          */
/* ------------------------------------------------------------------ */

/**
 * 「需要新鲜 cookies」类错误（**不是**限流）。
 *
 * 抖音/TikTok 的网页接口需要浏览器 JS 挑战生成的 __ac_signature/ttwid，yt-dlp 报的是
 * `Fresh cookies (not necessarily logged in) are needed` —— 这句话非常容易被误判成
 * 「被风控/要登录」，于是我们之前会停手并让用户等 10~30 分钟（完全搞错方向）。
 * 正确做法：自动用无头浏览器抓一次访客 cookies 再重试。
 */
export function isCookieRequiredError(raw: string): boolean {
  const s = raw.toLowerCase();
  // 先排除「限流/机器人校验」：YouTube 那句 `Sign in to confirm you're not a bot ... Use --cookies`
  // 里也含 "use --cookies"，若不做排除会被误判成 cookie 问题（那就不会退避，反而越打越封）。
  if (/sign in to confirm|not a bot|too many requests|http error 429|rate limit/.test(s)) return false;
  return (
    s.includes('fresh cookies') ||
    s.includes('use --cookies') ||
    s.includes('cookies for the authentication') ||
    s.includes('cookies are needed') ||
    s.includes('needs cookies') ||
    // 中文文案（humanizeYtDlpError 之后可能已经是这句）
    raw.includes('需要新鲜访客 cookies')
  );
}

/** 机器人校验/限流类错误：短时间连打只会让 IP 被封得更久 */
export function isRateLimitError(raw: string): boolean {
  // 需要 cookies 的问题不能按限流处理（那样会「等 30 分钟」而不是去抓 cookie）
  if (isCookieRequiredError(raw)) return false;
  const s = raw.toLowerCase();
  return (
    // 原始英文（yt-dlp 输出）
    s.includes('not a bot') ||
    s.includes('sign in to confirm') ||
    s.includes('too many requests') ||
    s.includes('http error 429') ||
    s.includes('try again later') ||
    s.includes('rate limit') ||
    // 已经过 humanizeYtDlpError 的中文文案（计数时拿到的可能是中文）
    raw.includes('机器人校验') ||
    raw.includes('判定为机器人') ||
    raw.includes('限流')
  );
}

/** 读可配置毫秒数：**未设置/为空时必须用默认值**（Number('') === 0 曾把阈值误设成 0） */
const envMs = (name: string, def: number): number => {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : def;
};

/* ------------------------------------------------------------------ */
/* 下载进程管理                                                        */
/* ------------------------------------------------------------------ */

interface AttemptFailure {
  label: string;
  /** 已本地化的中文说明（给用户看） */
  message: string;
  /**
   * yt-dlp 的**原始**输出（给程序判断用）。
   * 教训：之前拿本地化后的中文去判断「是不是被限流」，改文案就会把判断改坏
   * （中文里少了「人机校验」四个字，限流检测就失效、把整条阶梯白跑一遍并挨更多风控）。
   */
  raw: string;
}

interface LaunchContext {
  commonArgs: string[];
  url: string;
}

interface RunningJob {
  child: ChildProcess | null;
  /** 本次任务的完整策略阶梯 */
  attempts: DownloadAttempt[];
  /** 任务 URL（错误建议按站点区分时用） */
  url?: string;
  attemptIndex: number;
  attemptStartedAt: number;
  attemptErrors: AttemptFailure[];
  /** 每个方式已原地重试次数（瞬时错误用） */
  attemptRetries?: Record<number, number>;
  /** 重建策略阶梯所需的信息（cookie 失效时用新 cookie 重来一轮） */
  attemptCtx?: AttemptContext;
  /** 是否已经因为「cookie 失效」重来过一轮（只自愈一次，避免死循环） */
  reharvested?: boolean;
  stdout: string;
  stderr: string;
  startedAt: number;
  lastProgress: { progress: number; speedBps: number; etaSec: number | null; totalBytes: number; downloadedBytes: number; text: string };
  exitCode: number | null;
  paused: boolean;
  cancelled: boolean;
}

const jobs = new Map<number, RunningJob>();

/** 汇总所有失败尝试，给出「试过什么」的最终错误 */
function buildFinalError(job: RunningJob): string {
  const last = job.attemptErrors[job.attemptErrors.length - 1];
  const base = last?.message ?? '下载失败（未知原因）';
  const rateLimited = job.attemptErrors.filter((e) => isRateLimitError(e.raw || e.message)).length;
  const suffix =
    job.attemptErrors.length <= 1
      ? ''
      : `（已自动尝试 ${job.attemptErrors.length} 种方式：${job.attemptErrors.map((e) => e.label).join('、')}）`;
  const site = profileFor(job.url ?? '');
  const advice =
    rateLimited >= Math.max(2, Math.ceil(job.attemptErrors.length / 2))
      ? site?.id === 'youtube'
        ? '。多数失败都是「YouTube 判定为机器人/限流」：请等待 10~30 分钟再重试（短时间内反复重试会让该 IP 被限流更久），' +
          '并确认已安装 JS 运行时（deno，见首页网络自检的「yt-dlp JS 运行时」一项）；如有代理，可在设置里加 --proxy 换出口 IP'
        : '。看起来是出口 IP 被该平台限流：请等待 10~30 分钟再试，或在设置里配置代理换出口 IP'
      : '';
  return `${base}${suffix}${advice}`;
}

/** 启动当前 attemptIndex 指向的那次尝试 */
function launchAttempt(taskId: number, job: RunningJob, ctx: LaunchContext): void {
  const attempt = job.attempts[job.attemptIndex];
  job.attemptStartedAt = Date.now();
  job.stdout = '';
  job.stderr = '';
  job.lastProgress = {
    progress: 0,
    speedBps: 0,
    etaSec: null,
    totalBytes: 0,
    downloadedBytes: 0,
    text: `方式 ${job.attemptIndex + 1}/${job.attempts.length}：${attempt.label}`,
  };
  const args = [...ctx.commonArgs, ...attempt.args, ctx.url];
  const scoped = taskLog(taskId, 'ytdlp');
  scoped.mark('YTDLP_ATTEMPT', `尝试方式 ${job.attemptIndex + 1}/${job.attempts.length}：${attempt.label}`, {
    bin: config.bins.ytdlp,
    args,
    cookies: args.includes('--cookies') ? args[args.indexOf('--cookies') + 1] : args.includes('--cookies-from-browser') ? `browser:${args[args.indexOf('--cookies-from-browser') + 1]}` : '(无)',
    url: ctx.url,
  });
  const child = spawn(config.bins.ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  job.child = child;
  child.stdout?.on('data', (d: Buffer) => {
    const text = d.toString();
    job.stdout += text;
    for (const line of text.split('\n')) if (line.trim()) parseProgressLine(line, job);
  });
  child.stderr?.on('data', (d: Buffer) => {
    job.stderr += d.toString();
  });
  child.on('error', (e) => {
    job.stderr += `\n进程启动失败: ${e.message}`;
  });
  child.on('close', (code) => {
    if (job.cancelled) {
      scoped.mark('YTDLP_EXIT', `方式「${attempt.label}」被用户取消`, { code });
      return;
    }
    const exit = code ?? -1;
    const ms = Date.now() - job.attemptStartedAt;
    if (exit === 0) {
      scoped.mark('YTDLP_EXIT', `方式「${attempt.label}」成功 code=0（${ms}ms）`, {
        stdout: tailText(job.stdout, 800),
        stderr: job.stderr ? tailText(job.stderr, 800) : undefined,
      });
      job.exitCode = 0;
      return;
    }
    const message = humanizeYtDlpError(job.stderr || job.stdout, ctx.url);
    const failedLabel = job.attempts[job.attemptIndex].label;
    const rawErr = `${job.stderr}\n${job.stdout}`.toLowerCase();

    // ★ 自愈：站点说「cookie 失效/需要新鲜 cookie」时，重新抓一次访客 cookies 再重来一轮。
    //   这就是「不用人工天天导出 cookies」的关键一步（抖音的签名 cookie 几小时就过期）。
    if (isCookieRequiredError(`${job.stderr}\n${job.stdout}`) && !job.reharvested && job.attemptCtx) {
      const profile = profileFor(ctx.url);
      if (profile) {
        job.reharvested = true;
        scoped.mark('YTDLP_ATTEMPT', `${profile.name} 提示 cookie 失效/需要新鲜 cookies —— 自动重新获取后重试`);
        void (async () => {
          try {
            const meta = await harvestNow(profile.id);
            if (!meta?.file) throw new Error('没有拿到新的 cookies');
            job.attemptCtx = { ...job.attemptCtx!, cookiesFile: meta.file, cookiesFromBrowser: '' };
            job.attempts = buildDownloadAttempts(job.attemptCtx);
            job.attemptIndex = 0;
            job.attemptErrors = [];
            job.attemptRetries = {};
            job.stderr = '';
            job.stdout = '';
            job.exitCode = null;
            jobs.set(taskId, job);
            scoped.mark('YTDLP_ATTEMPT', `已用新获取的 ${profile.name} cookies 重新开始（${meta.cookieCount} 条）`);
            launchAttempt(taskId, job, ctx);
          } catch (e) {
            scoped.error(`[MARK:${COOKIE_MARKER}] 自动重新获取 cookies 失败：${(e as Error).message}`);
            job.exitCode = exit;
          }
        })();
        return;
      }
    }
    // 瞬时性错误（YouTube 风控抖一下/页面需要刷新）：先原地重试，不急着换方式
    const transient =
      rawErr.includes('page needs to be reloaded') ||
      rawErr.includes('sign in to confirm') ||
      rawErr.includes('http error 5') ||
      rawErr.includes('connection reset') ||
      rawErr.includes('timed out') ||
      rawErr.includes('temporarily unavailable');
    const retries = job.attemptRetries?.[job.attemptIndex] ?? 0;
    // 机器人校验 / 限流类错误：**连打只会让 IP 更被封**，所以退避要长（30s / 90s）
    const rateLimited = isRateLimitError(rawErr);
    if (transient && retries < 2 && !job.cancelled) {
      job.attemptRetries = { ...(job.attemptRetries ?? {}), [job.attemptIndex]: retries + 1 };
      const delay = rateLimited
        ? envMs('YTDLP_RATE_LIMIT_BACKOFF_MS', 30_000) * (retries + 1)
        : envMs('YTDLP_TRANSIENT_BACKOFF_MS', 3_000) * (retries + 1);
      scoped.warn(
        `[MARK:YTDLP_EXIT] 方式「${failedLabel}」遇到瞬时错误，${delay / 1000}s 后原地重试（第 ${retries + 1}/2 次）：${message}`,
      );
      setTimeout(() => {
        if (!job.cancelled && job.exitCode === null) launchAttempt(taskId, job, ctx);
      }, delay);
      return;
    }
    job.attemptErrors.push({ label: failedLabel, message, raw: `${job.stderr}\n${job.stdout}` });
    scoped.warn(
      `[MARK:YTDLP_EXIT] 方式「${failedLabel}」失败 code=${exit}（${ms}ms）：${message}`,
      { stderr: tailText(job.stderr, 2000), stdout: tailText(job.stdout, 1000), args },
    );
    const next = job.attemptIndex + 1;
    // 连续两种方式都被判为机器人/限流：继续换方式只会加剧风控，直接停手并给建议
    // （注意：这里**只**统计真正的限流；需要 cookies 的问题走上面的自愈分支，不能算限流）
    const rateLimitHits = job.attemptErrors.filter((e) => isRateLimitError(e.raw || e.message)).length;
    if (next < job.attempts.length && rateLimitHits >= envMs('YTDLP_RATE_LIMIT_MAX_ATTEMPTS', 2)) {
      scoped.error(
        `[MARK:TASK_FAIL] 连续 ${rateLimitHits} 种方式被判定为机器人/限流，停止继续尝试（避免加剧风控，请等待 10~30 分钟后重试）`,
      );
      job.exitCode = exit;
      return;
    }
    if (next < job.attempts.length) {
      job.attemptIndex = next;
      // 机器人校验/限流：换下一种方式前也留出间隔，否则连打只会让 IP 被封得更久
      const gap = rateLimited ? envMs('YTDLP_ATTEMPT_GAP_MS', 15_000) : 0;
      if (gap > 0) {
        scoped.warn(`[MARK:YTDLP_ATTEMPT] 疑似被限流，等待 ${gap / 1000}s 后再换下一种方式（避免加剧风控）`);
        setTimeout(() => {
          if (!job.cancelled && job.exitCode === null) launchAttempt(taskId, job, ctx);
        }, gap);
      } else {
        launchAttempt(taskId, job, ctx);
      }
      return;
    }
    job.exitCode = exit;
    scoped.error(`[MARK:TASK_FAIL] 全部 ${job.attempts.length} 种方式均失败：${message}`, {
      triedLabels: job.attempts.map((a) => a.label),
      attemptErrors: job.attemptErrors,
    });
  });
  // 若任务在启动瞬间处于暂停状态，直接冻结新进程
  if (job.paused) {
    try {
      process.kill(child.pid ?? 0, 'SIGSTOP');
    } catch {
      /* ignore */
    }
  }
}

function parseProgressLine(line: string, job: RunningJob): void {
  // 我们的 --progress-template 约定输出：PROG <downloaded> <total> <speed> <eta>
  const m = line.match(/PROG\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+|NA)/);
  if (m) {
    const downloaded = Number(m[1]);
    const total = Number(m[2]);
    const speed = Number(m[3]) / 8; // yt-dlp speed 单位 bytes/s，这里保持一致
    const eta = m[4] === 'NA' ? null : Number(m[4]);
    job.lastProgress = {
      downloadedBytes: downloaded,
      totalBytes: total,
      progress: total > 0 ? Math.min(99.9, (downloaded / total) * 100) : job.lastProgress.progress,
      speedBps: speed,
      etaSec: eta,
      text: `已下载 ${(downloaded / 1024 / 1024).toFixed(1)}MB`,
    };
    return;
  }
  const pct = line.match(/\[download\]\s+([\d.]+)%/);
  if (pct) {
    job.lastProgress.progress = Math.min(99.9, Number(pct[1]));
  }
}

function collectOutputFiles(dir: string, startedAt: number): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (e.name.endsWith('.part') || e.name.endsWith('.ytdl') || e.name.startsWith('.')) continue;
      try {
        const st = fs.statSync(p);
        if (st.size > 0 && st.mtimeMs >= startedAt - 2000) out.push(p);
      } catch {
        /* ignore */
      }
    }
  };
  walk(dir);
  return out;
}

export const webvideoModule: ModuleAdapter = {
  id: 'webvideo',

  async prepare(task): Promise<void> {
    if (!task.url) throw new Error('缺少视频 URL');
    const { tasksRepo } = await import('../core/db');
    let meta: ParseResult;
    try {
      const { getSettings } = await import('../services/settings');
      meta = await parseVideo(task.url, config.bins.ytdlp, 60000, parseOptionsFromSettings(getSettings()));
    } catch (e) {
      // 解析失败（会员专享/需登录/年龄限制/超时…）不再直接判任务失败，
      // 而是记下原因继续走「多重策略尽力下载」，只有全部方式都失败才算失败。
      const message = (e as Error).message;
      taskLog(task.id).warn(`[MARK:YTDLP_PARSE] 解析失败但仍继续尝试下载：${message}`);
      tasksRepo.update(task.id, {
        title: task.title || task.url,
        error: null,
        payload: { ...(task.payload ?? {}), parseError: message },
        meta: { ...((task.meta as Record<string, unknown> | null) ?? {}), parseError: message },
      });
      return;
    }
    const formatId = String((task.payload ?? {}).formatId ?? meta.defaultFormatId ?? '');
    const chosen = meta.formats.find((f) => f.id === formatId) ?? meta.formats.find((f) => f.id === meta.defaultFormatId) ?? null;
    task.expectBytes = chosen?.filesize ?? meta.expectedBytes ?? 0;
    taskLog(task.id).mark('YTDLP_PARSE', `解析结果：${meta.title}`, {
      platform: meta.platform,
      durationSec: meta.durationSec,
      author: meta.author,
      formatCount: meta.formats.length,
      chosenFormat: chosen ? `${chosen.id} ${chosen.resolution} ${chosen.ext}` : '(默认最佳)',
      expectBytes: task.expectBytes,
    });
    tasksRepo.update(task.id, {
      title: meta.title,
      platform: meta.platform,
      expectBytes: task.expectBytes,
      meta: {
        thumbnail: meta.thumbnail,
        durationSec: meta.durationSec,
        author: meta.author,
        resolution: chosen?.resolution ?? null,
        format: chosen?.ext ?? null,
        formats: meta.formats,
      },
      payload: { ...(task.payload ?? {}), formatId: chosen?.id ?? null },
    });
  },

  async start(task): Promise<void> {
    const tool = await toolStatus(config.bins.ytdlp, ['--version']);
    if (!tool.ok) throw new Error(`未安装 yt-dlp（${config.bins.ytdlp}）`);
    fs.mkdirSync(config.dirs.webTools, { recursive: true });
    const { getSettings } = await import('../services/settings');
    const settings = getSettings();
    const payload = task.payload ?? {};
    const formatId = String(payload.formatId ?? '');
    const url = task.url ?? '';

    // 组装通用参数（每次尝试都会带上）
    const commonArgs = [
      '--newline',
      '--no-playlist',
      '--no-warnings',
      '--continue',
      '--retries',
      '5',
      '--fragment-retries',
      '5',
      '--retry-sleep',
      '3',
      '--socket-timeout',
      '30',
      '--progress-template',
      'download:PROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.speed)s %(progress.eta)s',
      '-o',
      path.join(config.dirs.webTools, '%(title).150B [%(id)s].%(ext)s'),
    ];
    if (settings.maxSpeedBps > 0) commonArgs.push('-r', String(settings.maxSpeedBps));
    if (config.bins.ffmpeg) commonArgs.push('--ffmpeg-location', config.bins.ffmpeg);
    const extraArgs = parseExtraArgs(String(settings.webvideoExtraArgs ?? ''));
    if (extraArgs.length) commonArgs.push(...extraArgs);

    // 解析「这次该用哪套 cookies / 站点额外参数」：
    // 用户上传的 cookies（保留登录态）+ 服务端无头浏览器自动获取的访客 cookies（抖音这类必需）
    const userCookies = resolveCookiesFile(settings);
    const resolved = await cookiesForUrl(url, userCookies);
    taskLog(task.id).mark('YTDLP_ATTEMPT', `凭据准备：${resolved.note}`, {
      cookiesFile: resolved.cookiesFile,
      harvested: resolved.harvested,
      site: resolved.siteName,
      siteArgs: resolved.extraArgs,
    });
    const cookiesFile = resolved.cookiesFile;
    const cookiesFromBrowser = cookiesFile ? '' : String(settings.webvideoCookiesFromBrowser ?? '').trim();
    const platform = task.platform || detectPlatform(url);
    const attemptCtx: AttemptContext = {
      formatId,
      cookiesFile,
      cookiesFromBrowser,
      isYouTube: platform === 'YouTube',
      siteExtraArgs: resolved.extraArgs,
    };
    const attempts = buildDownloadAttempts(attemptCtx);

    const startedAt = Date.now();
    const job: RunningJob = {
      child: null,
      attempts,
      url,
      attemptCtx,
      attemptIndex: 0,
      attemptStartedAt: startedAt,
      attemptErrors: [],
      stdout: '',
      stderr: '',
      startedAt,
      lastProgress: { progress: 0, speedBps: 0, etaSec: null, totalBytes: 0, downloadedBytes: 0, text: '准备中' },
      exitCode: null,
      paused: false,
      cancelled: false,
    };
    jobs.set(task.id, job);
    launchAttempt(task.id, job, { commonArgs, url });

    const { tasksRepo } = await import('../core/db');
    tasksRepo.update(task.id, {
      status: 'downloading',
      error: null,
      startedAt: new Date().toISOString(),
      payload: { ...payload, formatId, attempts: attempts.map((a) => a.label) },
    });
    logger.child('ytdlp').mark('YTDLP_ATTEMPT', `任务 #${task.id} 策略阶梯已生成（共 ${attempts.length} 种方式）`, {
      url,
      formatId: formatId || '(默认)',
      platform,
      cookiesFile: cookiesFile ?? '(无)',
      cookiesFromBrowser: cookiesFromBrowser || '(无)',
      extraArgs,
      attempts: attempts.map((a, i) => `${i + 1}. ${a.label}`),
      workDir: config.dirs.webTools,
    });
  },

  async poll(task): Promise<PollResult> {
    const job = jobs.get(task.id);
    if (!job) return { error: '下载进程不存在（服务可能重启过），请重试' };
    const p = job.lastProgress;
    if (job.exitCode === null) {
      return {
        progress: p.progress,
        speedBps: job.paused ? 0 : p.speedBps,
        etaSec: job.paused ? null : p.etaSec,
        totalBytes: p.totalBytes,
        downloadedBytes: p.downloadedBytes,
      };
    }
    // 所有尝试都已结束
    jobs.delete(task.id);
    if (job.exitCode !== 0) {
      return { error: buildFinalError(job) };
    }
    const files = collectOutputFiles(config.dirs.webTools, job.startedAt);
    if (files.length === 0) {
      let listing: string[] = [];
      try {
        listing = fs.readdirSync(config.dirs.webTools);
      } catch {
        /* ignore */
      }
      taskLog(task.id, 'ytdlp').error('[MARK:YTDLP_DONE] 进程结束但没有找到输出文件', {
        dir: config.dirs.webTools,
        listing,
        stdout: tailText(job.stdout, 1000),
        stderr: tailText(job.stderr, 1000),
      });
      return { error: '下载进程结束但没有找到输出文件' };
    }
    files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    const main = files[0];
    taskLog(task.id, 'ytdlp').mark('YTDLP_DONE', `下载完成，产物 ${files.length} 个文件`, {
      files: files.map((f) => ({ path: f, sizeBytes: fs.statSync(f).size })),
      usedAttempts: job.attemptErrors.length + 1,
      failedAttempts: job.attemptErrors.map((e) => e.label),
      totalMs: Date.now() - job.startedAt,
    });
    const size = fs.statSync(main).size;
    const base = path.basename(main).replace(/\.(mp4|mkv|webm|m4a|mp3|flv|mov|avi)$/i, '');
    return {
      progress: 100,
      speedBps: 0,
      totalBytes: size,
      downloadedBytes: size,
      etaSec: 0,
      done: { files: [main], originalName: `${base}.mp4`.replace(/\.mp4$/, path.extname(main)), sizeBytes: size },
    };
  },

  async pause(task): Promise<void> {
    const job = jobs.get(task.id);
    if (!job || job.exitCode !== null) return;
    job.paused = true;
    try {
      process.kill(job.child?.pid ?? 0, 'SIGSTOP');
    } catch {
      /* ignore */
    }
  },

  async resume(task): Promise<void> {
    const job = jobs.get(task.id);
    if (!job || job.exitCode !== null) return;
    job.paused = false;
    try {
      process.kill(job.child?.pid ?? 0, 'SIGCONT');
    } catch {
      /* ignore */
    }
  },

  async cancel(task): Promise<void> {
    const job = jobs.get(task.id);
    if (!job) return;
    job.cancelled = true;
    jobs.delete(task.id);
    const pid = job.child?.pid ?? 0;
    try {
      process.kill(pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }, 3000);
    } catch {
      /* ignore */
    }
  },
};
