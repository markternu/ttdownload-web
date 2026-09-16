/**
 * BT 种子内容甄别：从一堆文件里挑出"要下的核心内容"，把广告/垃圾排除掉。
 *
 * 为什么不能只看扩展名（旧逻辑）：
 *   旧逻辑只判断"扩展名是视频或图片 → 全要"，于是宣传图、广告视频、网址文件
 *   统统下下来。用户的诉求是"要种子的核心内容"，而核心内容几乎总是视频。
 *
 * 为什么不能只用体积（用户明确否掉的）：
 *   有些核心视频就只有几十 MB，一刀切"小于 N MB 不要"会把正片删掉。
 *
 * 所以这里用**组合规则**，并且把每个文件"留/弃 + 原因"全部回传，让用户看得见、
 * 能自己调（关键词表在设置里可改）：
 *   ① 扩展名：只认视频；图片按下面的策略
 *   ② 关键词：文件名/所在目录命中广告词 → 弃（广告几乎都有明显特征词）
 *   ③ 体积下限：可选、默认关闭（避免武断）
 *   ④ 图片策略：默认 auto —— 种子里只要有视频，图片就按广告处理；整包都是图片
 *      （照片合集）时才保留
 */

export interface BtFileEntry {
  name: string;
  length: number;
}

export interface BtSelectOptions {
  videoExts: string[];
  imageExts: string[];
  /** auto（默认）/ always / never */
  keepImages?: 'auto' | 'always' | 'never';
  blockKeywords?: string[];
  /** 0 = 不按体积过滤（默认） */
  minVideoBytes?: number;
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
  hasVideo: boolean;
  keptBytes: number;
}

/**
 * 默认广告关键词。都是"出现在文件名/目录里基本就能判定是广告"的强特征词，
 * 故意不放「更多/最新/请/关注」这类容易误伤正片的词。
 * 用户可在设置里增删（英文大小写不敏感）。
 */
export const DEFAULT_BT_BLOCK_KEYWORDS = [
  // 中文强特征
  '广告', '宣傳', '宣传', '推广', '加群', '微信群', '微信', '二维码', '扫码', '扫一扫',
  '电报群', '电报', '推特', '官网', '网址', '最新地址', '获取地址', '发布页', '必看', '说明',
  '試看', '试看', '预告片', '预告', '图片', '封面', '截图',
  // 英文/通用
  'advert', 'advertisement', 'promo', 'sponsor', 'banner', 'trailer', 'sample', 'preview',
  'screenshot', 'screen', 'poster', 'cover', 'thumb', 'qr', 'telegram', 'twitter',
];

export function extOfName(name: string): string {
  const base = String(name || '').split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i < 0 ? '' : base.slice(i + 1).toLowerCase();
}

/** 命中哪个关键词（大小写不敏感，匹配整个相对路径：目录名也参与） */
export function matchedKeyword(name: string, keywords: string[]): string | null {
  const lower = String(name || '').toLowerCase();
  for (const k of keywords) {
    const kw = String(k || '').trim().toLowerCase();
    if (kw && lower.includes(kw)) return k;
  }
  return null;
}

export function selectBtFiles(files: BtFileEntry[], opts: BtSelectOptions): BtSelectResult {
  const videoExts = new Set((opts.videoExts ?? []).map((e) => e.toLowerCase()));
  const imageExts = new Set((opts.imageExts ?? []).map((e) => e.toLowerCase()));
  const keywords = (opts.blockKeywords ?? DEFAULT_BT_BLOCK_KEYWORDS).filter((k) => String(k).trim());
  const keepImages = opts.keepImages ?? 'auto';
  const minVideoBytes = Math.max(0, Number(opts.minVideoBytes ?? 0) || 0);

  const dropped: BtDropInfo[] = [];
  const videos: number[] = [];
  const images: number[] = [];

  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const name = String(f?.name ?? '');
    const size = Math.max(0, Number(f?.length ?? 0) || 0);
    const ext = extOfName(name);
    const isVideo = videoExts.has(ext);
    const isImage = imageExts.has(ext);

    // ① 扩展名
    if (!isVideo && !isImage) {
      dropped.push({ index: i, name, sizeBytes: size, reason: `不是视频/图片（.${ext || '无扩展名'}）` });
      continue;
    }
    // ② 广告关键词（目录名也参与匹配）
    const hit = matchedKeyword(name, keywords);
    if (hit) {
      dropped.push({ index: i, name, sizeBytes: size, reason: `命中广告关键词「${hit}」` });
      continue;
    }
    // ③ 视频体积下限（默认关闭）
    if (isVideo && minVideoBytes > 0 && size > 0 && size < minVideoBytes) {
      dropped.push({
        index: i,
        name,
        sizeBytes: size,
        reason: `视频小于体积下限 ${(minVideoBytes / 1024 / 1024).toFixed(1)}MB`,
      });
      continue;
    }
    if (isVideo) videos.push(i);
    else images.push(i);
  }

  const hasVideo = videos.length > 0;
  const keep = [...videos];

  // ④ 图片策略
  let keepImageIdx: number[] = [];
  if (keepImages === 'always') keepImageIdx = images;
  else if (keepImages === 'never') {
    for (const i of images) {
      dropped.push({ index: i, name: String(files[i]?.name ?? ''), sizeBytes: Number(files[i]?.length ?? 0), reason: '设置里已关闭图片' });
    }
  } else {
    // auto：有视频就丢图片（几乎都是宣传图/封面），整包没有视频才当照片合集保留
    if (hasVideo) {
      for (const i of images) {
        dropped.push({
          index: i,
          name: String(files[i]?.name ?? ''),
          sizeBytes: Number(files[i]?.length ?? 0),
          reason: '同一种子里已有视频，图片按宣传图/封面排除',
        });
      }
    } else {
      keepImageIdx = images;
    }
  }
  keep.push(...keepImageIdx);
  keep.sort((a, b) => a - b);

  const keptBytes = keep.reduce((sum, i) => sum + Math.max(0, Number(files[i]?.length ?? 0) || 0), 0);
  return { keep, dropped, hasVideo, keptBytes };
}

/**
 * 把要发布的文件分成"发布单元"：
 *   - 单个文件 ≥ 阈值 → 自己一个单元（走"移动"，不打包，不加密前再压缩）
 *   - 其余小文件 → 全部合成**一个**单元（会被打成 zip 再加密）
 * 这样"一个种子里多个大视频"不再被塞进同一个大 zip。
 */
export interface PublishUnit {
  files: string[];
  name: string;
}

export function buildPublishUnits(
  paths: string[],
  minIndividualBytes: number,
  sizeOf: (p: string) => number,
  nameOf: (p: string) => string,
  fallbackName: string,
): PublishUnit[] {
  const threshold = Math.max(0, Number(minIndividualBytes) || 0);
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
  else if (small.length > 1) units.push({ files: small, name: fallbackName });
  return units;
}
