import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  Layers,
  Loader2,
  MinusCircle,
  Network,
  RefreshCw,
  Rocket,
  ShieldCheck,
  XCircle,
  Zap,
} from 'lucide-react'
import { api } from '../lib/api'
import { FALLBACK_PLATFORMS } from '../lib/constants'
import { cn } from '../lib/cn'
import { formatBytes, formatDateTime, humanizeError, statusMeta } from '../lib/format'
import { useAppData } from '../context/AppDataContext'
import { useToast } from '../context/ToastContext'
import type { CheckStatus, NetworkCheck, NetworkReport, ParseResult } from '../types'
import { Badge, Button, Card, CardHeader, EmptyState, StatCard, Thumbnail } from '../components/ui'
import { UrlInput, validateUrl } from '../components/video/UrlInput'
import { VideoPreviewCard } from '../components/video/VideoPreviewCard'

/** 网络自检分组顺序与中文标题 */
const NETWORK_GROUPS: { key: NetworkCheck['group']; title: string }[] = [
  { key: 'net', title: '基础网络' },
  { key: 'ytdlp', title: 'yt-dlp / YouTube' },
  { key: 'local', title: '本机下载服务' },
]

/** 总体结论 → 徽章 */
const NETWORK_OVERALL: Record<
  NetworkReport['overall'],
  { tone: 'success' | 'warning' | 'danger'; label: string }
> = {
  ok: { tone: 'success', label: '网络正常' },
  partial: { tone: 'warning', label: '部分可用' },
  fail: { tone: 'danger', label: '网络异常' },
}

function NetworkStatusIcon({ status }: { status: CheckStatus }) {
  if (status === 'ok') return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
  if (status === 'fail') return <XCircle className="h-4 w-4 shrink-0 text-red-500" />
  if (status === 'running') return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-400" />
  return <MinusCircle className="h-4 w-4 shrink-0 text-slate-400" />
}

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

  // 网络自检（不阻塞首屏渲染，失败只显示一行红字）
  const [network, setNetwork] = useState<NetworkReport | null>(null)
  const [networkError, setNetworkError] = useState<string | null>(null)
  const [networkLoading, setNetworkLoading] = useState(true)
  const [networkRefreshing, setNetworkRefreshing] = useState(false)

  const loadNetwork = useCallback(async (refresh = false) => {
    if (refresh) setNetworkRefreshing(true)
    try {
      const report = await api.networkCheck(refresh)
      setNetwork(report)
      setNetworkError(null)
    } catch (err) {
      setNetworkError(
        humanizeError((err as { code?: string }).code ?? '', (err as Error).message),
      )
    } finally {
      setNetworkLoading(false)
      if (refresh) setNetworkRefreshing(false)
    }
  }, [])

  // 首次进入使用服务端缓存，避免每次打开首页都打满一整轮出网测试
  useEffect(() => {
    void loadNetwork(false)
  }, [loadNetwork])

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
        if (data.degraded) {
          toast.warning('解析受限，仍可下载', data.parseError ?? '下载时会自动尝试多种方式')
        } else {
          toast.success('解析成功', data.title)
        }
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
  const proxyEnvEntries = Object.entries(network?.proxy.env ?? {})
  const proxyExtraArgs = network?.proxy.extraArgs?.trim() ?? ''

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

      {/* 网络自检（URL 输入区之后、解析结果之前，首屏可见） */}
      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <Network className="h-4 w-4" /> 网络自检
            </span>
          }
          subtitle="在线视频下载能不能用，先看这里（服务端实际出网测试）"
          action={
            <Button
              variant="outline"
              size="sm"
              loading={networkRefreshing}
              onClick={() => void loadNetwork(true)}
              icon={
                <RefreshCw className={cn('h-3.5 w-3.5', networkRefreshing && 'animate-spin')} />
              }
            >
              {networkRefreshing ? '检测中…' : '重新检测'}
            </Button>
          }
        />

        {networkError ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
            <span className="flex min-w-0 items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="break-words">网络自检请求失败：{networkError}</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              loading={networkRefreshing}
              onClick={() => void loadNetwork(true)}
            >
              重新检测
            </Button>
          </div>
        ) : null}

        {networkLoading && !network && !networkError ? (
          <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            正在检测网络…（不影响页面其它功能）
          </p>
        ) : null}

        {network ? (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <Badge
                tone={NETWORK_OVERALL[network.overall].tone}
                dot
                pulse={network.overall !== 'ok'}
              >
                {NETWORK_OVERALL[network.overall].label}
              </Badge>
              <span className="min-w-0 flex-1 text-xs break-words text-slate-600 dark:text-slate-300">
                {network.summary}
              </span>
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">
              检测时间 {formatDateTime(network.checkedAt)}
              {network.cached ? ' · 服务端缓存结果（点「重新检测」强制刷新）' : ''}
            </p>

            <div className="mt-4 space-y-4">
              {NETWORK_GROUPS.map((group) => {
                const checks = network.checks.filter((check) => check.group === group.key)
                if (!checks.length) return null
                return (
                  <div key={group.key}>
                    <p className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
                      {group.title}
                    </p>
                    <ul className="space-y-2">
                      {checks.map((check) => (
                        <li
                          key={check.id}
                          className="rounded-xl border border-slate-100 px-3 py-2 dark:border-slate-800"
                        >
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <NetworkStatusIcon status={check.status} />
                            <span
                              className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 dark:text-slate-100"
                              title={check.label}
                            >
                              {check.label}
                            </span>
                            {typeof check.latencyMs === 'number' ? (
                              <span className="shrink-0 font-mono text-[11px] text-slate-400 tabular-nums">
                                {check.latencyMs} ms
                              </span>
                            ) : null}
                          </div>
                          <p
                            className={cn(
                              'mt-1 text-xs',
                              check.status === 'fail'
                                ? 'break-words text-red-600 dark:text-red-400'
                                : 'line-clamp-2 text-slate-500 dark:text-slate-400',
                            )}
                            title={check.detail}
                          >
                            {check.detail}
                          </p>
                          {check.status === 'fail' && check.hint ? (
                            <p className="mt-1 text-xs break-words text-amber-600 dark:text-amber-400">
                              建议：{check.hint}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
            </div>

            {proxyEnvEntries.length || proxyExtraArgs ? (
              <div className="mt-4 space-y-1.5 border-t border-slate-100 pt-3 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
                {proxyEnvEntries.length ? (
                  <div>
                    <p className="font-medium text-slate-600 dark:text-slate-300">代理环境变量</p>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1">
                      {proxyEnvEntries.map(([key, value]) => (
                        <code key={key} className="font-mono break-all">
                          {key}={value}
                        </code>
                      ))}
                    </div>
                  </div>
                ) : null}
                {proxyExtraArgs ? (
                  <p className="break-all">
                    yt-dlp 额外参数：<code className="font-mono">{proxyExtraArgs}</code>
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </Card>

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
