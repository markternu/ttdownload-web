import { useMemo, useState } from 'react'
import { AlertCircle, Clock, Download, HardDrive, Sparkles, User } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatBytes, formatDuration } from '../../lib/format'
import {
  FORMAT_OPTIONS,
  QUALITY_OPTIONS,
  estimateBytes,
  parseResolutionHeight,
  platformTone,
} from '../../lib/constants'
import type { FormatOption, ParseResult } from '../../types'
import { Badge, Button, Card, Select, Thumbnail } from '../ui'

export interface VideoPreviewCardProps {
  result: ParseResult
  onAdd: (payload: { formatId: string | null; quality: string; format: string }) => void
  adding?: boolean
}

interface QualityChoice {
  value: string
  label: string
}

/** 由解析结果的 formats 推导可选质量（保留契约里的 resolution 字符串） */
function qualityChoices(formats: FormatOption[]): QualityChoice[] {
  const heights = new Set<number>()
  let hasAudio = false
  for (const format of formats) {
    const height = parseResolutionHeight(format.resolution)
    if (height === 0) hasAudio = true
    else heights.add(height)
  }

  const standard: QualityChoice[] = QUALITY_OPTIONS.filter((option) => {
    if (option.value === 'audio') return hasAudio
    return heights.size === 0 || heights.has(option.height)
  }).map((option) => ({ value: option.value, label: option.label }))

  if (standard.length) return standard

  // formats 里出现了非标准分辨率时，按实际值降级展示
  const sorted = Array.from(heights).sort((a, b) => b - a)
  const custom: QualityChoice[] = sorted.map((height) => ({
    value: `${height}p`,
    label: `${height}P`,
  }))
  if (hasAudio) custom.push({ value: 'audio', label: '仅音频' })
  return custom.length ? custom : QUALITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))
}

function formatChoices(formats: FormatOption[]): { value: string; label: string }[] {
  const exts = new Set(formats.map((format) => (format.ext || '').toLowerCase()).filter(Boolean))
  const standard = FORMAT_OPTIONS.filter((option) => exts.has(option.value))
  if (standard.length) return standard
  const dynamic = Array.from(exts).map((ext) => ({ value: ext, label: ext.toUpperCase() }))
  return dynamic.length ? dynamic : FORMAT_OPTIONS
}

function pickDefaultQuality(formats: FormatOption[], preferred: string): string {
  const choices = qualityChoices(formats)
  if (choices.some((choice) => choice.value === preferred)) return preferred
  return choices[0]?.value ?? '1080p'
}

function pickDefaultFormat(formats: FormatOption[], preferred: string): string {
  const choices = formatChoices(formats)
  if (choices.some((choice) => choice.value === preferred)) return preferred
  return choices[0]?.value ?? 'mp4'
}

function matchFormat(
  formats: FormatOption[],
  quality: string,
  format: string,
): FormatOption | undefined {
  const wantAudio = quality === 'audio'
  const wantHeight = Number.parseInt(quality, 10)
  const wantExt = format.toLowerCase()
  const scored = formats
    .map((option) => {
      const height = parseResolutionHeight(option.resolution)
      let score = 0
      if (wantAudio) score += height === 0 ? 100 : -100
      else if (Number.isFinite(wantHeight)) score += height === wantHeight ? 100 : -Math.abs(height - wantHeight)
      if ((option.ext || '').toLowerCase() === wantExt) score += 30
      return { option, score }
    })
    .sort((a, b) => b.score - a.score)
  return scored[0]?.score && scored[0].score > 0 ? scored[0].option : undefined
}

/** 视频预览卡片：标题 / 缩略图 / 平台 / 时长 / 作者 / 分辨率 / 格式 / 体积 + 质量选择 */
export function VideoPreviewCard({ result, onAdd, adding = false }: VideoPreviewCardProps) {
  const [quality, setQuality] = useState(() => pickDefaultQuality(result.formats ?? [], '1080p'))
  const [format, setFormat] = useState(() => pickDefaultFormat(result.formats ?? [], 'mp4'))

  const formats = useMemo(() => result.formats ?? [], [result.formats])
  const qualityOptions = useMemo(() => qualityChoices(formats), [formats])
  const formatOptions = useMemo(() => formatChoices(formats), [formats])

  const selected = useMemo(
    () => matchFormat(formats, quality, format),
    [formats, quality, format],
  )

  const estimated = useMemo(() => {
    const actual = selected?.filesize ?? result.expectedBytes ?? 0
    if (actual && actual > 0) return actual
    return estimateBytes(quality, result.durationSec) ?? 0
  }, [selected, result.expectedBytes, result.durationSec, quality])

  const estimatedIsGuess = !(selected?.filesize && selected.filesize > 0) && !(result.expectedBytes > 0)

  return (
    <Card className="animate-slide-up overflow-hidden">
      <div className="flex flex-col gap-4 sm:flex-row">
        <Thumbnail
          src={result.thumbnail}
          alt={result.title}
          className="w-full sm:w-64"
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium',
                platformTone(result.platform),
              )}
            >
              {result.platform || '未知平台'}
            </span>
            <Badge tone="success" dot>
              解析成功
            </Badge>
          </div>

          <h2 className="mt-2 line-clamp-2 text-lg font-semibold text-slate-900 dark:text-slate-50">
            {result.title || '未命名视频'}
          </h2>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-500 dark:text-slate-400">
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              {formatDuration(result.durationSec)}
            </span>
            <span className="inline-flex items-center gap-1">
              <User className="h-3.5 w-3.5" />
              {result.author || '未知作者'}
            </span>
            <span className="inline-flex items-center gap-1">
              <HardDrive className="h-3.5 w-3.5" />
              {formatBytes(estimated, '未知')}
              {estimatedIsGuess && estimated > 0 ? (
                <span className="text-slate-400">（估算）</span>
              ) : null}
            </span>
            <span className="inline-flex items-center gap-1">
              <Sparkles className="h-3.5 w-3.5" />
              {formats.length} 个可选格式
            </span>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select
              label="视频质量"
              value={quality}
              options={qualityOptions}
              onChange={(event) => setQuality(event.target.value)}
            />
            <Select
              label="文件格式"
              value={format}
              options={formatOptions}
              onChange={(event) => setFormat(event.target.value)}
            />
          </div>

          <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            <p className="font-medium">
              将下载：
              <span className="ml-1 font-mono">
                {quality.toUpperCase()} · {format.toUpperCase()} · {formatBytes(estimated, '未知')}
              </span>
            </p>
            {selected?.vcodec || selected?.acodec ? (
              <p className="mt-1 truncate text-[11px] text-slate-400">
                编码：{selected?.vcodec ?? '-'} / {selected?.acodec ?? '-'}
              </p>
            ) : null}
            <p className="mt-1 text-[11px] text-slate-400">
              保存位置由「设置 → 默认保存目录」统一管理，加入队列后可在任务页查看实际路径。
            </p>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              size="lg"
              loading={adding}
              icon={<Download className="h-4 w-4" />}
              onClick={() => onAdd({ formatId: selected?.id ?? null, quality, format })}
            >
              加入下载队列
            </Button>
            <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
              <AlertCircle className="h-3 w-3" />
              请确认你拥有该视频的下载权限
            </span>
          </div>
        </div>
      </div>
    </Card>
  )
}
