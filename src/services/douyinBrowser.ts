/**
 * 抖音解析兜底（yt-dlp 的 Douyin 提取器被风控挡住时用）。
 *
 * 为什么这么做：抖音当前的请求签名是 `a_bogus`（+ `__ac_signature`），由页面里的混淆 JS
 * 生成。自己重写算法等于长期逆向维护；社区维护型项目（f2 / TikTokDownloader /
 * Douyin_TikTok_Download_API）本质也是**跟着页面 JS 更新**。
 *
 * 所以这里走更稳的路子：**让抖音自己的页面 JS 完成签名**，我们在持久化 Chromium 里
 * 监听它自己发出的 `aweme/detail` 接口响应，直接把签名后的结果取出来。
 * 不碰签名算法，抖音改 JS 也不用我们改代码。
 */
import fs from 'node:fs';
import path from 'node:path';
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

/** 从 aweme_detail（或 _ROUTER_DATA）里取出可播放地址与元数据 */
function buildFromDetail(detail: Record<string, unknown>): DouyinExtract | null {
  const video = detail.video as Record<string, unknown> | undefined;
  if (!video) return null;
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

  // bit_rate 里通常是从低到高清的多档；先按码率排序，保证默认选最高画质
  const bitRates = Array.isArray(video.bit_rate) ? (video.bit_rate as Record<string, unknown>[]) : [];
  bitRates
    .map((b) => ({ b, rate: Number(b.bit_rate ?? 0) }))
    .sort((x, y) => y.rate - x.rate)
    .forEach(({ b }, i) => push(b.play_addr as PlayAddr | undefined, String(b.gear_name ?? ''), `br-${i}`));

  push(video.play_addr as PlayAddr | undefined, '默认', 'default');
  if (!formats.length) return null;

  const defaultFormatId = formats[0]?.id ?? null;
  const expectedBytes = formats[0]?.filesize ?? 0;
  return {
    title: desc || '抖音视频',
    author,
    thumbnail: cover,
    durationSec: durationMs > 0 ? Math.round(durationMs / 1000) : null,
    formats,
    defaultFormatId,
    expectedBytes,
  };
}

/** 用持久化 Chromium 打开抖音页面，截取它自己签名后的详情接口响应 */
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
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    page.setDefaultTimeout(timeoutMs);

    // 抖音页面自己会带着 a_bogus 签名去请求详情接口 —— 我们只把结果接住
    const onResponse = async (res: { url: () => string; json: () => Promise<unknown> }) => {
      if (found) return;
      const u = res.url();
      if (!/aweme\/(v1\/web\/)?aweme\/detail|aweme\/detail/.test(u)) return;
      try {
        const j = (await res.json()) as Record<string, unknown>;
        const detail = (j.aweme_detail ?? (j as { data?: { aweme_detail?: unknown } }).data?.aweme_detail) as
          | Record<string, unknown>
          | undefined;
        if (detail) found = buildFromDetail(detail);
      } catch {
        /* 不是 JSON 就算了 */
      }
    };
    page.on('response', onResponse as never);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const deadline = Date.now() + timeoutMs;
    while (!found && Date.now() < deadline) {
      await page.waitForTimeout(500);
      if (found) break;
      // 兜底 2：分享页常把数据塞在 window._ROUTER_DATA 里（SSR，不需要再发请求）
      if (Date.now() > deadline - timeoutMs / 2) {
        try {
          const rd = (await page.evaluate('window._ROUTER_DATA ?? null')) as Record<string, unknown> | null;
          const loader = rd?.loaderData as Record<string, unknown> | undefined;
          if (loader) {
            for (const v of Object.values(loader)) {
              const d = (v as { videoInfoRes?: { item_list?: Record<string, unknown>[] } })?.videoInfoRes?.item_list?.[0];
              if (d) {
                found = buildFromDetail(d);
                if (found) break;
              }
            }
          }
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }

  if (found) {
    scoped.mark('DOUYIN_FALLBACK', `浏览器兜底成功：${found.formats.length} 个清晰度`, {
      titleLength: found.title.length,
      formats: found.formats.map((f) => f.resolution),
    });
  } else {
    scoped.warn('[MARK:DOUYIN_FALLBACK] 浏览器兜底没拿到详情接口数据');
  }
  return found;
}
