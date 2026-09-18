import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  Layers,
  Loader2,
  Rocket,
  ShieldCheck,
  Zap,
} from 'lucide-react'
import { api } from '../lib/api'
import { FALLBACK_PLATFORMS } from '../lib/constants'
import { formatBytes, humanizeError, statusMeta } from '../lib/format'
import { useAppData } from '../context/AppDataContext'
import { useToast } from '../context/ToastContext'
import { Badge, Button, Card, CardHeader, EmptyState, StatCard, Thumbnail } from '../components/ui'
import { UrlInput } from '../components/video/UrlInput'
import { resetParse, setParseUrl, startParse, useParseState } from '../lib/parseStore'
import { VideoPreviewCard } from '../components/video/VideoPreviewCard'

export default function HomePage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { stats, system, refreshStats } = useAppData()

  // 「解析视频」的状态放在组件外（parseStore）：切到别的页面再回来，地址/结果/进度都还在。
  // 以前是 useState，卸载就丢 —— 用户切去看一眼「任务」再回来，解析结果就没了。
  const { url, parsing, result, error: parseError, startedAt } = useParseState()
  const [adding, setAdding] = useState(false)
  const [platforms, setPlatforms] = useState<string[]>(FALLBACK_PLATFORMS)
  const [now, setNow] = useState(() => Date.now())

  // 解析中时每秒刷新一次"已等待 N 秒"，让用户知道它没卡死
  useEffect(() => {
    if (!parsing) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [parsing])

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
      try {
        const data = await startParse(target)
        if (!data) return
        if (data.degraded) {
          toast.warning('解析失败', data.parseError ?? '没拿到可用格式，直接下载多半会失败')
        } else {
          toast.success('解析成功', data.title)
        }
      } catch (err) {
        const message = humanizeError((err as { code?: string }).code ?? '', (err as Error).message)
        toast.error('解析失败', message)
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
        resetParse()
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

      {/* 解析中且切回来时，明确告诉用户它还在跑（不是卡死） */}
      {parsing && startedAt ? (
        <div className="mx-auto flex max-w-2xl items-center justify-center gap-2 rounded-xl bg-brand-50 px-3 py-2 text-xs text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>
            正在解析，已等待 {Math.max(0, Math.round((now - startedAt) / 1000))} 秒 ——
            你可以先去别的页面，解析不会中断，回来自动显示结果
          </span>
        </div>
      ) : null}

      {/* URL 输入区 */}
      <UrlInput
        value={url}
        onChange={setParseUrl}
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
          hint={`下载任务 ${stats?.downloadTasks ?? 0}${stats?.publishTasks ? ` · 发布 ${stats.publishTasks}` : ''}`}
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
                可用于下载 {system ? formatBytes(system.disk.usableBytes, '未知') : '—'}
                —— 这是项目能拿去下资源的空间；<b>操作系统实际可用</b>{' '}
                {system ? formatBytes(system.disk.freeBytes, '未知') : '—'} ＝ 可用于下载{' '}
                {system ? formatBytes(system.disk.usableBytes, '未知') : '—'} ＋ 预留{' '}
                {system ? formatBytes(system.disk.reserveBytes, '0 B') : '—'}（预留是加密/归档/发布的周转空间，
                不能省：空间用尽时加密、归档就没法操作了），不够时新任务自动排队等回血。
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
