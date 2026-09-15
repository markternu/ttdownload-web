import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Code2,
  Copy,
  ExternalLink,
  FileArchive,
  Globe,
  Loader2,
  Magnet,
  RefreshCw,
  ShieldAlert,
  Trash2,
  UploadCloud,
  XCircle,
} from 'lucide-react'
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
import { cn } from '../lib/cn'
import { seedStatusMeta, formatBytes, humanizeError } from '../lib/format'
import type { BtEvictSummary, BtProxyPreview, BtProxyStatus, BtStatus, SeedItem } from '../types'

/**
 * 反向代理开关（按钮 + role="switch"）。
 * 开 = 绿色，关 = 灰色；切换中显示 loading 并禁用，避免重复提交。
 */
function ProxySwitch({
  checked,
  loading = false,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean
  loading?: boolean
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled || loading}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900',
        'disabled:cursor-not-allowed disabled:opacity-60',
        checked ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600',
      )}
    >
      {loading ? (
        <Loader2
          className={cn(
            'absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-white',
            checked ? 'right-1.5' : 'left-1.5',
          )}
          aria-hidden
        />
      ) : (
        <span
          className={cn(
            'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0.5',
          )}
        />
      )}
    </button>
  )
}

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

  /** transmission 反向代理（远程访问 9091） */
  const [btProxy, setBtProxy] = useState<BtProxyStatus | null>(null)
  const [proxyToggling, setProxyToggling] = useState(false)
  const [proxyPreview, setProxyPreview] = useState<BtProxyPreview | null>(null)
  const [proxyPreviewing, setProxyPreviewing] = useState(false)
  /** 「我已了解风险，仍要开启」复选框（transmission 未设 RPC 密码时才需要） */
  const [proxyForce, setProxyForce] = useState(false)
  const [proxyError, setProxyError] = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [seedsRes, statusRes, proxyRes] = await Promise.allSettled([
        api.btSeeds(),
        api.btStatus(),
        api.btProxy(),
      ])
      if (seedsRes.status === 'fulfilled') {
        setSeeds(seedsRes.value.items ?? [])
        setError(null)
      } else {
        setError((seedsRes.reason as Error).message)
      }
      if (statusRes.status === 'fulfilled') setStatus(statusRes.value)
      if (proxyRes.status === 'fulfilled') setBtProxy(proxyRes.value)
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

  /* -------------------- transmission 反向代理（远程访问 9091） -------------------- */

  /** transmission 连得上且没有设 RPC 密码 → 开启需要用户显式确认风险 */
  const proxyNeedsForce = !!btProxy?.transmission.reachable && btProxy?.transmission.authRequired === false

  const errText = (err: unknown) =>
    err instanceof Error && err.message ? err.message : String(err)

  const toggleProxy = async (next: boolean) => {
    if (proxyToggling) return
    if (next && proxyNeedsForce && !proxyForce) {
      toast.warning(
        '需要先确认风险',
        '当前 transmission 没有设置 RPC 密码，开启后任何人都能控制你的 BT。请先勾选「我已了解风险，仍要开启」再开启',
      )
      return
    }
    setProxyToggling(true)
    setProxyError(null)
    try {
      const res = await api.btProxyToggle({
        enabled: next,
        force: next && proxyNeedsForce ? true : undefined,
      })
      setBtProxy(res)
      setProxyPreview(null)
      setProxyForce(false)
      if (next) {
        toast.success('已开启反向代理', res.url ? `外网可直接访问 ${res.url}` : 'nginx 配置已写入并 reload')
      } else {
        toast.success(
          '已关闭反向代理',
          `已从 nginx 中彻底删除 ${res.subPath} 的反代配置，外界无法再访问 ${res.target}`,
        )
      }
      void load(true)
    } catch (err) {
      // 后端会在 error.message 里说明原因（未设密码 / nginx -t 失败已回滚），必须原样展示
      const message = errText(err)
      setProxyError(message)
      toast.error(next ? '开启失败' : '关闭失败', message)
    } finally {
      setProxyToggling(false)
    }
  }

  const copyProxyUrl = async () => {
    const text = btProxy?.url
    if (!text) {
      toast.warning('暂无访问地址', '请先开启反向代理，并确认是通过域名/IP 访问本页面')
      return
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        // 非安全上下文（http）下没有 clipboard API → select + execCommand 兜底
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        let ok = false
        try {
          ok = document.execCommand('copy')
        } finally {
          document.body.removeChild(area)
        }
        if (!ok) throw new Error('当前浏览器不允许自动复制')
      }
      toast.success('已复制', text)
    } catch (err) {
      toast.error('复制失败', `请手动复制：${text}（${errText(err)}）`)
    }
  }

  const openProxyUrl = () => {
    const url = btProxy?.url
    if (!url) {
      toast.warning('暂无访问地址', '请先开启反向代理，并确认是通过域名/IP 访问本页面')
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const previewProxy = async () => {
    setProxyPreviewing(true)
    try {
      const res = await api.btProxyPreview()
      setProxyPreview(res)
      toast.info('配置预览已生成', '预览只读取脚本输出，不会修改服务器上的任何文件')
    } catch (err) {
      toast.error('预览失败', errText(err))
    } finally {
      setProxyPreviewing(false)
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

      {/* transmission 反向代理（远程访问 9091）—— 放在最上面：远程打不开 transmission 多半就是它 */}
      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <Globe className="h-4 w-4" /> transmission 反向代理（远程访问 9091）
            </span>
          }
          subtitle={`远程服务器通常只开放 22/80/443，transmission 的 WebUI/RPC 只在 ${
            btProxy?.target ?? '本机 9091 端口'
          } 上，外网直接访问不到；开启后在 nginx 里新增一段配置，把 ${
            btProxy?.subPath ?? '/transmission'
          }/ 反代到它，即可用域名直接打开`}
          action={
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'text-xs font-medium',
                  btProxy?.enabled
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-slate-500 dark:text-slate-400',
                )}
              >
                {btProxy?.enabled ? '已开启' : '已关闭'}
              </span>
              <ProxySwitch
                checked={!!btProxy?.enabled}
                loading={proxyToggling}
                disabled={!btProxy || (!btProxy.available && !btProxy.enabled)}
                label="transmission 反向代理开关"
                onChange={(next) => void toggleProxy(next)}
              />
            </span>
          }
        />

        <div className="space-y-3">
          {/* 状态徽章 */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">
              {btProxy?.nginxVersion ? btProxy.nginxVersion : '未检测到 nginx'}
            </Badge>
            <Badge
              tone={btProxy?.transmission.reachable ? 'success' : 'danger'}
              dot
              pulse={!!btProxy?.transmission.reachable}
            >
              transmission {btProxy?.transmission.reachable ? '可达' : '不可达'}
            </Badge>
            <Badge tone="neutral">目标 {btProxy?.target ?? '—'}</Badge>
            <Badge tone={btProxy?.enabled ? 'success' : 'neutral'}>
              {btProxy?.enabled ? '反代已生效' : '反代未开启'}
            </Badge>
            {btProxy?.transmission.version ? (
              <Badge tone="neutral">v{btProxy.transmission.version}</Badge>
            ) : null}
            {btProxy?.enabledSubPaths.length ? (
              <Badge tone="info">已生效子路径 {btProxy.enabledSubPaths.join(' ')}</Badge>
            ) : null}
          </div>

          {/* 不能自动配置的原因（红色小字） */}
          {btProxy?.reason ? (
            <p className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">{btProxy.reason}</span>
            </p>
          ) : null}

          {/* 脚本缺失 */}
          {btProxy && !btProxy.scriptFound ? (
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
              服务器上找不到反代脚本
              <code className="mx-1 rounded bg-amber-100 px-1 font-mono text-[11px] dark:bg-amber-500/20">
                {btProxy.scriptPath}
              </code>
              ，请先在服务器上执行
              <code className="mx-1 rounded bg-amber-100 px-1 font-mono text-[11px] dark:bg-amber-500/20">
                sudo ./deploy.sh --update
              </code>
              同步最新代码后再试。
            </p>
          ) : null}

          {/* 后端写入的警告，原样展示 */}
          {btProxy?.warnings.map((warning, index) => (
            <p
              key={`${index}-${warning}`}
              className="flex items-start gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">{warning}</span>
            </p>
          ))}

          {/* 无 RPC 密码：红色警示 + 风险确认复选框 */}
          {proxyNeedsForce ? (
            <div className="space-y-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 dark:border-red-900/60 dark:bg-red-500/10">
              <p className="flex items-start gap-1.5 text-xs font-medium text-red-700 dark:text-red-300">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 break-words">
                  危险：transmission 没有设置 RPC 密码（rpc-authentication-required=false）。开启反代后，任何能访问到该地址的人都能控制你的 BT（删除任务、修改下载目录、查看内容）。请先在 transmission 里设置用户名/密码，再开启。
                </span>
              </p>
              <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-red-700 dark:text-red-300">
                <input
                  type="checkbox"
                  checked={proxyForce}
                  onChange={(event) => setProxyForce(event.target.checked)}
                  className="h-4 w-4 cursor-pointer rounded border-red-300 text-red-600 focus:ring-red-500 dark:border-red-700"
                />
                我已了解风险，仍要开启
              </label>
            </div>
          ) : null}

          {/* 开启 / 关闭 两种状态的说明 */}
          {btProxy?.enabled ? (
            <div className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-3 dark:border-emerald-900/60 dark:bg-emerald-500/10">
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                外网访问地址（点「打开」直接进 transmission WebUI）
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <code
                  className="min-w-0 flex-1 truncate rounded-lg bg-white px-2.5 py-2 font-mono text-sm text-slate-800 dark:bg-slate-900 dark:text-slate-100"
                  title={btProxy.url ?? ''}
                >
                  {btProxy.url ?? '（未取到访问地址，请确认是通过域名/IP 访问本页面）'}
                </code>
                <Button size="sm" variant="outline" disabled={!btProxy.url} onClick={() => void copyProxyUrl()}>
                  <Copy className="h-3.5 w-3.5" />
                  复制
                </Button>
                <Button size="sm" variant="primary" disabled={!btProxy.url} onClick={openProxyUrl}>
                  <ExternalLink className="h-3.5 w-3.5" />
                  打开
                </Button>
              </div>
              <p className="break-words text-[11px] leading-relaxed text-emerald-700/90 dark:text-emerald-300/90">
                transmission WebUI 会要求登录
                {btProxy.transmission.rpcUser ? (
                  <>
                    ，用户名是
                    <code className="mx-1 rounded bg-white/70 px-1 font-mono dark:bg-slate-900">
                      {btProxy.transmission.rpcUser}
                    </code>
                  </>
                ) : null}
                ；密码是部署脚本（
                <code className="rounded bg-white/70 px-1 font-mono dark:bg-slate-900">deploy.sh</code> /{' '}
                <code className="rounded bg-white/70 px-1 font-mono dark:bg-slate-900">ubuntutr.sh</code>
                ）安装时输出/设置的那个 RPC 密码。
                {btProxy.rpcUrl ? (
                  <>
                    {' '}
                    RPC 地址：
                    <code className="mx-0.5 rounded bg-white/70 px-1 font-mono dark:bg-slate-900">
                      {btProxy.rpcUrl}
                    </code>
                  </>
                ) : null}
              </p>
            </div>
          ) : (
            <div className="space-y-1.5 rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
              <p>
                开启后会在 nginx 里新增一段配置，把{' '}
                <code className="rounded bg-slate-200 px-1 font-mono dark:bg-slate-700">
                  {btProxy?.subPath ?? '/transmission'}/
                </code>{' '}
                反向代理到{' '}
                <code className="rounded bg-slate-200 px-1 font-mono dark:bg-slate-700">
                  {btProxy?.target ?? '—'}
                </code>
                ，于是外网可以直接打开 transmission WebUI（9091 本身仍然只监听本机）。
              </p>
              <p>
                关闭会把这段配置<b>彻底删除</b>：不是用防火墙拦住，而是 nginx 配置里真的没有它了，外界再也访问不到 9091。
              </p>
            </div>
          )}

          {/* 后端返回的失败原因（toast 之外再留在页面上） */}
          {proxyError ? (
            <p className="flex items-start gap-1.5 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 whitespace-pre-wrap break-words">
                上一次操作失败：{proxyError}
              </span>
            </p>
          ) : null}

          {/* 预览配置 */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                loading={proxyPreviewing}
                onClick={() => void previewProxy()}
              >
                <Code2 className="h-3.5 w-3.5" />
                预览配置
              </Button>
              <span className="text-[11px] text-slate-400">
                预览只打印将要写入的配置，不会修改服务器上的任何文件。
              </span>
            </div>
            {proxyPreview ? (
              <div className="space-y-2">
                <p className="text-xs text-slate-500 dark:text-slate-400">将要写入的 nginx 配置全文：</p>
                <pre className="max-h-72 overflow-auto rounded-xl bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100 dark:bg-slate-950 dark:text-slate-200">
                  {proxyPreview.config || '（脚本没有输出配置内容）'}
                </pre>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  插入到 {btProxy?.serverFile || 'nginx 主配置'} 的那一行：
                </p>
                <pre className="overflow-x-auto rounded-xl bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100 dark:bg-slate-950 dark:text-slate-200">
                  {proxyPreview.include || '（无）'}
                </pre>
              </div>
            ) : null}
          </div>
        </div>
      </Card>

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
