import { useCallback, useEffect, useMemo, useState } from 'react'
import { Clock, Download, FileOutput, FileVideo2, HardDrive, RefreshCw, Search, Trash2, X } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DangerConfirmModal,
  EmptyState,
  ErrorState,
  Input,
  LoadingBlock,
  Modal,
  Pagination,
  StatCard,
  Switch,
  Table,
} from '../components/ui'
import type { Column } from '../components/ui'
import { useFileEvents } from '../context/AppDataContext'
import { useToast } from '../context/ToastContext'
import { useOriginalDownload } from '../context/OriginalDownloadContext'
import { useDebouncedValue, useFiles } from '../hooks/useAsync'
import { api, MODULE_LABELS } from '../lib/api'
import { formatBytes, formatDateTime, humanizeError } from '../lib/format'
import type { FileStatusFilter, PublishedFile } from '../types'

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

const CHECKBOX_CLASS =
  'h-4 w-4 shrink-0 cursor-pointer rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600'

/**
 * 文件页：「已发布」与「待下载」合并成一个列表。
 *
 * 两者本来就是**同一张表（published_files）的两个视图**（待下载 = downloaded=0），
 * 所以不再分两个页面，改成顶部状态筛选；顺带把「待下载」页原先的自动刷新、
 * 「等待最久」统计也一起并进来。
 *
 * 危险操作：全选当前页 → 全部删除，走**三步确认**（范围 → 方式 → 输入确认词），
 * 并保留原有的单条删除。
 */
export default function FilesPage() {
  const toast = useToast()
  const original = useOriginalDownload()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<FileStatusFilter>('all')
  const [page, setPage] = useState(1)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const debouncedQuery = useDebouncedValue(query, 350)
  const { items, total, totalBytes, counts, loading, error, refresh, setItems } = useFiles({
    q: debouncedQuery,
    page,
    pageSize: PAGE_SIZE,
    status,
  })

  /* ---------------- 单条删除（原有功能） ---------------- */
  const [target, setTarget] = useState<PublishedFile | null>(null)
  const [withFile, setWithFile] = useState(false)
  const [deleting, setDeleting] = useState(false)

  /* ---------------- 批量删除（新增，三步确认；弹窗由 DangerConfirmModal 承担） ---------------- */
  const [selected, setSelected] = useState<Set<number>>(new Set())
  /** 「全部下载」正在发起（浏览器接管后即恢复） */
  const [bulkDownloading, setBulkDownloading] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkWithFile, setBulkWithFile] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)

  const selectedFiles = useMemo(() => items.filter((file) => selected.has(file.id)), [items, selected])
  /** 「下载原始文件」是否可用（服务器没配 ORIGINAL_DL_SECRET 时禁用按钮，别让用户白点） */
  const originalAvailable = original.status?.enabled !== false
  const selectedBytes = useMemo(
    () => selectedFiles.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
    [selectedFiles],
  )
  const allOnPageSelected = items.length > 0 && items.every((file) => selected.has(file.id))
  const someOnPageSelected = items.some((file) => selected.has(file.id))

  // 新发布文件时自动刷新
  useFileEvents(() => {
    void refresh()
  })

  useEffect(() => {
    setPage(1)
  }, [debouncedQuery, status])

  // 换页/换筛选/换搜索词时清空勾选：**绝不允许对看不见的行执行删除**
  useEffect(() => {
    setSelected(new Set())
  }, [page, status, debouncedQuery])

  // 列表刷新后把已经不存在的 id 剔除（自动刷新/别处删掉时勾选不会残留）
  useEffect(() => {
    setSelected((current) => {
      if (!current.size) return current
      const alive = new Set(items.map((file) => file.id))
      const next = new Set([...current].filter((id) => alive.has(id)))
      return next.size === current.size ? current : next
    })
  }, [items])

  // 自动刷新（默认开启，每 10 秒静默刷新；关闭或卸载时清理定时器）
  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(() => {
      void refresh()
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [autoRefresh, refresh])

  const handleDelete = useCallback(async () => {
    if (!target) return
    setDeleting(true)
    try {
      await api.deleteFile(target.id, withFile)
      toast.success(withFile ? '已删除记录和文件' : '已删除记录', target.title)
      setItems((current) => current.filter((item) => item.id !== target.id))
      setTarget(null)
      void refresh()
    } catch (err) {
      toast.error('删除失败', humanizeError((err as { code?: string }).code ?? '', (err as Error).message))
    } finally {
      setDeleting(false)
    }
  }, [refresh, setItems, target, toast, withFile])

  const toggleOne = (id: number): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAllOnPage = (): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (allOnPageSelected) items.forEach((file) => next.delete(file.id))
      else items.forEach((file) => next.add(file.id))
      return next
    })
  }

  /**
   * 「全选 → 全部下载」：**打成一个 .tar 一次下载**。
   *
   * 为什么不像单行那样一个个点：浏览器对"同一站点同时下载几个"有硬限制（Chrome 约 6 个），
   * 单点超过 6 个，后面的就要排队等前面的下完 —— 那是浏览器连接池的限制，服务端没法绕过。
   * 打成一个包 → 只发一条请求一条连接 → **多少个都行，没有数量限制**。
   */
  const bulkDownloadProducts = useCallback(async () => {
    const files = selectedFiles.filter((f) => f.available !== false)
    if (!files.length) {
      toast.warning('没有可下载的文件', '选中的文件在磁盘上都已不存在（可能已被安卓端取走）')
      return
    }
    if (files.length < selectedFiles.length) {
      toast.info('有文件已不在磁盘上，已自动跳过', `${selectedFiles.length - files.length} 个跳过`)
    }
    const total = files.reduce((n, f) => n + (f.sizeBytes ?? 0), 0)
    const go = window.confirm(
      [
        `将把 ${files.length} 个文件打包成一个 .tar 下载（共 ${formatBytes(total, '0 B')}）。`,
        '',
        '· 只发一条下载请求，不受浏览器"同时最多下 6 个"的限制；',
        '· 服务器是**边读边发**的流式打包，不再额外占用磁盘；',
        '· 压缩包内文件名就是列表里的文件名（Windows 10+ 自带 tar，macOS/Linux 直接双击）。',
        '',
        '开始下载吗？',
      ].join('\n'),
    )
    if (!go) return
    setBulkDownloading(true)
    try {
      const a = document.createElement('a')
      a.href = api.filesBulkDownloadUrl(files.map((f) => f.id))
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      toast.success(`已开始打包下载 ${files.length} 个文件`, '浏览器会把它当成一个文件下载，中途别刷新页面')
    } finally {
      // 浏览器接管下载是异步的，这里只是把按钮的 loading 收回来
      window.setTimeout(() => setBulkDownloading(false), 1500)
    }
  }, [selectedFiles, toast])

  const openBulk = (): void => {
    if (!selected.size) return
    setBulkWithFile(false)
    setBulkOpen(true)
  }

  const closeBulk = (): void => {
    if (bulkBusy) return
    setBulkOpen(false)
  }

  const handleBulkDelete = useCallback(async () => {
    if (bulkBusy) return
    const ids = selectedFiles.map((file) => file.id)
    if (!ids.length) return
    setBulkBusy(true)
    try {
      const res = await api.bulkDeleteFiles(ids, bulkWithFile)
      const mode = res.withFile ? '记录和磁盘文件' : '仅记录'
      if (res.failed?.length) {
        toast.error(
          `部分删除失败：成功 ${res.deleted} 个、失败 ${res.failed.length} 个`,
          res.failed.map((f) => `#${f.id} ${f.error}`).join('；'),
        )
      } else {
        toast.success(
          `已删除 ${res.deleted} 个文件（${mode}${res.deletedFiles ? ` · 释放磁盘 ${res.deletedFiles} 个` : ''}）`,
        )
      }
      setBulkOpen(false)
      setSelected(new Set())
      void refresh()
    } catch (err) {
      toast.error('批量删除失败', humanizeError((err as { code?: string }).code ?? '', (err as Error).message))
    } finally {
      setBulkBusy(false)
    }
  }, [bulkBusy, bulkWithFile, refresh, selectedFiles, toast])

  const oldestWaitingSec = counts?.oldestPendingAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(counts.oldestPendingAt)) / 1000))
    : 0

  const columns: Column<PublishedFile>[] = [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          className={CHECKBOX_CLASS}
          aria-label="全选当前页"
          title="全选当前页"
          checked={allOnPageSelected}
          ref={(el) => {
            if (el) el.indeterminate = someOnPageSelected && !allOnPageSelected
          }}
          onChange={toggleAllOnPage}
        />
      ),
      className: 'w-10',
      render: (file) => (
        <input
          type="checkbox"
          className={CHECKBOX_CLASS}
          aria-label={`选择 ${file.name}`}
          checked={selected.has(file.id)}
          onChange={() => toggleOne(file.id)}
        />
      ),
    },
    {
      key: 'name',
      header: '发布文件',
      render: (file) => (
        <div className="min-w-0 max-w-[280px]">
          <p className="truncate font-mono text-sm font-medium text-slate-800 dark:text-slate-100">
            {file.name}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-slate-400" title={file.title}>
            {file.title}
          </p>
        </div>
      ),
    },
    {
      key: 'module',
      header: '来源模块',
      render: (file) => <Badge tone="neutral">{MODULE_LABELS[file.module] ?? file.module}</Badge>,
    },
    {
      key: 'size',
      header: '大小',
      render: (file) => (
        <span className="whitespace-nowrap text-xs tabular-nums text-slate-600 dark:text-slate-300">
          {formatBytes(file.sizeBytes, '未知')}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: '创建时间',
      render: (file) => (
        <span className="whitespace-nowrap text-xs tabular-nums text-slate-500 dark:text-slate-400">
          {formatDateTime(file.createdAt)}
        </span>
      ),
    },
    {
      key: 'downloaded',
      header: '下载状态',
      render: (file) => {
        const times = (file.androidDownloads ?? 0) + (file.webDownloads ?? 0)
        return (
          <div className="space-y-1">
            {!file.available ? (
              <Badge tone="neutral" dot>
                已下载 · 服务器已删除
              </Badge>
            ) : file.downloaded ? (
              <Badge tone="success" dot>
                已被下载
              </Badge>
            ) : (
              <Badge tone="warning" dot>
                待下载 · 已等待 {formatWaiting(file.waitingSec)}
              </Badge>
            )}
            {times > 0 ? (
              <p className="text-[11px] text-slate-400">
                已下载 {times} 次
                {file.androidDownloads ? ` · 安卓 ${file.androidDownloads}` : ''}
                {file.webDownloads ? ` · 网页 ${file.webDownloads}` : ''}
              </p>
            ) : null}
            {file.downloadedAt ? (
              <p className="text-[11px] text-slate-400">{formatDateTime(file.downloadedAt)}</p>
            ) : null}
          </div>
        )
      },
    },
    {
      key: 'actions',
      header: '操作',
      headerClassName: 'text-right',
      className: 'text-right',
      render: (file) => (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {file.available ? (
            <>
              <a
                href={api.fileDownloadUrl(file.id, file.name)}
                target="_blank"
                rel="noreferrer"
                title="下载服务器上的加密归档文件（列表里这个文件本身）"
                className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-slate-200 px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <Download className="h-3.5 w-3.5" />
                下载
              </a>
              <Button
                size="sm"
                variant="outline"
                onClick={() => original.downloadOriginal(file)}
                title="在服务器上临时解密成原始文件再下载（需 6 位下载密码；下载完自动删除临时文件）"
              >
                <FileOutput className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">下载原始文件</span>
                <span className="sm:hidden">原始</span>
              </Button>
            </>
          ) : (
            <span
              title="安卓端已下载完成，服务器上的文件已被删除（数据库记录保留作为历史），无法再下载"
              className="inline-flex h-8 cursor-not-allowed items-center gap-1.5 rounded-xl border border-dashed border-slate-200 px-3 text-xs font-medium text-slate-400 dark:border-slate-700 dark:text-slate-500"
            >
              <Download className="h-3.5 w-3.5" />
              已下载，不可下载
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setTarget(file)
              setWithFile(false)
            }}
            title="删除记录"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">删除</span>
          </Button>
        </div>
      ),
    },
  ]

  const filters: { key: FileStatusFilter; label: string; count: number | undefined }[] = [
    { key: 'all', label: '全部', count: counts?.all },
    { key: 'pending', label: '待下载', count: counts?.pending },
    { key: 'downloaded', label: '已被下载', count: counts?.downloaded },
  ]

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">文件</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            「已发布」与「待下载」已合并到这里 · 待下载 = 已加密归档但
            <strong className="font-semibold text-slate-700 dark:text-slate-200">安卓端还没取走</strong>
            · 安卓端轮询 GET /api/android/files
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            checked={autoRefresh}
            onChange={setAutoRefresh}
            label="自动刷新"
            description="每 10 秒静默刷新"
            className="min-w-[180px]"
          />
          <Button
            variant="outline"
            size="sm"
            loading={loading}
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={() => void refresh()}
          >
            刷新
          </Button>
        </div>
      </div>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="文件总数"
          value={counts?.all ?? total}
          tone="brand"
          icon={<FileVideo2 className="h-4 w-4" />}
        />
        <StatCard
          label="总占用空间"
          value={formatBytes(totalBytes, '0 B')}
          tone="neutral"
          icon={<HardDrive className="h-4 w-4" />}
          hint="当前筛选范围"
        />
        <StatCard
          label="待下载"
          value={counts?.pending ?? 0}
          tone="warning"
          icon={<Download className="h-4 w-4" />}
          hint="安卓端还没取走"
        />
        <StatCard
          label="等待最久"
          value={(counts?.pending ?? 0) > 0 ? formatWaiting(oldestWaitingSec) : '—'}
          tone="neutral"
          icon={<Clock className="h-4 w-4" />}
          hint={(counts?.pending ?? 0) > 0 ? '距加密归档完成' : '当前没有待下载文件'}
        />
      </section>

      <Card>
        <CardHeader
          title="文件清单"
          subtitle="删除记录不会删除磁盘文件；勾选「同时删除文件」才会释放空间"
          action={
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索文件名或标题"
              leading={<Search className="h-4 w-4" />}
              wrapperClassName="w-full sm:w-64"
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
          }
        />

        {/* 状态筛选：原来分成两个页面，现在是一个列表的两个视图 */}
        <div className="mb-3 flex flex-wrap gap-2">
          {filters.map((item) => {
            const active = status === item.key
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setStatus(item.key)}
                aria-pressed={active}
                className={
                  'inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors ' +
                  (active
                    ? 'border-brand-500 bg-brand-50 text-brand-700 dark:border-brand-500/60 dark:bg-brand-950/30 dark:text-brand-200'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800')
                }
              >
                {item.label}
                {item.count === undefined ? null : (
                  <span className="tabular-nums text-[11px] opacity-70">{item.count}</span>
                )}
              </button>
            )
          })}
        </div>

        {/* 批量操作栏 */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                className={CHECKBOX_CLASS}
                checked={allOnPageSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someOnPageSelected && !allOnPageSelected
                }}
                onChange={toggleAllOnPage}
                disabled={!items.length}
              />
              全选当前页
            </label>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              已选 <strong className="tabular-nums text-slate-700 dark:text-slate-200">{selected.size}</strong> 个
              {selected.size > 0 ? `（${formatBytes(selectedBytes, '0 B')}）` : ''}
              {selected.size > 0 ? ' · 只对当前页勾选的行生效' : ''}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              icon={<Download className="h-3.5 w-3.5" />}
              disabled={!selected.size || bulkDownloading}
              loading={bulkDownloading}
              onClick={() => void bulkDownloadProducts()}
              title="把选中的成品打成一个 .tar 一次下载（一个连接，不受浏览器同时下载数量限制）"
            >
              全部下载{selected.size ? `（${selected.size}）` : ''}
            </Button>
            <Button
              size="sm"
              variant="outline"
              icon={<FileOutput className="h-3.5 w-3.5" />}
              disabled={!selected.size || !originalAvailable}
              onClick={() => original.downloadOriginalBulk(selectedFiles)}
              title="在服务器上把这批文件临时解密成原始文件，然后打成一个 .tar 一次下载（需 6 位下载密码）"
            >
              全部下载原始文件{selected.size ? `（${selected.size}）` : ''}
            </Button>
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              disabled={!selected.size}
              onClick={openBulk}
            >
              全部删除{selected.size ? `（${selected.size}）` : ''}
            </Button>
          </div>
        </div>

        {error ? (
          <ErrorState message={`加载文件列表失败：${error}`} onRetry={() => void refresh()} />
        ) : loading && !items.length ? (
          <LoadingBlock text="正在加载文件…" />
        ) : !items.length ? (
          <EmptyState
            title={query ? '没有匹配的文件' : status === 'pending' ? '🎉 没有待下载的文件' : '暂无文件'}
            description={
              query
                ? '换个关键词试试，或清空搜索查看全部文件。'
                : status === 'pending'
                  ? '任务完成归档并加密后，成品会出现在这里，安卓端取走并上报后会从这里消失。'
                  : '任务完成归档并加密后，成品会出现在这里，安卓端即可拉取下载。'
            }
            icon={<FileVideo2 className="h-5 w-5" />}
          />
        ) : (
          <>
            <Table columns={columns} rows={items} rowKey={(file) => file.id} minWidthClass="min-w-[880px]" />
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
          </>
        )}
      </Card>

      {/* ---------------- 单条删除 ---------------- */}
      <Modal
        open={target !== null}
        title="删除发布文件"
        description={target ? `文件：${target.name}（${formatBytes(target.sizeBytes)}）` : ''}
        onClose={() => setTarget(null)}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={deleting}>
              取消
            </Button>
            <Button variant="secondary" loading={deleting} onClick={() => void handleDelete()}>
              {withFile ? '删除记录和文件' : '仅删除记录'}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={withFile}
              onChange={(event) => setWithFile(event.target.checked)}
              className={CHECKBOX_CLASS + ' mt-0.5'}
            />
            <span>
              <span className="font-medium text-slate-800 dark:text-slate-100">同时删除磁盘文件</span>
              <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                调用 DELETE /api/files/:id?withFile=1，删除后不可恢复，但会立即释放磁盘空间。
              </span>
            </span>
          </label>
          <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
            不勾选时只删除数据库记录，磁盘文件会保留（可通过管理端下载接口继续访问）。
          </p>
        </div>
      </Modal>

      {/* ---------------- 批量删除：三步确认（共用组件） ---------------- */}
      <DangerConfirmModal
        open={bulkOpen}
        title="全部删除（危险操作）"
        description={`已选中当前页 ${selectedFiles.length} 个文件 · 共 ${formatBytes(selectedBytes, '0 B')}`}
        items={selectedFiles.map((file) => ({
          id: file.id,
          name: file.name,
          hint: formatBytes(file.sizeBytes, '未知'),
        }))}
        rangeWarning={
          <>
            你即将删除 <strong>{selectedFiles.length}</strong> 个文件（共 {formatBytes(selectedBytes, '0 B')}）。
            这是不可撤销的危险操作，请先核对下面的清单。
          </>
        }
        step2Label="选择方式"
        step2Content={
          <>
            <p className="text-xs text-slate-500 dark:text-slate-400">选择删除方式（两种都不可撤销）：</p>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-slate-200 px-3 py-2.5 dark:border-slate-800">
              <input
                type="radio"
                name="bulk-mode"
                className="mt-0.5 h-4 w-4"
                checked={!bulkWithFile}
                onChange={() => setBulkWithFile(false)}
              />
              <span>
                <span className="font-medium text-slate-800 dark:text-slate-100">仅删除记录</span>
                <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                  数据库记录会消失，<strong>磁盘文件保留、空间不释放</strong>（之后可用「孤儿文件」排查找回）。
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-red-200 bg-red-50/50 px-3 py-2.5 dark:border-red-900/50 dark:bg-red-950/20">
              <input
                type="radio"
                name="bulk-mode"
                className="mt-0.5 h-4 w-4"
                checked={bulkWithFile}
                onChange={() => setBulkWithFile(true)}
              />
              <span>
                <span className="font-medium text-red-700 dark:text-red-300">同时删除磁盘文件</span>
                <span className="mt-0.5 block text-xs text-red-600/90 dark:text-red-300/80">
                  记录 + 文件一起删，<strong>立即释放空间</strong>；文件不可恢复，安卓端也再拿不到。
                </span>
              </span>
            </label>
          </>
        }
        finalSummary={
          <>
            最后确认：将删除 <strong>{selectedFiles.length}</strong> 个文件（
            {formatBytes(selectedBytes, '0 B')}），方式为
            <strong>{bulkWithFile ? '记录 + 磁盘文件（不可恢复）' : '仅删除记录（磁盘文件保留）'}</strong>。
          </>
        }
        executeLabel={`确认全部删除（${selectedFiles.length} 个）`}
        busy={bulkBusy}
        onClose={closeBulk}
        onConfirm={() => void handleBulkDelete()}
      />
    </div>
  )
}
