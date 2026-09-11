import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Bug,
  ChevronDown,
  Download,
  FileText,
  Info,
  RefreshCw,
  ScrollText,
  Search,
  Trash2,
} from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorState,
  Input,
  LoadingBlock,
  Select,
  Switch,
  Table,
} from '../components/ui'
import type { Column } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { useDebouncedValue } from '../hooks/useAsync'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { formatBytes, formatDateTime, humanizeError } from '../lib/format'
import type { DebugStatus, LogLevel, LogsTail } from '../types'

/** 每次拉取的日志行数（服务端上限） */
const LOG_LINES = 300
/** 自动刷新间隔（毫秒） */
const AUTO_REFRESH_MS = 3000

/** 过滤级别下拉（含“全部”） */
const LEVEL_FILTER_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'error', label: 'error' },
  { value: 'warn', label: 'warn' },
  { value: 'info', label: 'info' },
  { value: 'debug', label: 'debug' },
  { value: 'trace', label: 'trace' },
]

/** 持久化日志级别下拉（无“全部”） */
const LOG_LEVEL_OPTIONS: { value: LogLevel; label: string }[] = [
  { value: 'error', label: 'error' },
  { value: 'warn', label: 'warn' },
  { value: 'info', label: 'info' },
  { value: 'debug', label: 'debug' },
  { value: 'trace', label: 'trace' },
]

type LineTone = 'error' | 'warn' | 'info' | 'debug' | 'trace'

const LINE_TONE_CLASS: Record<LineTone, string> = {
  error: 'text-red-400',
  warn: 'text-amber-300',
  info: 'text-slate-300',
  debug: 'text-slate-500',
  trace: 'text-slate-500',
}

/** 行级别判定：后端格式为 `时间 [LEVEL] [MARK:X] [scope] message` */
function lineTone(line: string): LineTone {
  if (line.includes('[ERROR')) return 'error'
  if (line.includes('[WARN')) return 'warn'
  if (line.includes('[DEBUG')) return 'debug'
  if (line.includes('[TRACE')) return 'trace'
  return 'info'
}

const MARKER_PATTERN = /(\[MARK:[^\]]+\])/g

/** 单行日志：按级别着色，并把 [MARK:XXX] 高亮成独立胶囊 */
function LogLine({ line }: { line: string }) {
  return (
    <div className={cn('rounded px-1.5 py-px', LINE_TONE_CLASS[lineTone(line)])}>
      {line.split(MARKER_PATTERN).map((part, index) =>
        part.startsWith('[MARK:') ? (
          <span
            key={index}
            className="mx-0.5 rounded border border-amber-400/70 bg-amber-400/15 px-1 font-semibold text-amber-300"
          >
            {part}
          </span>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </div>
  )
}

export default function LogsPage() {
  const toast = useToast()

  const [logs, setLogs] = useState<LogsTail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 过滤条件
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null)
  const [marker, setMarker] = useState('')
  const [level, setLevel] = useState('all')

  // 展示 / 操作状态
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [downloadFile, setDownloadFile] = useState('')
  const [debugBusy, setDebugBusy] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [markersOpen, setMarkersOpen] = useState(true)

  const debouncedQuery = useDebouncedValue(query, 300)
  // 回车立即生效；防抖值追上后取消临时覆盖，继续输入不会有回跳
  const effectiveQuery = submittedQuery ?? debouncedQuery

  useEffect(() => {
    if (submittedQuery !== null && debouncedQuery === submittedQuery) setSubmittedQuery(null)
  }, [debouncedQuery, submittedQuery])

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true)
      try {
        const data = await api.getLogs({
          lines: LOG_LINES,
          level: level === 'all' ? undefined : level,
          q: effectiveQuery || undefined,
          marker: marker || undefined,
        })
        setLogs(data)
        setError(null)
        setDownloadFile((current) => current || data.files[0]?.name || '')
      } catch (err) {
        const message = humanizeError((err as { code?: string }).code ?? '', (err as Error).message)
        setError(message)
        if (!silent) toast.error('日志读取失败', message)
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [effectiveQuery, level, marker, toast],
  )

  // 首次进入 + 过滤条件变化时自动拉取
  useEffect(() => {
    void load()
  }, [load])

  // 自动刷新（组件卸载 / 关闭开关时清理定时器）
  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(() => {
      void load(true)
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [autoRefresh, load])

  const applyStatus = (status: DebugStatus) => {
    setLogs((current) => (current ? { ...current, ...status } : current))
  }

  const handleDebugToggle = async (next: boolean) => {
    setDebugBusy(true)
    try {
      const status = await api.setDebug({ debugMode: next })
      applyStatus(status)
      toast.success(
        next ? '已开启 Debug 模式' : '已关闭 Debug 模式',
        next ? '将记录外部命令 argv、退出码与输出摘要' : '已恢复常规日志，日志体积会明显下降',
      )
      await load(true)
    } catch (err) {
      toast.error(
        '切换 Debug 模式失败',
        humanizeError((err as { code?: string }).code ?? '', (err as Error).message),
      )
    } finally {
      setDebugBusy(false)
    }
  }

  const handleLevelChange = async (next: string) => {
    setDebugBusy(true)
    try {
      const status = await api.setDebug({ logLevel: next as LogLevel })
      applyStatus(status)
      toast.success('日志级别已更新', `当前级别：${next}`)
      await load(true)
    } catch (err) {
      toast.error(
        '修改日志级别失败',
        humanizeError((err as { code?: string }).code ?? '', (err as Error).message),
      )
    } finally {
      setDebugBusy(false)
    }
  }

  const handleDownload = (file?: string) => {
    window.open(api.logsDownloadUrl(file), '_blank', 'noopener,noreferrer')
  }

  const handleDiagnostics = () => {
    window.open(api.diagnosticsDownloadUrl(), '_blank', 'noopener,noreferrer')
    toast.info('正在导出诊断包', '把诊断包发给我即可排查')
  }

  const handleClear = async () => {
    if (!window.confirm('确定清空全部日志文件？该操作不可撤销。')) return
    setClearing(true)
    try {
      const res = await api.clearLogs()
      toast.success(
        '日志已清空',
        `已删除 ${res.cleared ?? 0} 个文件 · 释放 ${formatBytes(res.bytes, '0 B')}`,
      )
      await load(true)
    } catch (err) {
      toast.error(
        '清空日志失败',
        humanizeError((err as { code?: string }).code ?? '', (err as Error).message),
      )
    } finally {
      setClearing(false)
    }
  }

  const markers = logs?.markers ?? []
  const usedMarkers = logs?.usedMarkers ?? []
  const lines = logs?.lines ?? []
  const truncated = lines.length >= LOG_LINES

  const totalBytes = useMemo(
    () => (logs?.files ?? []).reduce((sum, file) => sum + (file.sizeBytes || 0), 0),
    [logs],
  )
  const usedMarkerSet = useMemo(() => new Set(logs?.usedMarkers ?? []), [logs])

  const markerOptions = useMemo(
    () => [
      { value: '', label: '全部标记' },
      ...(logs?.markers ?? []).map((item) => ({
        value: item.marker,
        label: item.description ? `${item.marker} — ${item.description}` : item.marker,
      })),
    ],
    [logs],
  )

  const fileOptions = useMemo(
    () =>
      (logs?.files ?? []).map((file) => ({
        value: file.name,
        label: `${file.name} · ${formatBytes(file.sizeBytes, '0 B')}`,
      })),
    [logs],
  )

  const markerColumns: Column<{ marker: string; description: string }>[] = useMemo(
    () => [
      {
        key: 'marker',
        header: '标记',
        className: 'w-[150px]',
        render: (row) => (
          <span className="inline-flex items-center gap-1.5">
            <code className="font-mono text-xs text-slate-700 dark:text-slate-200">
              {row.marker}
            </code>
            {usedMarkerSet.has(row.marker) ? <Badge tone="success">已出现</Badge> : null}
          </span>
        ),
      },
      {
        key: 'description',
        header: '含义',
        render: (row) => <span className="text-xs">{row.description}</span>,
      },
    ],
    [usedMarkerSet],
  )

  return (
    <div className="space-y-5">
      {/* 页头 */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">日志 / 调试</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            查看、过滤、下载与清空服务端日志，并导出诊断包
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleDownload()}
            icon={<Download className="h-3.5 w-3.5" />}
          >
            下载当前日志
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleDiagnostics}
            icon={<FileText className="h-3.5 w-3.5" />}
          >
            导出诊断包
          </Button>
        </div>
      </div>

      {/* 调试开关 */}
      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <Bug className="h-4 w-4" /> 调试开关
            </span>
          }
          subtitle="排查问题时开启，平时保持关闭以减小日志体积"
          action={
            logs ? (
              <Badge tone={logs.debugMode ? 'warning' : 'neutral'} dot pulse={logs.debugMode}>
                {logs.debugMode ? 'Debug 已开启' : '常规模式'}
              </Badge>
            ) : null
          }
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Switch
              checked={logs?.debugMode ?? false}
              disabled={!logs || debugBusy}
              onChange={(checked) => void handleDebugToggle(checked)}
              label="Debug 模式"
              description="记录外部命令 argv、退出码、stdout/stderr 摘要（日志会明显变大）"
            />
          </div>
          <Select
            label="日志级别"
            value={logs?.logLevel ?? 'info'}
            disabled={!logs || debugBusy}
            onChange={(event) => void handleLevelChange(event.target.value)}
            options={LOG_LEVEL_OPTIONS}
          />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 border-t border-slate-100 pt-4 sm:grid-cols-3 dark:border-slate-800">
          <div className="min-w-0 rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">日志文件路径</p>
            <p className="mt-0.5 break-all font-mono text-xs text-slate-700 dark:text-slate-200">
              {logs?.file ?? '—'}
            </p>
          </div>
          <div className="min-w-0 rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">日志目录</p>
            <p className="mt-0.5 break-all font-mono text-xs text-slate-700 dark:text-slate-200">
              {logs?.dir ?? '—'}
            </p>
          </div>
          <div className="min-w-0 rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              日志总大小（{logs?.files.length ?? 0} 个文件）
            </p>
            <p className="mt-0.5 font-mono text-xs text-slate-700 dark:text-slate-200">
              {formatBytes(totalBytes, '0 B')}
            </p>
          </div>
        </div>

        <p className="mt-3 flex items-start gap-2 text-xs text-slate-500 dark:text-slate-400">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            提示：Debug 模式会记录外部命令 argv、退出码、stdout/stderr 摘要，排查完可切回 info
            以减小日志。
          </span>
        </p>
      </Card>

      {/* 查看 */}
      <Card>
        <CardHeader
          title="查看日志"
          subtitle="按关键字 / 标记 / 级别过滤，或直接下载原始文件"
          action={
            <Button
              variant="ghost"
              size="sm"
              loading={loading}
              onClick={() => void load()}
              icon={<RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />}
            >
              刷新
            </Button>
          }
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            label="关键字"
            value={query}
            leading={<Search className="h-4 w-4" />}
            placeholder="搜索日志内容（回车立即查询）"
            onChange={(event) => {
              setQuery(event.target.value)
              setSubmittedQuery(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setSubmittedQuery(query)
            }}
          />
          <Select
            label="标记"
            value={marker}
            onChange={(event) => setMarker(event.target.value)}
            options={markerOptions}
          />
          <Select
            label="级别"
            value={level}
            onChange={(event) => setLevel(event.target.value)}
            options={LEVEL_FILTER_OPTIONS}
          />
          <div className="flex items-end pb-1">
            <Switch
              className="w-full"
              checked={autoRefresh}
              onChange={setAutoRefresh}
              label="自动刷新"
              description="每 3 秒重新拉取一次"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => handleDownload()}
            icon={<Download className="h-3.5 w-3.5" />}
          >
            下载当前日志
          </Button>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Select
              className="min-w-[180px]"
              aria-label="选择日志文件"
              value={downloadFile}
              onChange={(event) => setDownloadFile(event.target.value)}
              options={fileOptions.length ? fileOptions : [{ value: '', label: '暂无日志文件' }]}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!downloadFile}
              onClick={() => handleDownload(downloadFile || undefined)}
              icon={<Download className="h-3.5 w-3.5" />}
            >
              选择文件下载
            </Button>
          </div>
          <Button
            variant="secondary"
            size="sm"
            loading={clearing}
            onClick={() => void handleClear()}
            icon={<Trash2 className="h-3.5 w-3.5" />}
          >
            清空日志
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleDiagnostics}
            icon={<FileText className="h-3.5 w-3.5" />}
          >
            导出诊断包
          </Button>
        </div>

        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>
              共 {lines.length} 条
              {truncated
                ? `（已达单次上限 ${LOG_LINES} 条，可能被截断，可加关键字或标记缩小范围）`
                : ''}
            </span>
            {logs ? (
              <span className="max-w-full truncate" title={logs.file}>
                当前文件：{logs.file}
              </span>
            ) : null}
          </div>

          {error && logs ? (
            <p className="mb-2 flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              刷新失败：{error}（下方为上次结果）
            </p>
          ) : null}

          {loading && !logs ? (
            <LoadingBlock text="正在读取日志…" />
          ) : error && !logs ? (
            <ErrorState message={`日志读取失败：${error}`} onRetry={() => void load()} />
          ) : (
            <div className="max-h-[60vh] overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-slate-300 sm:text-xs">
              {lines.length ? (
                lines.map((line, index) => <LogLine key={`${index}-${line.slice(0, 24)}`} line={line} />)
              ) : (
                <p className="px-2 py-8 text-center font-sans text-sm text-slate-500">暂无日志</p>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* 标记说明 */}
      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <ScrollText className="h-4 w-4" /> 标记说明
            </span>
          }
          subtitle={`共 ${markers.length} 个标记，日志中已出现 ${usedMarkers.length} 个`}
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMarkersOpen((open) => !open)}
              aria-expanded={markersOpen}
            >
              {markersOpen ? '收起' : '展开'}
              <ChevronDown
                className={cn('h-3.5 w-3.5 transition-transform', markersOpen && 'rotate-180')}
              />
            </Button>
          }
        />
        {markersOpen ? (
          <Table
            columns={markerColumns}
            rows={markers}
            rowKey={(row) => row.marker}
            minWidthClass="min-w-[320px]"
            empty={<p className="text-sm text-slate-500 dark:text-slate-400">暂无标记定义</p>}
          />
        ) : null}
        <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
          最近更新：{logs?.files[0] ? formatDateTime(logs.files[0].mtime) : '—'}
        </p>
      </Card>
    </div>
  )
}
