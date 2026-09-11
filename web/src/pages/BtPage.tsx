import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, FileArchive, Magnet, RefreshCw, ShieldAlert, Trash2, UploadCloud } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Table,
} from '../components/ui'
import type { Column } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { api, MODULE_LABELS } from '../lib/api'
import { seedStatusMeta, formatBytes, humanizeError } from '../lib/format'
import type { BtEvictSummary, BtStatus, SeedItem } from '../types'

export default function BtPage() {
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)

  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [seeds, setSeeds] = useState<SeedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState<BtStatus | null>(null)
  const [evictPreview, setEvictPreview] = useState<BtEvictSummary | null>(null)
  const [evicting, setEvicting] = useState(false)
  const [previewing, setPreviewing] = useState(false)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [seedsRes, statusRes] = await Promise.allSettled([api.btSeeds(), api.btStatus()])
      if (seedsRes.status === 'fulfilled') {
        setSeeds(seedsRes.value.items ?? [])
        setError(null)
      } else {
        setError((seedsRes.reason as Error).message)
      }
      if (statusRes.status === 'fulfilled') setStatus(statusRes.value)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(true), 15_000)
    return () => window.clearInterval(timer)
  }, [load])

  const upload = useCallback(
    async (file: File) => {
      if (!/\.zip$/i.test(file.name)) {
        toast.error('文件类型不支持', '请上传 .zip 格式的种子压缩包')
        return
      }
      setUploading(true)
      try {
        const res = await api.btUpload(file)
        toast.success('上传成功', `${res.zipName} · 解压出 ${res.extracted} 个种子`)
        setSeeds(res.seeds ?? [])
        void load(true)
      } catch (err) {
        toast.error('上传失败', humanizeError((err as { code?: string }).code ?? '', (err as Error).message))
      } finally {
        setUploading(false)
        if (fileRef.current) fileRef.current.value = ''
      }
    },
    [load, toast],
  )

  const runAction = async (ids: number[], action: 'enqueue' | 'delete' | 'refresh') => {
    if (!ids.length) {
      toast.warning('请先选择种子')
      return
    }
    setPending(true)
    try {
      await api.btSeedsAction(ids, action)
      const label = action === 'enqueue' ? '已入队' : action === 'delete' ? '已删除' : '已刷新'
      toast.success(label, `共 ${ids.length} 个种子`)
      setSelected([])
      await load(true)
    } catch (err) {
      toast.error('操作失败', humanizeError((err as { code?: string }).code ?? '', (err as Error).message))
    } finally {
      setPending(false)
    }
  }

  const allSelected = seeds.length > 0 && selected.length === seeds.length
  const toggleAll = () => setSelected(allSelected ? [] : seeds.map((seed) => seed.id))
  const toggleOne = (id: number) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )

  const columns: Column<SeedItem>[] = [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          checked={allSelected}
          onChange={toggleAll}
          aria-label="全选种子"
          className="h-4 w-4 cursor-pointer rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600"
        />
      ),
      className: 'w-10',
      render: (seed) => (
        <input
          type="checkbox"
          checked={selected.includes(seed.id)}
          onChange={() => toggleOne(seed.id)}
          aria-label={`选择 ${seed.name}`}
          className="h-4 w-4 cursor-pointer rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600"
        />
      ),
    },
    {
      key: 'name',
      header: '种子文件',
      render: (seed) => (
        <div className="min-w-0 max-w-[280px]">
          <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100" title={seed.name}>
            {seed.name}
          </p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400" title={seed.path}>
            {seed.path}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: '状态',
      render: (seed) => {
        const meta = seedStatusMeta(seed.status)
        return (
          <Badge tone={meta.tone} dot pulse={seed.status === 'downloading'}>
            {meta.label}
          </Badge>
        )
      },
    },
    {
      key: 'size',
      header: '视频+图片大小',
      render: (seed) => (
        <span className="whitespace-nowrap text-xs tabular-nums text-slate-600 dark:text-slate-300">
          {formatBytes(seed.sizeBytes, '未解析')}
        </span>
      ),
    },
    {
      key: 'files',
      header: '文件数',
      hideOnMobile: true,
      render: (seed) => (
        <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{seed.fileCount}</span>
      ),
    },
    {
      key: 'task',
      header: '关联任务',
      hideOnMobile: true,
      render: (seed) => (
        <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
          {seed.taskId ? `#${seed.taskId}` : '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      headerClassName: 'text-right',
      className: 'text-right',
      render: (seed) => (
        <div className="flex justify-end gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={pending || seed.status === 'downloading' || seed.status === 'done'}
            onClick={() => void runAction([seed.id], 'enqueue')}
          >
            入队
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => void runAction([seed.id], 'delete')}
            title="删除种子"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ),
    },
  ]

  const previewEvict = async () => {
    setPreviewing(true)
    try {
      const res = await api.btStale()
      setEvictPreview(res)
      toast.info('出清预览已生成', `检查 ${res.checked} 个任务：拟删除 ${res.evicted || res.candidates.filter((c) => c.decision === 'evict').length} 个、可挽救 ${res.candidates.filter((c) => c.decision === 'salvage').length} 个`)
    } catch (err) {
      toast.error('出清预览失败', humanizeError('', err instanceof Error ? err.message : String(err)))
    } finally {
      setPreviewing(false)
    }
  }

  const runEvict = async () => {
    setEvicting(true)
    try {
      const res = await api.btEvict()
      setEvictPreview(res)
      toast.success('出清已执行', `删除 ${res.evicted} 个、挽救 ${res.salvaged} 个、保留 ${res.kept} 个，释放 ${formatBytes(res.freedBytes)}`)
      void load()
    } catch (err) {
      toast.error('出清执行失败', humanizeError('', err instanceof Error ? err.message : String(err)))
    } finally {
      setEvicting(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">BT 种子下载</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {MODULE_LABELS.transmission}模块 · 上传 zip 种子包，解压后自动筛选视频/图片文件
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={status?.running ? 'success' : 'danger'} dot pulse={!!status?.running}>
            transmission {status?.running ? '运行中' : '未运行'}
          </Badge>
          {status?.version ? <Badge tone="neutral">v{status.version}</Badge> : null}
          <Badge tone="neutral">RPC {status ? `${status.rpc.host}:${status.rpc.port}` : '—'}</Badge>
          <Button variant="outline" size="sm" loading={loading} onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
        </div>
      </div>

      {/* BT 出清机制 */}
      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" /> BT 出清机制
            </span>
          }
          subtitle="只处理已获得足够下载尝试时间的任务：完全无资源 / 中途停滞 / 还有资源但极慢"
          action={
            <span className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" loading={previewing} onClick={() => void previewEvict()}>
                出清预览
              </Button>
              <Button variant="danger" size="sm" loading={evicting} onClick={() => void runEvict()}>
                立即出清
              </Button>
            </span>
          }
        />
        <div className="space-y-3">
          <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            规则：① 只有实际下载尝试满 <b>10 小时</b>（可在「设置」调整）的任务才参与判断；
            ② 进度 ≥ 79% 的视频按「未下完但可播放」处理 —— 移交归档并加密发布，<b>不删除</b>；
            ③ 其余无资源/停滞/极慢的任务会被删除，并同时清理 transmission 的
            <code className="mx-1 rounded bg-slate-200 px-1 dark:bg-slate-700">incomplete</code>
            目录；④ 每次出清都会广播「空间已腾挪」，等待队列立即重新评估。
          </p>
          {evictPreview ? (
            <div className="overflow-x-auto">
              <Table
                columns={[
                  { key: 'title', header: '任务', render: (c) => <span className="text-xs">{c.title}</span> },
                  { key: 'age', header: '尝试时长', render: (c) => <span className="text-xs tabular-nums">{c.ageHours} h</span> },
                  { key: 'progress', header: '进度', render: (c) => <span className="text-xs tabular-nums">{c.percent}%</span> },
                  { key: 'rate', header: '速率', render: (c) => <span className="text-xs tabular-nums">{formatBytes(c.rateBps)}/s</span> },
                  { key: 'peers', header: 'Peers', render: (c) => <span className="text-xs tabular-nums">{c.peers}</span> },
                  {
                    key: 'decision',
                    header: '处理',
                    render: (c) => (
                      <Badge tone={c.decision === 'evict' ? 'danger' : c.decision === 'salvage' ? 'warning' : 'neutral'}>
                        {c.decision === 'evict' ? '删除' : c.decision === 'salvage' ? '可播放→归档' : '保留'}
                      </Badge>
                    ),
                  },
                  { key: 'detail', header: '说明', render: (c) => <span className="text-xs text-slate-500 dark:text-slate-400">{c.detail}</span> },
                ]}
                rows={evictPreview.candidates}
                rowKey={(c) => c.taskId}
                empty="没有需要出清的任务"
              />
            </div>
          ) : (
            <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              点「出清预览」查看当前会被删除/挽救的任务（预览不会修改任何数据）。
            </p>
          )}
        </div>
      </Card>

      {/* 上传区 */}
      <Card>
        <CardHeader
          title="上传种子压缩包"
          subtitle="multipart/form-data，字段名 file，仅支持 .zip"
          action={<Badge tone="neutral">GET /api/bt/seeds</Badge>}
        />
        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            const file = event.dataTransfer.files?.[0]
            if (file) void upload(file)
          }}
          className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
            dragging
              ? 'border-brand-500 bg-brand-50/70 dark:bg-brand-500/10'
              : 'border-slate-200 dark:border-slate-700'
          }`}
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-300">
            <UploadCloud className="h-5 w-5" />
          </span>
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
            将 zip 种子包拖拽到此处
          </p>
          <p className="text-xs text-slate-400">或点击下方按钮选择文件（上传后自动解压到待下载目录）</p>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void upload(file)
            }}
          />
          <Button
            className="mt-1"
            loading={uploading}
            onClick={() => fileRef.current?.click()}
            icon={<FileArchive className="h-4 w-4" />}
          >
            选择 zip 文件
          </Button>
        </div>
      </Card>

      {/* 种子列表 */}
      <Card>
        <CardHeader
          title="种子列表"
          subtitle={`共 ${seeds.length} 个种子 · 已选择 ${selected.length} 个`}
          action={
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={pending || !selected.length}
                onClick={() => void runAction(selected, 'enqueue')}
              >
                <Magnet className="h-3.5 w-3.5" />
                批量入队
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => void runAction(seeds.map((seed) => seed.id), 'refresh')}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                刷新元数据
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={pending || !selected.length}
                onClick={() => void runAction(selected, 'delete')}
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除
              </Button>
            </div>
          }
        />

        {error ? (
          <ErrorState message={`加载种子列表失败：${error}`} onRetry={() => void load()} />
        ) : loading && !seeds.length ? (
          <LoadingBlock text="正在加载种子列表…" />
        ) : !seeds.length ? (
          <EmptyState
            title="暂无种子文件"
            description="上传 zip 种子包后，解压出的 .torrent 文件会显示在这里，可批量入队下载。"
            icon={<Magnet className="h-5 w-5" />}
          />
        ) : (
          <Table columns={columns} rows={seeds} rowKey={(seed) => seed.id} minWidthClass="min-w-[760px]" />
        )}

        <p className="mt-3 text-[11px] text-slate-400">
          只有视频与图片文件会被勾选下载；入队需要满足磁盘空间门控（可用空间 − 预留 ≥ 种子大小）。
        </p>
      </Card>
    </div>
  )
}
