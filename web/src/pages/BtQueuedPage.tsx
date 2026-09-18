import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { formatBytes } from '../lib/format'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Table } from '../components/ui'
import type { Column } from '../components/ui'
import { useToast } from '../context/ToastContext'
import type { SeedItem } from '../types'

/**
 * 「已入队种子」—— BT 种子页的二级页面。
 *
 * 需求：种子上传解析后进"待入队"列表；**点过"批量入队"的不要再留在那个列表里**，
 * 挪到这个二级页面看。对应的 .torrent 文件也在入队时**移动**到
 * /ttdownload/transmission/btzhongzi_yijingdownding/ 留档。
 *
 * 种子文件**全程不自动删除**（用户要求），只有这里手动点「删除」才会删。
 */
const STATUS_META: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'brand' }> = {
  queued: { label: '已入队（排队中）', tone: 'warning' },
  downloading: { label: '下载中', tone: 'brand' },
  done: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
}

export default function BtQueuedPage() {
  const toast = useToast()
  const [seeds, setSeeds] = useState<SeedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await api.btSeeds()
      setSeeds(res.items ?? [])
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const queued = useMemo(() => seeds.filter((s) => s.status !== 'pending'), [seeds])

  const remove = async (seed: SeedItem) => {
    if (!window.confirm(`删除这个种子记录和服务器上的 .torrent 文件？\n\n${seed.name}`)) return
    setPending(true)
    try {
      await api.btSeedsAction([seed.id], 'delete')
      toast.success('已删除种子')
      await load(true)
    } catch (e) {
      toast.error('删除失败', (e as Error).message)
    } finally {
      setPending(false)
    }
  }

  const columns: Column<SeedItem>[] = [
    {
      key: 'name',
      header: '种子',
      render: (seed) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100" title={seed.name}>
            {seed.name}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-slate-400" title={seed.path}>
            {seed.path}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: '状态',
      render: (seed) => {
        const m = STATUS_META[seed.status] ?? { label: seed.status, tone: 'neutral' as const }
        return <Badge tone={m.tone}>{m.label}</Badge>
      },
    },
    {
      key: 'size',
      header: '大小',
      render: (seed) => (
        <span className="whitespace-nowrap text-xs tabular-nums text-slate-500 dark:text-slate-400">
          {seed.sizeBytes ? formatBytes(seed.sizeBytes, '未知') : '未知'}
        </span>
      ),
    },
    {
      key: 'files',
      header: '文件数',
      render: (seed) => <span className="text-xs tabular-nums text-slate-500">{seed.fileCount || '—'}</span>,
    },
    {
      key: 'actions',
      header: '',
      render: (seed) => (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => void remove(seed)}
            icon={<Trash2 className="h-3.5 w-3.5" />}
          >
            删除
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            to="/bt"
            className="mb-1 inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-400"
          >
            <ArrowLeft className="h-3 w-3" />
            返回 BT 种子
          </Link>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">已入队种子</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            已经入队的种子从「待入队」列表挪到这里；对应的 .torrent 已移动到
            transmission/btzhongzi_yijingdownding/ 留档 —— <strong>程序不会自动删种子文件</strong>，
            只有这里手动删除才会删。
          </p>
        </div>
        <Button variant="outline" size="sm" loading={loading} onClick={() => void load()} icon={<RefreshCw className="h-3.5 w-3.5" />}>
          刷新
        </Button>
      </div>

      <Card>
        <CardHeader title="已入队" subtitle={`共 ${queued.length} 个`} />
        {error ? (
          <ErrorState message={`加载失败：${error}`} onRetry={() => void load()} />
        ) : loading && !queued.length ? (
          <LoadingBlock text="正在加载已入队种子…" />
        ) : !queued.length ? (
          <EmptyState title="还没有已入队的种子" description="在「BT 种子」页选种子点「批量入队」后，它们会出现在这里。" />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 md:hidden">
              {queued.map((seed) => {
                const m = STATUS_META[seed.status] ?? { label: seed.status, tone: 'neutral' as const }
                return (
                  <div key={seed.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 dark:text-slate-100" title={seed.name}>
                        {seed.name}
                      </p>
                      <Badge tone={m.tone}>{m.label}</Badge>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {seed.sizeBytes ? formatBytes(seed.sizeBytes, '未知') : '未知'} · {seed.fileCount || 0} 个文件
                    </p>
                    <div className="mt-2 flex justify-end">
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => void remove(seed)} icon={<Trash2 className="h-3.5 w-3.5" />}>
                        删除
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="hidden md:block">
              <Table columns={columns} rows={queued} rowKey={(seed) => seed.id} minWidthClass="min-w-[720px]" />
            </div>
          </>
        )}
        {loading && queued.length ? (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-400">
            <Loader2 className="h-3 w-3 animate-spin" /> 刷新中…
          </p>
        ) : null}
      </Card>
    </div>
  )
}
