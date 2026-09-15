import { useMemo, useState } from 'react'
import { AlertCircle, Clock, Download, HardDrive, Sparkles, User } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatBytes, formatDuration } from '../../lib/format'
import { estimateBytes, parseResolutionHeight, platformTone } from '../../lib/constants'
import {
  formatChoices,
  pickDefaultFormat,
  pickDefaultQuality,
  qualityChoices,
} from '../../lib/quality'
import type { FormatOption, ParseResult } from '../../types'
import { Badge, Button, Card, Select, Thumbnail } from '../ui'

export interface VideoPreviewCardProps {
  result: ParseResult
  onAdd: (payload: { formatId: string | null; quality: string; format: string }) => void
  adding?: boolean
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
            {result.degraded ? (
              <Badge tone="danger" dot>
                解析失败
              </Badge>
            ) : (
              <Badge tone="success" dot>
                解析成功
              </Badge>
            )}
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
            {result.degraded ? (
              <div className="mb-2 rounded-lg border border-red-300/70 bg-red-50 px-2.5 py-2 text-[11px] text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
                <p className="font-medium">解析失败：没拿到任何可用格式，直接下载多半也会失败</p>
                <p className="mt-1 leading-relaxed">{result.parseError || '未能获取视频详情（可能需要登录/会员权限）'}</p>
                <p className="mt-1 leading-relaxed text-red-700 dark:text-red-300">
                  请先按上面这句话处理（例如换出口 IP，或在「设置 → 公开视频（yt-dlp）」上传**已登录**的
                  cookies.txt），处理完重新解析一次；解析成功（绿色「解析成功」）后再加入队列。
                </p>
              </div>
            ) : null}
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
              {result.degraded ? '仍要尝试下载（多半失败）' : '加入下载队列'}
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
