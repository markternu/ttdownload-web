/**
 * BT 选片：**只按视频后缀挑**，别的什么都不判断。
 *
 * 为什么不搞"广告识别"了（用户明确要求删掉）：
 *   之前用"关键词 + 图片策略 + 体积下限"去猜哪些是广告，结果把要下的正片也当广告排除了。
 *   这种判断天然不准 —— 而用户的原话是"你不要对 bt 任务做任何多余的操作，扔给
 *   transmission 让它下，让专业的人做专业的事"。所以现在只剩一条规则：
 *
 *     扩展名属于视频（mp4/avi/wmv/mkv/flv/webm/ts/m2ts/rmvb/…，大小写不敏感）→ 要
 *     其它一律不要（图片、txt、url、广告图、别人塞的 exe…都不下）
 *
 * 算出来的视频总大小用于**排队等待**（空间准入），这是唯一需要"算"的地方。
 */

export interface BtFileEntry {
  name: string;
  length: number;
}

export interface BtSelectOptions {
  /** 视频扩展名白名单（不含点，大小写不敏感） */
  videoExts: string[];
}

export interface BtDropInfo {
  index: number;
  name: string;
  sizeBytes: number;
  reason: string;
}

export interface BtSelectResult {
  keep: number[];
  dropped: BtDropInfo[];
  keptBytes: number;
}

export function extOfName(name: string): string {
  const base = String(name || '').split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i < 0 ? '' : base.slice(i + 1).toLowerCase();
}

/** 只留视频。就这么简单。 */
export function selectBtFiles(files: BtFileEntry[], opts: BtSelectOptions): BtSelectResult {
  const videoExts = new Set((opts.videoExts ?? []).map((e) => String(e).toLowerCase().replace(/^\./, '')));
  const keep: number[] = [];
  const dropped: BtDropInfo[] = [];
  let keptBytes = 0;
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const name = String(f?.name ?? '');
    const size = Math.max(0, Number(f?.length ?? 0) || 0);
    const ext = extOfName(name);
    if (videoExts.has(ext)) {
      keep.push(i);
      keptBytes += size;
    } else {
      dropped.push({ index: i, name, sizeBytes: size, reason: `不是视频文件（.${ext || '无扩展名'}）` });
    }
  }
  return { keep, dropped, keptBytes };
}

/**
 * 把一批**已经下载好**的文件分成"发布单元"：
 *   - 单个文件 ≥ smallFileMaxBytes → 一个一个单独走（各自一个成品）
 *   - 其余（都小于阈值）→ 全部装进一个单元，会被打成 zip 再加密
 * 阈值默认 300MB（用户要求）。
 */
export interface PublishUnit {
  files: string[];
  name: string;
}

export function buildPublishUnits(
  paths: string[],
  smallFileMaxBytes: number,
  sizeOf: (p: string) => number,
  nameOf: (p: string) => string,
  folderName: string,
): PublishUnit[] {
  const threshold = Math.max(0, Number(smallFileMaxBytes) || 0);
  const big: string[] = [];
  const small: string[] = [];
  for (const p of paths) {
    const size = Math.max(0, Number(sizeOf(p)) || 0);
    if (threshold > 0 && size >= threshold) big.push(p);
    else small.push(p);
  }
  const units: PublishUnit[] = [];
  for (const p of big) units.push({ files: [p], name: nameOf(p) });
  if (small.length === 1) units.push({ files: small, name: nameOf(small[0]) });
  else if (small.length > 1) units.push({ files: small, name: folderName });
  return units;
}

/* ============================================================================
 * "独树一帜，下最大；相差无几，一起下" —— 多个视频时挑"同类"，排掉"异类"
 *
 * 用户的原话与例子：
 *   情况1: 3 个视频 [2G, 200M, 150M] -> 只下最大的那个（它与其他相差悬殊）
 *   情况2: 4 个视频 [1G, 2G, 100M, 160M] -> 下大的那几个（1G/2G 是同类，小的异类）
 *   情况3: 一个"相对大"但其实不到 200M，而小的有一堆（≥3）-> 下那一堆小的，不下那个大的
 *   只有一个视频: 没得判断，直接下
 *
 * 算法：
 *   按体积降序。
 *   ① "独树一帜"：最大者 ≥ 第二大的 bigRatio 倍 -> 只下最大的
 *      （例外=情况3：最大的本身还不到 smallCeilingBytes，且后面有 ≥ manySmallCount 个
 *        小文件 —— 那这个"大"其实是个片头/预告，真正的内容是那一堆同类小文件）
 *   ② "相差无几"：否则取"与最大者体积相差不超过 bigRatio 倍"的那一组（同类），其余排除
 * ========================================================================== */

export interface DominantOptions {
  /** 体积相差多少倍就算"异类"（默认 5） */
  bigRatio: number;
  /** 情况3 的绝对上限：最大的不到这个字节数时，"一堆小文件"优先（默认 200MB） */
  smallCeilingBytes: number;
  /** 情况3 里"一堆小的"至少几个（默认 3） */
  manySmallCount: number;
}

export const DEFAULT_DOMINANT_OPTIONS: DominantOptions = {
  bigRatio: 5,
  smallCeilingBytes: 200 * 1024 ** 2,
  manySmallCount: 3,
};

export interface DominantResult {
  keep: number[];
  dropped: { index: number; name: string; sizeBytes: number; reason: string }[];
  /** 便于日志：这次用的是哪条规则 */
  rule: 'single' | 'unique-biggest' | 'many-smalls-over-weak-big' | 'similar-group';
  biggestBytes: number;
}

const fmtMB = (b: number) => `${(b / 1024 ** 2).toFixed(1)}MB`;

export function pickDominantVideos(files: BtFileEntry[], opts: Partial<DominantOptions> = {}): DominantResult {
  const o: DominantOptions = { ...DEFAULT_DOMINANT_OPTIONS, ...opts };
  const ratio = Math.max(1.01, Number(o.bigRatio) || 5);
  const ceiling = Math.max(0, Number(o.smallCeilingBytes) || 0);
  const many = Math.max(2, Number(o.manySmallCount) || 3);

  const order = files.map((_, i) => i).sort((a, b) => (files[b]?.length ?? 0) - (files[a]?.length ?? 0));
  const sizes = order.map((i) => Math.max(0, Number(files[i]?.length ?? 0) || 0));
  const info = (i: number) => ({ index: i, name: String(files[i]?.name ?? ''), sizeBytes: Math.max(0, Number(files[i]?.length ?? 0) || 0) });

  // 只有一个视频（或没有）：没得判断
  if (order.length <= 1) {
    return { keep: order, dropped: [], rule: 'single', biggestBytes: sizes[0] ?? 0 };
  }

  const s1 = sizes[0];
  const s2 = sizes[1];

  // ① 独树一帜：最大者比第二名大很多倍
  if (s1 >= s2 * ratio) {
    const rest = order.slice(1);
    // 例外（情况3）：最大的其实很小，而后面有一大堆小文件 -> 说明"大"的那个是片头/预告
    if (ceiling > 0 && s1 < ceiling && rest.length >= many) {
      return {
        keep: rest,
        dropped: [
          {
            ...info(order[0]),
            reason: `最大的只有 ${fmtMB(s1)}（不到 ${fmtMB(ceiling)}），而后面有 ${rest.length} 个同类小文件 —— 按"下同类"排除它`,
          },
        ],
        rule: 'many-smalls-over-weak-big',
        biggestBytes: s1,
      };
    }
    return {
      keep: [order[0]],
      dropped: rest.map((i) => ({
        ...info(i),
        reason: `独树一帜：最大的 ${fmtMB(s1)} 是它（${fmtMB(sizes[order.indexOf(i)])}）的 ${(s1 / Math.max(1, sizes[order.indexOf(i)])).toFixed(1)} 倍，不是同类`,
      })),
      rule: 'unique-biggest',
      biggestBytes: s1,
    };
  }

  // ② 相差无几：取与最大者相差不超过 ratio 倍的那一组（同类）
  const keep = order.filter((i) => {
    const s = Math.max(0, Number(files[i]?.length ?? 0) || 0);
    return s * ratio >= s1;
  });
  const keepSet = new Set(keep);
  const dropped = order
    .filter((i) => !keepSet.has(i))
    .map((i) => ({
      ...info(i),
      reason: `与最大的 ${fmtMB(s1)} 相差超过 ${ratio} 倍（只有 ${fmtMB(sizes[order.indexOf(i)])}），不是同类`,
    }));
  return { keep, dropped, rule: 'similar-group', biggestBytes: s1 };
}
