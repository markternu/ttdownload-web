import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  Info,
  LifeBuoy,
  RefreshCw,
  Send,
  ShieldCheck,
} from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorState,
  Input,
  Select,
  Skeleton,
  Switch,
} from '../components/ui'
import type { BadgeTone } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { api, MODULE_LABELS } from '../lib/api'
import { cn } from '../lib/cn'
import { formatBytes, formatDateTime, humanizeError } from '../lib/format'
import type { ReportListItem, ReportListResponse, Task } from '../types'

/** 日志级别下拉（all = 不过滤） */
const LEVEL_OPTIONS = [
  { value: 'warn', label: 'warn — 警告及以上（推荐）' },
  { value: 'error', label: 'error — 仅错误' },
  { value: 'info', label: 'info — 常规信息' },
  { value: 'debug', label: 'debug — 调试' },
  { value: 'trace', label: 'trace — 最详细' },
  { value: 'all', label: 'all — 全部级别' },
]

/** 报告类型 → Badge 色调 */
const KIND_TONES: Record<ReportListItem['kind'], BadgeTone> = {
  zip: 'brand',
  json: 'info',
  log: 'neutral',
  csv: 'success',
}

/** 导出行数输入兜底值 */
const DEFAULT_LINES = 5000

/** tasksSummary 未强类型：安全地尝试取出「失败任务数」，取不到返回 null */
function summaryFailedCount(summary: unknown): number | null {
  if (!summary || typeof summary !== 'object') return null
  const record = summary as Record<string, unknown>
  const value = record.failed ?? record.failedTasks ?? record.failedCount
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 页面内展示的下载动作：新窗口打开附件地址并提示 */
function openAttachment(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

export default function ReportPage() {
  const toast = useToast()

  const [data, setData] = useState<ReportListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 「下载后清空已有日志」开关（服务端持久化设置，切换即保存）
  const [clearSaving, setClearSaving] = useState(false)

  // 「只导出报错」表单
  const [level, setLevel] = useState('warn')
  const [lines, setLines] = useState(String(DEFAULT_LINES))
  const [marker, setMarker] = useState('')
  const [q, setQ] = useState('')

  // 最近失败任务
  const [failed, setFailed] = useState<Task[] | null>(null)
  const [failedLoading, setFailedLoading] = useState(true)
  const [failedError, setFailedError] = useState<string | null>(null)

  const loadReport = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.reportList()
      setData(res)
      setError(null)
    } catch (err) {
      const message = humanizeError((err as { code?: string }).code ?? '', (err as Error).message)
      setError(message)
      toast.error('诊断信息读取失败', message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  const loadFailed = useCallback(async () => {
    setFailedLoading(true)
    try {
      const res = await api.failedTasks(10)
      setFailed(res.items ?? [])
      setFailedError(null)
    } catch (err) {
      const message = humanizeError((err as { code?: string }).code ?? '', (err as Error).message)
      setFailedError(message)
      toast.error('失败任务读取失败', message)
    } finally {
      setFailedLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void loadReport()
  }, [loadReport])

  useEffect(() => {
    void loadFailed()
  }, [loadFailed])

  /** 主报告下载：zip（或退化 json）。开启「下载后清空已有日志」时后端会先出报告再清空日志 */
  const handleReportDownload = () => {
    openAttachment(api.reportUrl())
    if (clearLogsAfterReport) {
      toast.success('已开始下载诊断报告', '历史日志已按设置清空（报告里仍包含清空前的日志）')
    } else {
      toast.success('已开始下载诊断报告', '把文件发给我即可，我会帮你看问题出在哪')
    }
  }

  /** 切换「下载后清空已有日志」：先乐观更新，保存失败再回滚 */
  const handleClearLogsToggle = async (next: boolean) => {
    if (!data || clearSaving) return
    const previous = data.clearLogsAfterReport
    setClearSaving(true)
    setData({ ...data, clearLogsAfterReport: next })
    try {
      await api.updateSettings({ clearLogsAfterReport: next })
      await loadReport()
      toast.success(
        next ? '已开启：下载后清空已有日志' : '已关闭：下载后保留已有日志',
        next ? '下一轮测试的日志不会和这一轮混在一起' : '下载报告不再清空历史日志',
      )
    } catch (err) {
      const message = humanizeError((err as { code?: string }).code ?? '', (err as Error).message)
      setData((current) => (current ? { ...current, clearLogsAfterReport: previous } : current))
      toast.error('设置保存失败', message)
    } finally {
      setClearSaving(false)
    }
  }

  /** 单项报告下载 */
  const handleItemDownload = (item: ReportListItem) => {
    openAttachment(item.url)
    toast.success(`已开始下载：${item.title}`, '把文件发给我即可')
  }

  /** 历史报告下载 */
  const handleFileDownload = (name: string) => {
    openAttachment(api.reportFileUrl(name))
    toast.success('已开始下载历史报告', name)
  }

  /** 过滤日志导出 */
  const handleLogExport = () => {
    const parsed = Number.parseInt(lines, 10)
    const lineCount = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LINES
    openAttachment(
      api.logExportUrl({
        level,
        lines: lineCount,
        marker: marker.trim() || undefined,
        q: q.trim() || undefined,
      }),
    )
    toast.success('已开始导出日志', '只想看错误就用这个，文件很小')
  }

  /** 复制失败原因（浏览器不允许自动复制时提示手动选择） */
  const handleCopy = async (task: Task) => {
    const text = [
      `任务：${task.title || `#${task.id}`}`,
      `模块：${MODULE_LABELS[task.module] ?? task.module}`,
      `状态：${task.status}`,
      `链接：${task.url ?? '—'}`,
      `时间：${formatDateTime(task.finishedAt ?? task.createdAt)}`,
      `失败原因：${task.error ?? '（无）'}`,
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toast.success('已复制失败原因', '直接粘贴发给我即可')
    } catch {
      toast.error('复制失败', '浏览器不允许自动复制，请手动选中上面的文字复制')
    }
  }

  const reports = data?.reports ?? []
  const items = data?.items ?? []
  const clearLogsAfterReport = data?.clearLogsAfterReport ?? false
  const failedCount = useMemo(() => summaryFailedCount(data?.tasksSummary), [data])
  const zipReady = data?.zipAvailable ?? false

  return (
    <div className="space-y-5">
      {/* 页头 */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">问题反馈</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            遇到问题先下载诊断报告，再把文件发给我，就能更快定位原因
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          loading={loading}
          onClick={() => void loadReport()}
          icon={<RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />}
        >
          刷新
        </Button>
      </div>

      {loading && !data ? (
        <>
          <Card className="border-brand-200 dark:border-brand-500/40">
            <Skeleton className="h-6 w-52" />
            <Skeleton className="mt-3 h-4 w-full max-w-xl" />
            <Skeleton className="mt-4 h-12 w-full" />
            <Skeleton className="mt-3 h-4 w-64" />
          </Card>
          <Card>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="mt-4 h-24 w-full" />
          </Card>
        </>
      ) : error && !data ? (
        <ErrorState message={`诊断信息读取失败：${error}`} onRetry={() => void loadReport()} />
      ) : data ? (
        <>
          {/* 1. 一键下载诊断报告（最醒目） */}
          <Card className="border-brand-200 bg-gradient-to-br from-brand-50 via-white to-white dark:border-brand-500/40 dark:from-brand-500/10 dark:via-slate-900 dark:to-slate-900">
            <CardHeader
              title={
                <span className="inline-flex items-center gap-2">
                  <LifeBuoy className="h-4 w-4 text-brand-600 dark:text-brand-300" />
                  一键下载诊断报告
                </span>
              }
              subtitle="把运行环境、配置（密钥已打码）、全部日志、部署日志、错误摘要、任务失败原因、网络自检打包成一个文件"
              action={
                <Badge tone={zipReady ? 'brand' : 'warning'}>
                  {zipReady ? 'ZIP 单文件包' : 'JSON 版'}
                </Badge>
              }
            />

            <Button
              size="lg"
              block
              onClick={handleReportDownload}
              icon={<Download className="h-5 w-5" />}
            >
              下载诊断报告
            </Button>

            <p className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">
              按钮没反应？点这里
              <a
                href={api.reportUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1 font-medium text-brand-600 underline dark:text-brand-300"
              >
                直接用链接下载
              </a>
            </p>

            {/* 下载报告后是否清空已收集的日志（服务端持久化设置，切换即保存） */}
            <div className="mt-3 rounded-2xl border border-brand-100 bg-white/70 px-3.5 py-3 dark:border-brand-500/20 dark:bg-slate-900/40">
              <Switch
                checked={clearLogsAfterReport}
                disabled={clearSaving}
                onChange={(next) => void handleClearLogsToggle(next)}
                label="下载后清空已有日志"
                description="开启后：点「下载诊断报告」成功即清空 app.log 等历史日志（报告里仍包含清空前的日志），这样下一轮测试的日志不会和这一轮混在一起"
              />
            </div>

            {zipReady ? (
              <p className="mt-3 flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                将下载 .zip 单文件包（里面是多个 txt/json，解压即可查看）
              </p>
            ) : (
              <p className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  服务器没有可用的 zip 命令，将下载 JSON 版报告（内容一样，只是一个文件）。
                  {data.zipHint ? (
                    <>
                      {' '}
                      想用 zip 包可在树莓派上执行：
                      <code className="ml-1 rounded bg-amber-100 px-1 py-0.5 font-mono dark:bg-amber-500/20">
                        {data.zipHint}
                      </code>
                    </>
                  ) : null}
                </span>
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-brand-100 pt-3 dark:border-brand-500/20">
              <Badge tone={data.debugMode ? 'success' : 'neutral'} dot pulse={data.debugMode}>
                调试日志：{data.debugMode ? '已开启' : '未开启'}（{data.logLevel}）
              </Badge>
              {failedCount !== null ? (
                <Badge tone={failedCount > 0 ? 'danger' : 'neutral'}>失败任务 {failedCount} 个</Badge>
              ) : null}
              {clearLogsAfterReport ? <Badge tone="brand">下载后自动清空日志</Badge> : null}
              <span className="text-xs text-slate-500 dark:text-slate-400">
                调试期建议保持开启，日志更详细（可在「日志」页切换）
              </span>
            </div>

            <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
              报告生成时间：{formatDateTime(data.generatedAt)}
            </p>
          </Card>

          {/* 2. 下载单项信息 */}
          <Card>
            <CardHeader
              title="下载单项信息"
              subtitle="如果只想给某一部分，可以单独下载下面的文件；推荐先下载第一项"
            />
            {items.length ? (
              <ul className="space-y-3">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className={cn(
                      'rounded-2xl border p-3.5 transition-colors',
                      item.recommended
                        ? 'border-brand-300 bg-brand-50/60 dark:border-brand-500/50 dark:bg-brand-500/10'
                        : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                            {item.title}
                          </p>
                          {item.recommended ? <Badge tone="brand">推荐</Badge> : null}
                          <Badge tone={KIND_TONES[item.kind] ?? 'neutral'}>{item.kind}</Badge>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                          {item.description}
                        </p>
                        <p className="mt-1.5 break-all font-mono text-[11px] text-slate-400 dark:text-slate-500">
                          {item.name}
                        </p>
                        <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                          大小：
                          {item.sizeBytes === null ? '—' : formatBytes(item.sizeBytes, '—')}
                          {' · '}更新：{formatDateTime(item.updatedAt)}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant={item.recommended ? 'primary' : 'outline'}
                        className="w-full sm:w-auto"
                        onClick={() => handleItemDownload(item)}
                        icon={<Download className="h-3.5 w-3.5" />}
                      >
                        下载
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl bg-slate-50 px-3 py-6 text-center text-sm text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
                服务端暂无可下载项，可直接用上面的「下载诊断报告」
              </p>
            )}
          </Card>
        </>
      ) : null}

      {/* 3. 只导出报错 */}
      <Card>
        <CardHeader
          title="只导出报错"
          subtitle="只想看错误就用这个，文件很小，方便直接发给我"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            label="级别"
            value={level}
            onChange={(event) => setLevel(event.target.value)}
            options={LEVEL_OPTIONS}
            hint="error 只有错误；warn 额外包含警告"
          />
          <Input
            label="行数"
            type="number"
            min={1}
            max={50000}
            step={500}
            value={lines}
            onChange={(event) => setLines(event.target.value)}
            hint={`默认 ${DEFAULT_LINES} 行，越小文件越小`}
          />
          <Input
            label="标记（可选）"
            value={marker}
            placeholder="例如某条日志标记，一般不用填"
            onChange={(event) => setMarker(event.target.value)}
          />
          <Input
            label="关键字（可选）"
            value={q}
            placeholder="例如视频标题 / 网站域名"
            onChange={(event) => setQ(event.target.value)}
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
          <Button onClick={handleLogExport} icon={<FileText className="h-4 w-4" />}>
            导出日志
          </Button>
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <Info className="h-3.5 w-3.5 shrink-0" />
            只想看错误就用这个，文件很小
          </span>
        </div>
      </Card>

      {/* 4. 最近失败的任务 */}
      <Card>
        <CardHeader
          title="最近失败的任务"
          subtitle="失败原因可以直接复制给我，配合诊断报告定位更快"
          action={
            <Button
              variant="ghost"
              size="sm"
              loading={failedLoading}
              onClick={() => void loadFailed()}
              icon={<RefreshCw className={cn('h-3.5 w-3.5', failedLoading && 'animate-spin')} />}
            >
              刷新
            </Button>
          }
        />
        {failedLoading && !failed ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : failedError && !failed ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-red-600 dark:text-red-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            失败任务读取失败：{failedError}
            <Button variant="outline" size="sm" onClick={() => void loadFailed()}>
              重试
            </Button>
          </p>
        ) : failed && failed.length ? (
          <ul className="space-y-3">
            {failed.map((task) => (
              <li
                key={task.id}
                className="rounded-2xl border border-slate-200 p-3.5 dark:border-slate-800"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p
                      className="truncate text-sm font-medium text-slate-800 dark:text-slate-100"
                      title={task.title}
                    >
                      {task.title || `任务 #${task.id}`}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                      {MODULE_LABELS[task.module] ?? task.module} ·{' '}
                      {formatDateTime(task.finishedAt ?? task.createdAt)}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleCopy(task)}
                    icon={<Copy className="h-3.5 w-3.5" />}
                  >
                    复制
                  </Button>
                </div>
                {task.error ? (
                  <p className="mt-2 rounded-xl bg-slate-50 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                    {task.error}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
                    没有记录到具体失败原因，可下载诊断报告进一步排查
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl bg-slate-50 px-3 py-6 text-center text-sm text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
            最近没有失败任务 🎉
          </p>
        )}
      </Card>

      {/* 5. 怎么反馈问题 */}
      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <Send className="h-4 w-4" />
              怎么反馈问题
            </span>
          }
          subtitle="三步即可，不需要你懂技术"
        />
        <ol className="space-y-2.5 text-sm text-slate-700 dark:text-slate-200">
          {[
            '点最上面的「下载诊断报告」按钮，浏览器会把文件下载到你的电脑 / 手机；',
            '再补一句大概什么时候出的问题、点了什么；有报错截图或文字更好；',
            '把下载的文件（和截图）发给我（微信 / QQ / 邮件都行），我来分析。',
          ].map((text, index) => (
            <li key={text} className="flex items-start gap-2.5">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 text-[11px] font-semibold text-white">
                {index + 1}
              </span>
              <span className="min-w-0 leading-relaxed">{text}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
          <span>
            报告里的 token / 密码已自动打码；日志里可能含视频 URL / 种子名，介意可自行删除这些行后再发。
          </span>
        </p>
      </Card>

      {/* 6. 历史报告 */}
      {reports.length ? (
        <Card>
          <CardHeader
            title="历史报告"
            subtitle={`最近生成的 ${reports.length} 份报告，需要时随时重新下载`}
          />
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {reports.map((report) => (
              <li
                key={report.name}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-slate-700 dark:text-slate-200">
                    {report.name}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                    {formatBytes(report.sizeBytes, '—')} · {formatDateTime(report.mtime)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleFileDownload(report.name)}
                  icon={<Download className="h-3.5 w-3.5" />}
                >
                  下载
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}
