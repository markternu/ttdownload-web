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
