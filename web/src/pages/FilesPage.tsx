import { useCallback, useEffect, useState } from 'react'
import { Download, FileVideo2, HardDrive, Search, Trash2, X } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Input,
  LoadingBlock,
  Modal,
  Pagination,
  StatCard,
  Table,
} from '../components/ui'
import type { Column } from '../components/ui'
import { useFileEvents } from '../context/AppDataContext'
import { useToast } from '../context/ToastContext'
import { useDebouncedValue, useFiles } from '../hooks/useAsync'
import { api, MODULE_LABELS } from '../lib/api'
import { formatBytes, formatDateTime, humanizeError } from '../lib/format'
import type { PublishedFile } from '../types'

const PAGE_SIZE = 20

export default function FilesPage() {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const debouncedQuery = useDebouncedValue(query, 350)
  const { items, total, totalBytes, loading, error, refresh, setItems } = useFiles({
    q: debouncedQuery,
    page,
    pageSize: PAGE_SIZE,
  })

  const [target, setTarget] = useState<PublishedFile | null>(null)
  const [withFile, setWithFile] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // 新发布文件时自动刷新
  useFileEvents(() => {
    void refresh()
  })

  useEffect(() => {
    setPage(1)
  }, [debouncedQuery])

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

  const downloadedCount = items.filter((item) => item.downloaded).length

  const columns: Column<PublishedFile>[] = [
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
                待下载
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
            <a
              href={api.fileDownloadUrl(file.id, file.name)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-slate-200 px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <Download className="h-3.5 w-3.5" />
              下载
            </a>
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

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">已发布文件</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            消费者目录中的加密成品 · 安卓端轮询 GET /api/android/files 后下载
          </p>
        </div>
        <Button variant="outline" size="sm" loading={loading} onClick={() => void refresh()}>
          刷新
        </Button>
      </div>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard
          label="文件总数"
          value={total}
          tone="brand"
          icon={<FileVideo2 className="h-4 w-4" />}
        />
        <StatCard
          label="总占用空间"
          value={formatBytes(totalBytes, '0 B')}
          tone="neutral"
          icon={<HardDrive className="h-4 w-4" />}
        />
        <StatCard
          label="本页已下载"
          value={`${downloadedCount} / ${items.length}`}
          tone="success"
          icon={<Download className="h-4 w-4" />}
          className="col-span-2 lg:col-span-1"
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

        {error ? (
          <ErrorState message={`加载文件列表失败：${error}`} onRetry={() => void refresh()} />
        ) : loading && !items.length ? (
          <LoadingBlock text="正在加载已发布文件…" />
        ) : !items.length ? (
          <EmptyState
            title={query ? '没有匹配的文件' : '暂无已发布文件'}
            description={
              query
                ? '换个关键词试试，或清空搜索查看全部文件。'
                : '任务完成归档并加密后，成品会出现在这里，安卓端即可拉取下载。'
            }
            icon={<FileVideo2 className="h-5 w-5" />}
          />
        ) : (
          <>
            <Table columns={columns} rows={items} rowKey={(file) => file.id} minWidthClass="min-w-[760px]" />
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
          </>
        )}
      </Card>

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
              className="mt-0.5 h-4 w-4 cursor-pointer rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600"
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
    </div>
  )
}
