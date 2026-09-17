import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, MinusCircle, RefreshCw, XCircle } from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatDateTime, humanizeError } from '../lib/format'
import { Badge, Button, Card } from '../components/ui'
import type { CheckStatus, NetworkCheck, NetworkReport } from '../types'

/**
 * 网络自检（原来内联在首页，用户要求提级成与「首页/任务/历史」平级的独立页面）。
 *
 * 检查由**服务端**实际出网执行（DNS / HTTPS / YouTube / yt-dlp / 视频 CDN / 本机 RPC），
 * 用来先分清"网络不通"还是"下载工具的问题"。
 */

/** 分组顺序与中文标题 */
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

export default function NetworkPage() {
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
      setNetworkError(humanizeError((err as { code?: string }).code ?? '', (err as Error).message))
    } finally {
      setNetworkLoading(false)
      if (refresh) setNetworkRefreshing(false)
    }
  }, [])

  // 首次进入用服务端缓存，避免每次打开都打满一整轮出网测试
  useEffect(() => {
    void loadNetwork(false)
  }, [loadNetwork])

  const proxyEnvEntries = Object.entries(network?.proxy.env ?? {})
  const proxyExtraArgs = network?.proxy.extraArgs?.trim() ?? ''

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">网络自检</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            服务端实际出网测试：先分清是「网络不通」还是「下载工具的问题」
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          loading={networkRefreshing}
          onClick={() => void loadNetwork(true)}
          icon={<RefreshCw className={cn('h-3.5 w-3.5', networkRefreshing && 'animate-spin')} />}
        >
          {networkRefreshing ? '检测中…' : '重新检测'}
        </Button>
      </div>

      <Card>
        {networkError ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
            <span className="flex min-w-0 items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="break-words">网络自检请求失败：{networkError}</span>
            </span>
            <Button variant="ghost" size="sm" loading={networkRefreshing} onClick={() => void loadNetwork(true)}>
              重新检测
            </Button>
          </div>
        ) : null}

        {networkLoading && !network && !networkError ? (
          <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            正在检测网络…
          </p>
        ) : null}

        {network ? (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <Badge tone={NETWORK_OVERALL[network.overall].tone} dot pulse={network.overall !== 'ok'}>
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
                    <p className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">{group.title}</p>
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
    </div>
  )
}
