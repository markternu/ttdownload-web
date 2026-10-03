/**
 * 站点节流闸门：**同一个站点**的 yt-dlp 启动要排队，且相邻两次启动至少间隔 minGapMs。
 *
 * 为什么必须有这个（真机血案 2026-10-03）：
 *   用户一次入队 5 条抖音视频，而并发设置是「0 = 不限」→ 5 条任务同时各跑一条 10 档阶梯，
 *   日志实测 **一分钟内 26~31 次 yt-dlp 请求**砸向抖音同一个出口 IP → 立刻被风控限流。
 *   被限流后要静默约 2 分钟才恢复，于是"越急着下，越一条都下不动"。
 *
 * 线上产品都是这么做的：**服务端自己排队 + 退避重试**，而不是弹窗让用户"等 10 分钟再来"。
 *
 * 注意：这里限制的是「启动间隔」，不是「同时只跑一个」—— 视频下载本身可以并行（媒体在 CDN 上），
 * 只有**元数据/接口请求**才是被风控的对象。所以放行后立刻释放排队位。
 */

interface GateState {
  /** 排队链：保证同一站点的启动严格串行 */
  chain: Promise<void>;
  /** 上一次放行的时间戳（用于最小间隔） */
  lastStart: number;
  /** 排队中的任务数（只用于日志） */
  queued: number;
}

const gates = new Map<string, GateState>();

/** 只用于测试：清掉所有站点状态 */
export function __resetSiteGates(): void {
  gates.clear();
}

export interface SiteGateOptions {
  /** 相邻两次启动的最小间隔（毫秒） */
  minGapMs: number;
}

/**
 * 申请一次「启动许可」。返回释放函数（用完立刻调用，别等到下载结束）。
 * 若 minGapMs <= 0 则完全直通（不影响不受风控影响的站点）。
 */
export async function acquireSiteSlot(
  site: string,
  opts: SiteGateOptions,
): Promise<{ release: () => void; waitedMs: number }> {
  if (opts.minGapMs <= 0) return { release: () => undefined, waitedMs: 0 };

  const g = gates.get(site) ?? { chain: Promise.resolve(), lastStart: 0, queued: 0 };
  gates.set(site, g);

  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });

  const prev = g.chain;
  g.chain = prev.then(() => hold);
  g.queued += 1;
  const queuedAt = Date.now();

  await prev; // 排队等前一个放行
  g.queued -= 1;

  const waitMs = g.lastStart + opts.minGapMs - Date.now();
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  g.lastStart = Date.now();
  // 把"等了多久"还给调用方：由它决定要不要写进任务日志（闸门本身不依赖 logger，
  // 这样它可以被独立测试，不用起一整套运行时）
  return { release, waitedMs: Date.now() - queuedAt };
}

/**
 * 站点去重键 + 该站点的最小启动间隔。
 * 只有**按 IP 风控严格**的平台才需要节流；其它站点间隔为 0（直通，不拖慢）。
 */
export function siteGateFor(url: string): { site: string; minGapMs: number } {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { site: 'other', minGapMs: 0 };
  }
  const risky = /(^|\.)(douyin\.com|iesdouyin\.com|bytedance\.com|tiktok\.com)$/;
  if (risky.test(host)) {
    return { site: 'douyin', minGapMs: envGap() };
  }
  return { site: host, minGapMs: 0 };
}

/** 抖音类站点的启动间隔（可用环境变量调） */
function envGap(): number {
  const raw = Number(process.env.YTDLP_SITE_GAP_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 20_000;
}
