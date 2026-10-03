import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { formatBytes } from '../lib/format'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DangerConfirmModal,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Table,
} from '../components/ui'
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
 * 种子文件**全程不自动删除**（用户要求），只有手动点「删除」才会删。
 * 新增：勾选 + 全选当前页 + 「全部删除」（走危险操作三步确认）。
 *
 * ⚠️ 如实说明删除的真实后果（2026-10-03 核对代码后确认）：
 *   `POST /api/bt/seeds/actions {action:'delete'}` 只在 `seed.path` 仍位于**待入队目录**
 *   （btzhongzi_nodownd）时才 `rm` 文件；而种子一入队，`moveSeedToQueued()` 就把 .torrent
 *   **移动**到留档目录并更新了 `seeds.path`（transmission.ts 的 line 541）。
 *   所以在这个页面上删除，**实际只删数据库记录**，留档的 .torrent 仍在磁盘上，
 *   transmission 里正在下载/已完成的任务与已下载文件也都不受影响。
 *   以前页面上的文案（"只有这里手动删除才会删"）与这个事实不符，已改。
 */
const STATUS_META: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'brand' }> = {
  queued: { label: '已入队（排队中）', tone: 'warning' },
  downloading: { label: '下载中', tone: 'brand' },
  done: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
}

const CHECKBOX_CLASS =
  'h-4 w-4 shrink-0 cursor-pointer rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600'

export default function BtQueuedPage() {
  const toast = useToast()
  const [seeds, setSeeds] = useState<SeedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)

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

  const selectedSeeds = useMemo(() => queued.filter((s) => selected.has(s.id)), [queued, selected])
  const allSelected = queued.length > 0 && queued.every((s) => selected.has(s.id))
  const someSelected = queued.some((s) => selected.has(s.id))

  // 列表刷新后剔除已不存在的 id（勾选不会残留在看不见的行上）
  useEffect(() => {
    setSelected((current) => {
      if (!current.size) return current
      const alive = new Set(seeds.map((s) => s.id))
      const next = new Set([...current].filter((id) => alive.has(id)))
      return next.size === current.size ? current : next
    })
  }, [seeds])

  const toggleOne = (id: number): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = (): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (allSelected) queued.forEach((s) => next.delete(s.id))
      else queued.forEach((s) => next.add(s.id))
      return next
    })
  }

  /** 单条删除：保留原有交互（只更正文案，避免说出与事实不符的后果） */
  const remove = async (seed: SeedItem) => {
    if (
      !window.confirm(
        `删除这条种子记录？\n\n${seed.name}\n\n` +
          `注意：只删除数据库记录；留档在 btzhongzi_yijingdownding/ 的 .torrent 不会被删，` +
          `transmission 里正在下载的任务也不受影响。`,
      )
    ) {
      return
    }
    setPending(true)
    try {
      await api.btSeedsAction([seed.id], 'delete')
      toast.success('已删除种子记录')
      await load(true)
    } catch (e) {
      toast.error('删除失败', (e as Error).message)
    } finally {
      setPending(false)
    }
  }

  /** 批量删除：走三步确认；接口本身支持数组，且逐条回报结果 */
  const handleBulkDelete = async () => {
    const ids = selectedSeeds.map((s) => s.id)
    if (!ids.length) return
    setPending(true)
    try {
      const res = await api.btSeedsAction(ids, 'delete')
      const failed = (res.results ?? []).filter((r) => !r.ok)
      if (failed.length) {
        toast.error(
          `部分删除失败：成功 ${ids.length - failed.length} 个、失败 ${failed.length} 个`,
          failed.map((f) => `#${f.id} ${f.message ?? '失败'}`).join('；'),
        )
      } else {
        toast.success(`已删除 ${ids.length} 条种子记录`, '留档的 .torrent 仍在磁盘上，未被删除')
      }
      setBulkOpen(false)
      setSelected(new Set())
      await load(true)
    } catch (e) {
      toast.error('批量删除失败', (e as Error).message)
    } finally {
      setPending(false)
    }
  }

  const columns: Column<SeedItem>[] = [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          className={CHECKBOX_CLASS}
          aria-label="全选当前页"
          title="全选当前页"
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = someSelected && !allSelected
          }}
          onChange={toggleAll}
        />
      ),
      className: 'w-10',
      render: (seed) => (
        <input
          type="checkbox"
          className={CHECKBOX_CLASS}
          aria-label={`选择 ${seed.name}`}
          checked={selected.has(seed.id)}
          onChange={() => toggleOne(seed.id)}
        />
      ),
    },
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
            transmission/btzhongzi_yijingdownding/ 留档 —— <strong>程序不会自动删种子文件</strong>。
            <br />
            这里的「删除」<strong>只删除数据库记录</strong>：留档的 .torrent 仍在磁盘上（不释放空间），
            transmission 里正在下载/已完成的任务与已下载文件也都不受影响。
          </p>
        </div>
        <Button variant="outline" size="sm" loading={loading} onClick={() => void load()} icon={<RefreshCw className="h-3.5 w-3.5" />}>
          刷新
        </Button>
      </div>

      <Card>
        <CardHeader title="已入队" subtitle={`共 ${queued.length} 个`} />

        {/* 批量操作栏 */}
        {queued.length ? (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  className={CHECKBOX_CLASS}
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected && !allSelected
                  }}
                  onChange={toggleAll}
                />
                全选当前页
              </label>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                已选 <strong className="tabular-nums text-slate-700 dark:text-slate-200">{selected.size}</strong> 个
              </span>
            </div>
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              disabled={!selected.size || pending}
              onClick={() => setBulkOpen(true)}
            >
              全部删除{selected.size ? `（${selected.size}）` : ''}
            </Button>
          </div>
        ) : null}

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
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className={CHECKBOX_CLASS + ' mt-1'}
                        aria-label={`选择 ${seed.name}`}
                        checked={selected.has(seed.id)}
                        onChange={() => toggleOne(seed.id)}
                      />
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
              <Table columns={columns} rows={queued} rowKey={(seed) => seed.id} minWidthClass="min-w-[760px]" />
            </div>
          </>
        )}
        {loading && queued.length ? (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-400">
            <Loader2 className="h-3 w-3 animate-spin" /> 刷新中…
          </p>
        ) : null}
      </Card>

      {/* 批量删除：三步确认（与文件页共用同一个危险操作弹窗） */}
      <DangerConfirmModal
        open={bulkOpen}
        title="全部删除（危险操作）"
        description={`已选中 ${selectedSeeds.length} 条已入队种子`}
        items={selectedSeeds.map((seed) => ({
          id: seed.id,
          name: seed.name,
          hint: seed.sizeBytes ? formatBytes(seed.sizeBytes, '未知') : undefined,
        }))}
        rangeWarning={
          <>
            你即将删除 <strong>{selectedSeeds.length}</strong> 条种子记录。请先核对下面的清单，
            确认没有把还要用的种子勾进来。
          </>
        }
        step2Label="确认影响"
        step2Content={
          <>
            <p className="text-xs text-slate-500 dark:text-slate-400">这次删除会 / 不会发生什么：</p>
            <ul className="space-y-2 text-xs">
              <li className="rounded-xl border border-red-200 bg-red-50/50 px-3 py-2 dark:border-red-900/50 dark:bg-red-950/20">
                <strong className="text-red-700 dark:text-red-300">会删除</strong>
                <span className="mt-0.5 block text-red-600/90 dark:text-red-300/80">
                  这 {selectedSeeds.length} 条**数据库记录**（列表里不再出现）。
                </span>
              </li>
              <li className="rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-800">
                <strong className="text-slate-800 dark:text-slate-100">不会删除</strong>
                <span className="mt-0.5 block text-slate-500 dark:text-slate-400">
                  留档在 transmission/btzhongzi_yijingdownding/ 的 <code>.torrent</code> 文件仍在磁盘上
                  （<strong>不会因此释放空间</strong>）；transmission 里正在下载/已完成的任务、以及已经下载到磁盘的视频文件，
                  都不受影响。
                </span>
              </li>
            </ul>
          </>
        }
        finalSummary={
          <>
            最后确认：将删除 <strong>{selectedSeeds.length}</strong> 条种子记录 ——
            只删记录，不删留档的 .torrent，也不动正在下载的任务。
          </>
        }
        executeLabel={`确认全部删除（${selectedSeeds.length} 个）`}
        busy={pending}
        onClose={() => {
          if (!pending) setBulkOpen(false)
        }}
        onConfirm={() => void handleBulkDelete()}
      />
    </div>
  )
}
