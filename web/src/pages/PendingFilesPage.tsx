import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Clock,
  Copy,
  Download,
  DownloadCloud,
  HardDrive,
  RefreshCw,
  Search,
  Smartphone,
  X,
} from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Input,
  Pagination,
  Skeleton,
  StatCard,
  Switch,
} from '../components/ui'
import { useToast } from '../context/ToastContext'
import { useDebouncedValue } from '../hooks/useAsync'
import { api, MODULE_LABELS } from '../lib/api'
import { formatBytes, formatDateTime, formatRelative } from '../lib/format'
import type { PendingFilesResponse, PublishedFile } from '../types'

const PAGE_SIZE = 20
/** 自动刷新间隔（静默，不打断当前操作） */
const AUTO_REFRESH_MS = 10_000

/** 秒 → 「12 分钟 / 3 小时 / 2 天」 */
function formatWaiting(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '—'
  }
  const sec = Math.round(seconds)
  if (sec < 60) return `${sec} 秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时`
  return `${Math.floor(hour / 24)} 天`
}

/** 下载地址：优先用后端返回的 downloadUrl，缺失时回退到 fileDownloadUrl 助手（会自动带上 API_BASE 前缀） */
function downloadHref(file: PublishedFile): string {
  const path = file.downloadUrl || api.fileDownloadUrl(file.id, file.name)
  try {
    return new URL(path, window.location.origin).href
  } catch {
    return path
  }
}

interface PendingRowProps {
  file: PublishedFile
  onDownload: (file: PublishedFile) => void
  onCopy: (file: PublishedFile) => void
}

function PendingRow({ file, onDownload, onCopy }: PendingRowProps) {
  const androidDownloads = file.androidDownloads ?? 0
  const webDownloads = file.webDownloads ?? 0

  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate font-mono text-sm font-medium text-slate-800 dark:text-slate-100">
            {file.name}
          </span>
          <Badge tone="neutral">{MODULE_LABELS[file.module] ?? file.module}</Badge>
        </div>
        <p className="line-clamp-1 text-xs text-slate-600 dark:text-slate-300" title={file.title}>
          {file.title}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="tabular-nums">{formatBytes(file.sizeBytes, '未知')}</span>
          <span className="tabular-nums" title={formatDateTime(file.createdAt)}>
            加密归档 {formatDateTime(file.createdAt)}
          </span>
          {file.waitingSec === undefined ? null : (
            <span className="font-medium text-amber-600 dark:text-amber-400">
              已等待 {formatWaiting(file.waitingSec)}
            </span>
          )}
          {webDownloads > 0 ? <span>本机已下载 {webDownloads} 次</span> : null}
        </div>
        {androidDownloads > 0 ? (
          <p
            className="flex items-start gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400"
            title={formatDateTime(file.lastAndroidDownloadAt)}
          >
            <Smartphone className="mt-px h-3 w-3 shrink-0" />
            <span>
              安卓已下载 {androidDownloads} 次，尚未上报完成（最后{' '}
              {formatRelative(file.lastAndroidDownloadAt)}）
            </span>
          </p>
        ) : (
          <p className="flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500">
            <Smartphone className="h-3 w-3 shrink-0" />
            安卓尚未下载
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:flex-col sm:items-stretch">
        <Button
          size="sm"
          icon={<Download className="h-3.5 w-3.5" />}
          onClick={() => onDownload(file)}
        >
          下载
        </Button>
        <Button
          size="sm"
          variant="outline"
          icon={<Copy className="h-3.5 w-3.5" />}
          onClick={() => onCopy(file)}
        >
          复制下载链接
        </Button>
      </div>
    </div>
  )
}

export default function PendingFilesPage() {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [autoRefresh, setAutoRefresh] = useState(true)

  const debouncedQuery = useDebouncedValue(query, 300)
  const [data, setData] = useState<PendingFilesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 请求序号：避免快速输入 / 自动刷新时旧响应覆盖新结果
  const requestSeq = useRef(0)

  const load = useCallback(
    async (silent = false) => {
      const seq = ++requestSeq.current
      if (!silent) setLoading(true)
      try {
        const res = await api.pendingFiles({
          q: debouncedQuery || undefined,
          page,
          pageSize: PAGE_SIZE,
        })
        if (seq !== requestSeq.current) return
        setData(res)
        setError(null)
      } catch (err) {
        if (seq !== requestSeq.current) return
        const message = (err as Error).message || '请求失败，请稍后重试'
        setError(message)
        // 自动刷新失败不弹 Toast，避免每 10 秒刷屏；手动/首次加载失败才提示
        if (!silent) toast.error('加载待下载文件失败', message)
      } finally {
        if (seq === requestSeq.current) setLoading(false)
      }
    },
    [debouncedQuery, page, toast],
  )

  // 挂载 / 搜索 / 翻页时加载
  useEffect(() => {
    void load()
  }, [load])

  // 搜索条件变化时回到第一页
  useEffect(() => {
    setPage(1)
  }, [debouncedQuery])

  // 自动刷新（默认开启，每 10 秒静默刷新；关闭或卸载时清理定时器）
  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(() => {
      void load(true)
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [autoRefresh, load])

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const totalBytes = data?.totalBytes ?? 0
  const oldestWaitingSec = data?.oldestWaitingSec ?? 0

  const handleDownload = useCallback(
    (file: PublishedFile) => {
      const href = downloadHref(file)
      // 用临时 <a> 触发下载，避免被浏览器当作弹窗拦截
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.target = '_blank'
      anchor.rel = 'noopener noreferrer'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      toast.success(
        `已开始下载：${file.title}`,
        '下载完成不代表安卓已取走，仍会留在列表里直到安卓上报完成',
      )
    },
    [toast],
  )

  const handleCopy = useCallback(
    async (file: PublishedFile) => {
      const href = downloadHref(file)
      try {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
        await navigator.clipboard.writeText(href)
        toast.success('下载链接已复制', href)
      } catch {
        toast.error('复制失败，请手动复制', href)
      }
    },
    [toast],
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-slate-50">
            <DownloadCloud className="h-5 w-5 text-brand-600 dark:text-brand-300" />
            待下载文件
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            已下载完成并加密归档、
            <strong className="font-semibold text-slate-700 dark:text-slate-200">
              安卓端还没取走
            </strong>
            的成品；这里可以直接下载到本机
          </p>
        </div>
      </div>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard
          label="待下载文件数"
          value={total}
          tone="brand"
          icon={<DownloadCloud className="h-4 w-4" />}
        />
        <StatCard
          label="总大小"
          value={formatBytes(totalBytes, '0 B')}
          tone="neutral"
          icon={<HardDrive className="h-4 w-4" />}
        />
        <StatCard
          label="等待最久"
          value={total > 0 ? formatWaiting(oldestWaitingSec) : '—'}
          hint={total > 0 ? '距该文件加密归档完成的时间' : '当前没有待下载文件'}
          tone="warning"
          icon={<Clock className="h-4 w-4" />}
          className="col-span-2 lg:col-span-1"
        />
      </section>

      <Card>
        <CardHeader
          title="待下载清单"
          subtitle={`共 ${total} 个文件 · 安卓端取走并上报后会从这里消失`}
        />

        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文件名或标题"
            leading={<Search className="h-4 w-4" />}
            wrapperClassName="w-full lg:w-72"
            trailing={
              query ? (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="清空搜索"
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null
            }
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 lg:justify-end">
            <Switch
              checked={autoRefresh}
              onChange={setAutoRefresh}
              label="自动刷新"
              description="每 10 秒静默刷新"
              className="min-w-[180px] flex-1 lg:flex-none"
            />
            <Button
              variant="outline"
              size="sm"
              loading={loading}
              icon={<RefreshCw className="h-3.5 w-3.5" />}
              onClick={() => void load()}
            >
              刷新
            </Button>
          </div>
        </div>

        {error && !items.length ? (
          <ErrorState
            message={`加载待下载文件失败：${error}`}
            retryText="重试"
            onRetry={() => void load()}
          />
        ) : loading && !data ? (
          <div className="space-y-2">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-20 w-full" />
            ))}
          </div>
        ) : !items.length ? (
          <EmptyState
            icon={<DownloadCloud className="h-5 w-5" />}
            title={query ? '没有匹配的文件' : '🎉 没有待下载的文件'}
            description={
              query
                ? '换个关键词试试，或清空搜索查看全部文件。'
                : '新下载完成的文件会自动出现在这里；安卓端取走并上报后会从这里消失。'
            }
          />
        ) : (
          <>
            {error ? (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300">
                <span>刷新失败：{error}（下方为上一次的数据）</span>
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  重试
                </Button>
              </div>
            ) : null}
            <div className="overflow-hidden rounded-2xl border border-slate-200/80 dark:border-slate-800">
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {items.map((file) => (
                  <PendingRow
                    key={file.id}
                    file={file}
                    onDownload={handleDownload}
                    onCopy={(target) => void handleCopy(target)}
                  />
                ))}
              </div>
            </div>
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              onPageChange={setPage}
              className="mt-4 justify-center sm:justify-start"
            />
          </>
        )}
      </Card>

      <p className="rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-3 text-xs leading-relaxed text-slate-500 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
        安卓端会轮询{' '}
        <code className="rounded bg-slate-200/70 px-1 py-0.5 font-mono text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          GET /api/android/files
        </code>{' '}
        自动取走这些文件；取走并上报完成后服务器会删除文件（腾出空间），本列表随之清空。若长时间没人取走，说明手机端没在运行/没连上服务器。
      </p>
    </div>
  )
}
