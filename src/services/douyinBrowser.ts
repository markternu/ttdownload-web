/**
 * 抖音解析兜底（yt-dlp 的 Douyin 提取器被风控挡住时用）。
 *
 * 为什么这么做：抖音当前的请求签名是 `a_bogus`（+ `__ac_signature`），由页面里的混淆 JS
 * 生成。自己重写算法等于长期逆向维护；社区维护型项目（f2 / TikTokDownloader /
 * Douyin_TikTok_Download_API）本质也是**跟着页面 JS 更新**。
 *
 * 所以这里走更稳的路子：**让抖音自己的页面 JS 完成签名**，我们把签名后的结果取出来。
 * 两条取数通道，互为兜底：
 *   ① 监听页面自己发出的接口响应（含 aweme / detail 的 JSON）
 *   ② 页面加载后直接读 SSR 数据（window._ROUTER_DATA / __INIT_PROPS__），递归找视频对象
 * 不碰签名算法，抖音改 JS 也不用我们改代码。
 */
import fs from 'node:fs';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { chromeProfileDir, chromiumPath } from './cookieHarvest';
import type { FormatOption } from '../types';

export interface DouyinExtract {
  title: string;
  author: string | null;
  thumbnail: string | null;
  durationSec: number | null;
  formats: FormatOption[];
  defaultFormatId: string | null;
  expectedBytes: number;
}

export function isDouyinUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.endsWith('douyin.com') || h.endsWith('iesdouyin.com');
  } catch {
    return false;
  }
}

interface PlayAddr {
  url_list?: string[];
  data_size?: number;
  width?: number;
  height?: number;
}

/**
 * 在任意嵌套结构里找"带 video.play_addr 的视频对象"。
 * 不写死路径：抖音的 SSR / 接口结构经常变（_ROUTER_DATA → loaderData → videoInfoRes →
 * item_list[0]，或 aweme_detail），写死一条路就会像上次那样"没拿到详情接口数据"。
 */
export function findVideoNode(node: unknown, depth = 0): Record<string, unknown> | null {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  const obj = node as Record<string, unknown>;
  if (obj.aweme_detail && typeof obj.aweme_detail === 'object') {
    const d = findVideoNode(obj.aweme_detail, depth + 1);
    if (d) return d;
  }
  if (obj.video && typeof obj.video === 'object' && (obj.video as Record<string, unknown>).play_addr) {
    return obj;
  }
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findVideoNode(v, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const k of Object.keys(obj)) {
    const r = findVideoNode(obj[k], depth + 1);
    if (r) return r;
  }
  return null;
}

/** 从视频对象里取出可播放地址与元数据 */
export function buildFromDetail(detail: Record<string, unknown>): DouyinExtract | null {
  const video = detail.video as Record<string, unknown> | undefined;
  if (!video || !video.play_addr) return null;
  const desc = String(detail.desc ?? '').trim();
  const authorInfo = detail.author as Record<string, unknown> | undefined;
  const author = authorInfo?.nickname ? String(authorInfo.nickname) : null;
  const cover = (video.cover as PlayAddr | undefined)?.url_list?.[0] ?? null;
  const durationMs = Number(video.duration ?? 0);

  const formats: FormatOption[] = [];
  const seen = new Set<string>();
  const push = (addr: PlayAddr | undefined, label: string, id: string) => {
    const url = addr?.url_list?.[0];
    if (!url || seen.has(url)) return;
    seen.add(url);
    const w = Number(addr?.width ?? 0);
    const h = Number(addr?.height ?? 0);
    const short = w && h ? Math.min(w, h) : h || w;
    formats.push({
      id,
      ext: 'mp4',
      resolution: short ? `${short}p` : '?',
      label: `${short ? `${short}p` : '默认'} · MP4 · 视频+音频${label ? ` · ${label}` : ''}`,
      filesize: Number(addr?.data_size ?? 0) || null,
      vcodec: 'h264',
      acodec: 'aac',
    });
  };

  const bitRates = Array.isArray(video.bit_rate) ? (video.bit_rate as Record<string, unknown>[]) : [];
  bitRates
    .map((b) => ({ b, rate: Number(b.bit_rate ?? 0) }))
    .sort((x, y) => y.rate - x.rate)
    .forEach(({ b }, i) => push(b.play_addr as PlayAddr | undefined, String(b.gear_name ?? ''), `br-${i}`));
  push(video.play_addr as PlayAddr | undefined, '默认', 'default');
  if (!formats.length) return null;

  return {
    title: desc || '抖音视频',
    author,
    thumbnail: cover,
    durationSec: durationMs > 0 ? Math.round(durationMs / 1000) : null,
    formats,
    defaultFormatId: formats[0]?.id ?? null,
    expectedBytes: formats[0]?.filesize ?? 0,
  };
}

/** 用持久化 Chromium 打开抖音页面，两条通道取签名后的结果 */
export async function extractDouyinViaBrowser(url: string, timeoutMs = 45_000): Promise<DouyinExtract | null> {
  const exe = chromiumPath();
  if (!exe) throw new Error('服务器上没有 chromium，请先安装：sudo apt install -y chromium');
  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    throw new Error(`未安装 playwright，无法使用浏览器兜底解析：${(e as Error).message}`);
  }

  const profileDir = chromeProfileDir();
  fs.mkdirSync(profileDir, { recursive: true });
  const scoped = logger.child('douyin');
  scoped.mark('DOUYIN_FALLBACK', `yt-dlp 拿不到，改用浏览器兜底（让页面自己签名）：${url}`);

  const ctx = await chromium.launchPersistentContext(profileDir, {
    executablePath: exe,
    headless: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1366, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });

  let found: DouyinExtract | null = null;
  let sawApiResponse = 0;
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    page.setDefaultTimeout(timeoutMs);

    // 通道①：监听页面自己发出的接口响应（签名由页面完成）。匹配放宽到任何含 aweme 的 JSON。
    page.on('response', (res) => {
      void (async () => {
        if (found) return;
        const u = res.url();
        if (!/aweme|douyin/i.test(u)) return;
        const ct = (res.headers()['content-type'] ?? '').toLowerCase();
        if (!ct.includes('json')) return;
        try {
          const j = (await res.json()) as unknown;
          sawApiResponse += 1;
          const node = findVideoNode(j);
          if (node) found = buildFromDetail(node);
        } catch {
          /* 不是 JSON / 已被消费，忽略 */
        }
      })();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // 通道②：页面加载后直接读 SSR 数据（分享页常常直接内嵌，不需要再发接口）
    const readSsr = async (): Promise<void> => {
      if (found) return;
      try {
        const raw = (await page.evaluate(
          '(() => { try { return JSON.stringify([window._ROUTER_DATA ?? null, window.__INIT_PROPS__ ?? null, window.__INITIAL_STATE__ ?? null]); } catch { return ""; } })()',
        )) as string;
        if (!raw || raw === '[null,null,null]') return;
        const arr = JSON.parse(raw) as unknown[];
        for (const part of arr) {
          const node = findVideoNode(part);
          if (node) {
            found = buildFromDetail(node);
            if (found) return;
          }
        }
      } catch {
        /* ignore */
      }
    };

    const deadline = Date.now() + timeoutMs;
    // 先给页面一点时间跑 JS，再开始轮询两条通道
    await page.waitForTimeout(1500);
    while (!found && Date.now() < deadline) {
      await readSsr();
      if (found) break;
      await page.waitForTimeout(700);
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }

  // 显式收窄：found 是在上面的回调里赋值的，TS 看不到跨闭包赋值，会误判成 null/never
  const out = found as DouyinExtract | null;
  if (out) {
    scoped.mark('DOUYIN_FALLBACK', `浏览器兜底成功：${out.formats.length} 个清晰度（接口响应 ${sawApiResponse} 条）`, {
      titleLength: out.title.length,
      formats: out.formats.map((f: FormatOption) => f.resolution),
    });
  } else {
    scoped.warn(`[MARK:DOUYIN_FALLBACK] 浏览器兜底没拿到数据（接口响应 ${sawApiResponse} 条，SSR 也没找到视频对象）`);
  }
  return out;
}

/** 开发期用：把 URL 当参数直接跑一次兜底，方便真机排查 */
export const __configDirs = config.dirs;
