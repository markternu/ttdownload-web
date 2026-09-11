import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  Layers,
  Rocket,
  ShieldCheck,
  Zap,
} from 'lucide-react'
import { api } from '../lib/api'
import { FALLBACK_PLATFORMS } from '../lib/constants'
import { formatBytes, humanizeError, statusMeta } from '../lib/format'
import { useAppData } from '../context/AppDataContext'
import { useToast } from '../context/ToastContext'
import type { ParseResult } from '../types'
import { Badge, Button, Card, CardHeader, EmptyState, StatCard, Thumbnail } from '../components/ui'
import { UrlInput, validateUrl } from '../components/video/UrlInput'
import { VideoPreviewCard } from '../components/video/VideoPreviewCard'

export default function HomePage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { stats, system, refreshStats } = useAppData()

  const [url, setUrl] = useState('')
  const [parsing, setParsing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [result, setResult] = useState<ParseResult | null>(null)
  const [platforms, setPlatforms] = useState<string[]>(FALLBACK_PLATFORMS)

  // 支持的平台清单来自后端，失败时使用兜底清单
  useEffect(() => {
    let cancelled = false
    api
      .webvideoPlatforms()
      .then((items) => {
        if (!cancelled && items.length) setPlatforms(items)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const handleParse = useCallback(
    async (target: string) => {
      const check = validateUrl(target)
      if (!check.ok) {
        setParseError(check.message)
        return
      }
      setParsing(true)
      setParseError(null)
      setResult(null)
      try {
        const data = await api.webvideoParse(check.url)
        setResult(data)
        toast.success('解析成功', data.title)
      } catch (err) {
        const code = (err as { code?: string }).code ?? ''
        const message = humanizeError(code, (err as Error).message)
        setParseError(message)
        toast.error('解析失败', message)
      } finally {
        setParsing(false)
      }
    },
    [toast],
  )

  const handleAdd = useCallback(
    async ({
      formatId,
      quality,
      format,
    }: {
      formatId: string | null
      quality: string
      format: string
    }) => {
      if (!result) return
      setAdding(true)
      try {
        const res = await api.webvideoCreateTask({
          url: url.trim(),
          formatId: formatId ?? undefined,
          quality,
          title: result.title,
        })
        toast.success('已加入下载队列', `${result.title} · ${quality.toUpperCase()} · ${format.toUpperCase()}`)
        setResult(null)
        setUrl('')
        void refreshStats()
        if (res?.task?.id) navigate('/tasks')
      } catch (err) {
        const code = (err as { code?: string }).code ?? ''
        toast.error('加入队列失败', humanizeError(code, (err as Error).message))
      } finally {
        setAdding(false)
      }
    },
    [navigate, refreshStats, result, toast, url],
  )

  const recent = stats?.recentTasks?.slice(0, 5) ?? []

  return (
    <div className="space-y-6">
      {/* Hero */}
      <section className="text-center">
        <Badge tone="brand" className="mb-3">
          <Zap className="h-3 w-3" /> 支持 YouTube / Bilibili / Vimeo / X / TikTok / Instagram / 抖音
        </Badge>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-4xl dark:text-slate-50">
          在线视频下载管理器
        </h1>
        <p className="mx-auto mt-2 max-w-2xl text-sm text-slate-500 sm:text-base dark:text-slate-400">
          统一管理你的在线视频下载任务
        </p>
      </section>

      {/* URL 输入区 */}
      <UrlInput
        value={url}
        onChange={setUrl}
        onParse={(target) => void handleParse(target)}
        loading={parsing}
        error={parseError}
      />

      {/* 解析结果 */}
      {result ? (
        <VideoPreviewCard result={result} adding={adding} onAdd={(payload) => void handleAdd(payload)} />
      ) : null}

      {/* 概览统计 */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="下载中"
          value={stats?.downloading ?? 0}
          hint={`等待中 ${stats?.waiting ?? 0}`}
          tone="brand"
          icon={<Download className="h-4 w-4" />}
        />
        <StatCard
          label="今日任务"
          value={stats?.todayTasks ?? 0}
          hint={`今日完成 ${stats?.todayCompleted ?? 0}`}
          tone="success"
          icon={<CheckCircle2 className="h-4 w-4" />}
        />
        <StatCard
          label="失败任务"
          value={stats?.failed ?? 0}
          hint={stats?.failed ? '可在任务页重试' : '暂无异常'}
          tone={stats?.failed ? 'danger' : 'neutral'}
          icon={<AlertTriangle className="h-4 w-4" />}
        />
        <StatCard
          label="累计下载"
          value={formatBytes(stats?.totalDownloadedBytes ?? 0, '0 B')}
          hint={`任务总数 ${stats?.totalTasks ?? 0}`}
          tone="neutral"
          icon={<Layers className="h-4 w-4" />}
        />
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* 最近任务 */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="最近下载任务"
            subtitle="新任务会实时出现在这里"
            action={
              <Button variant="ghost" size="sm" onClick={() => navigate('/tasks')}>
                查看全部 <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            }
          />
          {recent.length ? (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {recent.map((task) => {
                const meta = statusMeta(task.status)
                return (
                  <li key={task.id} className="flex items-center gap-3 py-3">
                    <Thumbnail src={task.meta?.thumbnail} alt={task.title} className="w-16" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                        {task.title}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-slate-400">
                        {task.platform ?? '未知平台'} · {formatBytes(task.totalBytes || task.expectBytes, '未知')}
                        {task.progress > 0 ? ` · ${Math.round(task.progress)}%` : ''}
                      </p>
                    </div>
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                  </li>
                )
              })}
            </ul>
          ) : (
            <EmptyState
              title="还没有下载任务"
              description="在上方粘贴视频链接并点击「解析视频」，即可把任务加入统一下载队列。"
              icon={<Rocket className="h-5 w-5" />}
            />
          )}
        </Card>

        {/* 能力说明 + 支持平台 */}
        <Card>
          <CardHeader title="下载能力" subtitle="统一等待队列 + 磁盘空间门控" />
          <ul className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
            <li className="flex gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              <span>仅处理公开视频，不实现 DRM 破解，不绕过付费墙与登录限制。</span>
            </li>
            <li className="flex gap-2">
              <Layers className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
              <span>
                最大并发 {system ? '可在设置中调整' : '默认 3'}，超出并发的任务自动进入等待队列。
              </span>
            </li>
            <li className="flex gap-2">
              <Download className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
              <span>
                磁盘可用 {system ? formatBytes(system.disk.freeBytes, '未知') : '—'}，低于预留阈值时自动暂停。
              </span>
            </li>
          </ul>

          <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800">
            <p className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">支持的平台</p>
            <div className="flex flex-wrap gap-1.5">
              {platforms.map((platform) => (
                <Badge key={platform} tone="neutral">
                  {platform}
                </Badge>
              ))}
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
