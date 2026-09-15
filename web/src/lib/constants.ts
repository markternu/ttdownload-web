import type { FormatOption, ModuleId } from '../types'

/** 首页平台提示的兜底清单（真实清单以 GET /api/webvideo/platforms 为准） */
export const FALLBACK_PLATFORMS = [
  'YouTube',
  'Bilibili',
  'Vimeo',
  'X',
  'TikTok',
  'Instagram',
  '抖音',
]

export interface QualityOption {
  value: string
  label: string
  height: number
}

/** 质量选项（height 仅用于按分辨率匹配 format 与估算体积） */
export const QUALITY_OPTIONS: QualityOption[] = [
  { value: '2160p', label: '2160P 超清', height: 2160 },
  { value: '1440p', label: '1440P 2K', height: 1440 },
  { value: '1080p', label: '1080P 高清', height: 1080 },
  { value: '720p', label: '720P 流畅', height: 720 },
  { value: '480p', label: '480P 标清', height: 480 },
  { value: '360p', label: '360P 省流', height: 360 },
  { value: 'audio', label: '仅音频', height: 0 },
]

/** 容器/格式选项 */
export const FORMAT_OPTIONS: { value: string; label: string }[] = [
  { value: 'mp4', label: 'MP4（兼容性最好）' },
  { value: 'mkv', label: 'MKV（多音轨/多字幕）' },
  { value: 'webm', label: 'WebM（体积更小）' },
  { value: 'mp3', label: 'MP3（仅音频）' },
  { value: 'm4a', label: 'M4A（仅音频）' },
]

export const CONCURRENCY_OPTIONS = [1, 2, 3, 5, 10] as const

/** 各分辨率的估算码率（Kbps），用于在拿不到文件大小时给出预估体积 */
const BITRATE_KBPS: Record<string, number> = {
  '2160p': 14000,
  '1440p': 8000,
  '1080p': 4500,
  '720p': 2500,
  '480p': 1200,
  '360p': 700,
  audio: 160,
}

/** 依据时长与质量估算文件大小（字节）；时长未知返回 null */
export function estimateBytes(quality: string, durationSec: number | null | undefined): number | null {
  if (!durationSec || durationSec <= 0) return null
  const kbps = BITRATE_KBPS[quality] ?? BITRATE_KBPS['1080p']
  return Math.round((kbps * 1000 * durationSec) / 8)
}

export function qualityLabel(value: string): string {
  return QUALITY_OPTIONS.find((q) => q.value === value)?.label ?? value
}

export function qualityHeight(value: string): number {
  if (value === 'audio') return 0
  const matched = QUALITY_OPTIONS.find((q) => q.value === value)
  if (matched) return matched.height
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 1080
}

/**
 * 从各种分辨率写法里解析出「高度」：
 *   "1920x1080" → 1080（注意：yt-dlp 同时知道宽高时给的就是这种 WxH，取第一个数字会得到宽度 1920，
 *                       那样会和 1080P/720P 等选项全都对不上，下拉框里就只剩「仅音频」）
 *   "1080x1920" → 1080（竖屏取短边，和平台叫法一致）
 *   "1080p60" / "1080P" / "1080" → 1080
 *   "audio" / "audio only" → 0
 */
export function parseResolutionHeight(resolution: string): number {
  const lower = (resolution || '').toLowerCase().trim()
  if (!lower || lower.includes('audio')) return 0

  // WxH：宽在前、高在后（yt-dlp 的 format_resolution 就是 '%dx%d'）。
  // 这里取**短边**：横屏 "1920x1080" → 1080；竖屏 "1080x1920" → 1080。
  // （平台也都这么标：1080p 指短边 1080。取宽度或取高度都会在竖屏上出错。）
  const wxh = lower.match(/(\d{2,5})\s*[x×*]\s*(\d{2,5})/)
  if (wxh) return Math.min(Number.parseInt(wxh[1], 10), Number.parseInt(wxh[2], 10))

  // "1080p" / "1080p60" / "1080" / "720P60"
  const p = lower.match(/(\d{3,4})\s*p/)
  if (p) return Number.parseInt(p[1], 10)

  // 只有一个数字：按高度处理（yt-dlp 单独给高度时是 "1080p"，这里兜底）
  const any = lower.match(/(\d{3,4})/)
  return any ? Number.parseInt(any[1], 10) : 0
}

/** 按质量+格式挑选最合适的 yt-dlp format id */
export function pickFormatId(
  formats: FormatOption[],
  quality: string,
  format: string,
  fallback?: string | null,
): string | null {
  if (!formats.length) return fallback ?? null
  const wantAudio = quality === 'audio'
  const targetHeight = qualityHeight(quality)
  const wantExt = format.toLowerCase()

  const scored = formats
    .map((option) => {
      const height = parseResolutionHeight(option.resolution)
      const ext = (option.ext || '').toLowerCase()
      let score = 0
      if (wantAudio) {
        score += height === 0 ? 100 : -100
      } else {
        score += height === targetHeight ? 100 : -Math.abs(height - targetHeight)
      }
      if (ext === wantExt) score += 40
      else if (wantExt === 'mp4' && (ext === 'm4v' || ext === 'mov')) score += 20
      if (option.vcodec && option.vcodec !== 'none') score += 5
      if (option.acodec && option.acodec !== 'none') score += 5
      return { option, score }
    })
    .sort((a, b) => b.score - a.score)

  return scored[0]?.option.id ?? fallback ?? null
}

/** 合并 formats 中的容器类型（用于格式下拉兜底） */
export function availableExts(formats: FormatOption[]): string[] {
  const set = new Set<string>()
  for (const item of formats) {
    if (item.ext) set.add(item.ext.toLowerCase())
  }
  return Array.from(set)
}

export const MODULE_TABS: { value: ModuleId | ''; label: string }[] = [
  { value: '', label: '全部模块' },
  { value: 'webvideo', label: '公开视频' },
  { value: 'aria2', label: 'URL 直链' },
  { value: 'transmission', label: 'BT 种子' },
]

export const TASK_SORT_OPTIONS = [
  { value: 'created_desc', label: '创建时间（新→旧）' },
  { value: 'created_asc', label: '创建时间（旧→新）' },
  { value: 'progress_desc', label: '进度（高→低）' },
  { value: 'size_desc', label: '体积（大→小）' },
]

export const HISTORY_STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
]

/** 平台徽标配色（按名称稳定映射一组克制的颜色） */
export function platformTone(platform: string | null | undefined): string {
  const key = (platform ?? '').toLowerCase()
  if (key.includes('youtube')) return 'bg-red-500/10 text-red-600 dark:text-red-400'
  if (key.includes('bilibili')) return 'bg-sky-500/10 text-sky-600 dark:text-sky-400'
  if (key.includes('vimeo')) return 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400'
  if (key.includes('tiktok') || key.includes('抖音')) {
    return 'bg-slate-900/10 text-slate-700 dark:bg-white/10 dark:text-slate-200'
  }
  if (key.includes('instagram')) return 'bg-pink-500/10 text-pink-600 dark:text-pink-400'
  if (key === 'x' || key.includes('twitter')) {
    return 'bg-slate-500/10 text-slate-700 dark:text-slate-300'
  }
  if (key.includes('bt')) return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (key.includes('aria') || key.includes('url')) {
    return 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
  }
  return 'bg-slate-500/10 text-slate-600 dark:text-slate-300'
}

export const STORAGE_KEYS = {
  theme: 'ttd-theme',
  pageSize: 'ttd-page-size',
  /** 维护令牌（修复脚本写操作使用），仅在用户勾选「记住在本机」时写入 */
  maintToken: 'ttd-maint-token',
} as const
