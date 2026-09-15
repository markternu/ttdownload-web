import { FORMAT_OPTIONS, QUALITY_OPTIONS, parseResolutionHeight } from './constants'
import type { FormatOption } from '../types'

/**
 * 由解析结果的 formats 推导「可选质量」。
 *
 * 这里正是用户踩到的坑所在：yt-dlp 的 resolution 在知道宽高时是 "1920x1080"，
 * 若按第一个数字当高度（1920），就会和 1080P/720P 等标准选项全部对不上，
 * 于是下拉框里只剩「仅音频」——看起来像「视频没有画面」。所以高度解析
 * 统一走 parseResolutionHeight（它认识 WxH / 1080p / 1080 三种写法）。
 */
export interface QualityChoice {
  value: string
  label: string
}

export function qualityChoices(formats: FormatOption[]): QualityChoice[] {
  const heights = new Set<number>()
  let hasAudio = false
  for (const format of formats) {
    const height = parseResolutionHeight(format.resolution)
    if (height === 0) hasAudio = true
    else heights.add(height)
  }

  // 只列出**真的存在**的分辨率；标准档位用它的中文标签，非标准的按实际高度显示。
  // 注意：不能因为「有音频」就把 2160P/1080P 全列出来 —— 纯音频视频（播客/音乐）只有
  // 一个「仅音频」可选才是对的。
  const choices: QualityChoice[] = [...heights]
    .sort((a, b) => b - a)
    .map((height) => {
      const standard = QUALITY_OPTIONS.find((option) => option.height === height)
      return standard ? { value: standard.value, label: standard.label } : { value: `${height}p`, label: `${height}P` }
    })

  if (hasAudio) choices.push({ value: 'audio', label: '仅音频' })

  // 兜底：完全拿不到分辨率信息时，给全套标准选项，避免下拉框是空的
  return choices.length ? choices : QUALITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))
}

export function formatChoices(formats: FormatOption[]): { value: string; label: string }[] {
  const exts = new Set(formats.map((format) => (format.ext || '').toLowerCase()).filter(Boolean))
  const standard = FORMAT_OPTIONS.filter((option) => exts.has(option.value))
  if (standard.length) return standard
  const dynamic = Array.from(exts).map((ext) => ({ value: ext, label: ext.toUpperCase() }))
  return dynamic.length ? dynamic : FORMAT_OPTIONS
}

export function pickDefaultQuality(formats: FormatOption[], preferred: string): string {
  const choices = qualityChoices(formats)
  if (choices.some((choice) => choice.value === preferred)) return preferred
  return choices[0]?.value ?? '1080p'
}

export function pickDefaultFormat(formats: FormatOption[], preferred: string): string {
  const choices = formatChoices(formats)
  if (choices.some((choice) => choice.value === preferred)) return preferred
  return choices[0]?.value ?? 'mp4'
}
