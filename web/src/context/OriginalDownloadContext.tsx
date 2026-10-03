import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Download, Loader2, Lock, X } from 'lucide-react'
import { api } from '../lib/api'
import { formatBytes } from '../lib/format'
import { Button, Modal } from '../components/ui'
import { useToast } from './ToastContext'
import type { OriginalJob, OriginalStatus, PublishedFile } from '../types'

/**
 * 「下载原始文件」的全局状态。
 *
 * 为什么必须是**全局**（挂在 AppLayout 上，而不是文件页里）：
 *   解密几个 GB 要几十秒到几分钟，用户明确要求"这个 loading 不能影响我去别的页面"。
 *   状态放在布局层 → 切到 BT / 问题反馈 / 设置页都不会中断轮询和下载。
 *
 * 流程：点「下载原始文件」→（若 15 分钟内已验过密码就直接开始；否则弹 6 位密码框）
 *   → 后台解密（悬浮面板显示进度）→ 就绪后自动触发浏览器下载 → 服务端删掉临时文件。
 */

interface OriginalCtx {
  status: OriginalStatus | null
  jobs: OriginalJob[]
  /** 点「下载原始文件」：需要密码就先弹框，验过之后自动继续 */
  downloadOriginal: (file: PublishedFile) => void
}

const Ctx = createContext<OriginalCtx | null>(null)

export function useOriginalDownload(): OriginalCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useOriginalDownload 必须在 OriginalDownloadProvider 内使用')
  return c
}

export function OriginalDownloadProvider({ children }: { children: ReactNode }) {
  const toast = useToast()
  const [status, setStatus] = useState<OriginalStatus | null>(null)
  const [jobs, setJobs] = useState<OriginalJob[]>([])
  const [pending, setPending] = useState<PublishedFile | null>(null)   // 等密码的那个文件
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [codeError, setCodeError] = useState<string | null>(null)
  /** 已经自动触发过下载的任务（避免轮询时反复触发） */
  const autoDownloaded = useRef<Set<string>>(new Set())

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.originalStatus())
    } catch {
      /* 拉不到就先不管（未登录/网络抖动）*/
    }
  }, [])

  const refreshJobs = useCallback(async () => {
    try {
      const r = await api.originalJobs()
      setJobs(r.jobs ?? [])
    } catch {
      /* 同上 */
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
    void refreshJobs()
  }, [refreshStatus, refreshJobs])

  /**
   * 解锁状态只存在服务端**内存**里（进程重启即清空），所以本地缓存必须定期/回到前台时刷新，
   * 否则一旦服务端重启过，这边会一直"以为已解锁"，点按钮就报"请先输入下载密码"。
   */
  useEffect(() => {
    const bump = (): void => {
      if (document.visibilityState === 'visible') void refreshStatus()
    }
    const timer = window.setInterval(() => void refreshStatus(), 60_000)
    window.addEventListener('focus', bump)
    document.addEventListener('visibilitychange', bump)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', bump)
      document.removeEventListener('visibilitychange', bump)
    }
  }, [refreshStatus])

  // 有任务在跑就轮询（1 秒一次）；全都结束后停止轮询，别空转
  const active = jobs.some((j) => j.state === 'decrypting')
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => {
      void refreshJobs()
    }, 1000)
    return () => window.clearInterval(timer)
  }, [active, refreshJobs])

  /**
   * 就绪 → 自动触发浏览器下载。
   * 用 <a download> 直接打后端接口（而不是 fetch+blob）：几 GB 的文件不能进内存，
   * 而且原生下载才能正确使用服务端 Content-Disposition 里的原始文件名。
   */
  useEffect(() => {
    for (const job of jobs) {
      if (job.state !== 'ready' || autoDownloaded.current.has(job.id)) continue
      autoDownloaded.current.add(job.id)
      const a = document.createElement('a')
      a.href = api.originalDownloadUrl(job.id)
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      toast.success('原始文件已就绪，开始下载', `${job.originalName}（${formatBytes(job.contentBytes)}）· 下载完成后服务器会自动删除临时文件`)
    }
  }, [jobs, toast])

  /**
   * 发起解密任务。
   *
   * ⚠️ 必须能**自愈**：`status.unlocked` 是浏览器里缓存的值，而服务端的解锁记录只存在内存里
   *（进程重启即清空）。只要服务端重启过（部署 / 断电 / 崩溃），本地缓存就会"以为已解锁"，
   * 直接建任务必拿到 403 ORIGINAL_LOCKED —— 旧版这里只弹了个 error toast、**永远不弹密码框**，
   * 用户就彻底卡住了。所以：拿到 ORIGINAL_LOCKED 就刷新状态并**把密码框弹出来**。
   */
  const startJob = useCallback(
    async (file: PublishedFile) => {
      try {
        await api.originalStart(file.id)
        toast.info('正在临时解密…', `${file.name} · 可以去做别的事，解完会自动开始下载`)
        await refreshJobs()
      } catch (e) {
        const err = e as { code?: string; message?: string }
        if (err.code === 'ORIGINAL_LOCKED') {
          // 服务端说"还没输密码" → 立刻让用户输，而不是干报错
          await refreshStatus()
          setPending(file)
          setCode('')
          setCodeError('需要下载密码（服务端重启后需要重新输入）')
          return
        }
        if (err.code === 'ORIGINAL_DL_DISABLED') {
          await refreshStatus()
          toast.error('该功能未启用', '服务器 .env 里没有 ORIGINAL_DL_SECRET，请先在服务器上生成并重启服务')
          return
        }
        toast.error('无法开始解密', err.message ?? '未知错误')
      }
    },
    [refreshJobs, refreshStatus, toast],
  )

  const downloadOriginal = useCallback(
    (file: PublishedFile) => {
      if (status && !status.enabled) {
        toast.error('该功能未启用', '服务器 .env 里没有 ORIGINAL_DL_SECRET，请先在服务器上生成并重启服务')
        return
      }
      if (status?.unlocked) {
        void startJob(file)
        return
      }
      setPending(file)
      setCode('')
      setCodeError(null)
    },
    [startJob, status, toast],
  )

  const submitCode = useCallback(async () => {
    if (!pending) return
    if (!/^\d{6}$/.test(code.trim())) {
      setCodeError('请输入 6 位数字')
      return
    }
    setBusy(true)
    setCodeError(null)
    try {
      await api.originalUnlock(code.trim())
      const file = pending
      setPending(null)
      setCode('')
      await refreshStatus()
      await startJob(file)
    } catch (e) {
      setCodeError((e as Error).message || '密码不正确')
    } finally {
      setBusy(false)
    }
  }, [code, pending, refreshStatus, startJob])

  const cancelJob = useCallback(
    async (job: OriginalJob) => {
      try {
        await api.originalCancel(job.id)
        await refreshJobs()
        toast.info('已取消', '临时文件已删除')
      } catch (e) {
        toast.error('取消失败', (e as Error).message)
      }
    },
    [refreshJobs, toast],
  )

  return (
    <Ctx.Provider value={{ status, jobs, downloadOriginal }}>
      {children}

      {/* ---------------- 悬浮进度面板：不挡路、切页也在 ---------------- */}
      {jobs.length > 0 ? (
        <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-[min(94vw,26rem)] flex-col gap-2">
          {jobs.map((job) => {
            const pct = Math.max(0, Math.min(100, job.progress || 0))
            const done = job.state === 'ready'
            const failedJob = job.state === 'failed'
            return (
              <div
                key={job.id}
                className={
                  'pointer-events-auto rounded-2xl border bg-white/95 p-3 shadow-lg backdrop-blur dark:bg-slate-900/95 ' +
                  (failedJob ? 'border-red-200 dark:border-red-900/60' : done ? 'border-emerald-200 dark:border-emerald-900/60' : 'border-slate-200 dark:border-slate-700')
                }
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0">
                    {failedJob ? (
                      <AlertTriangle className="h-4 w-4 text-red-500" />
                    ) : done ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <Loader2 className="h-4 w-4 animate-spin text-brand-500" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-slate-800 dark:text-slate-100" title={job.originalName}>
                      {job.originalName || `文件 #${job.fileId}`}
                    </p>
                    {failedJob ? (
                      <p className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">{job.error ?? '解密失败'}</p>
                    ) : done ? (
                      <p className="mt-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                        已开始下载（{formatBytes(job.contentBytes)}）· 下载完成后自动删除临时文件
                      </p>
                    ) : (
                      <>
                        <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                          正在解密 {pct}%{job.expectedBytes ? ` · ${formatBytes(job.expectedBytes)}` : ''} · 可以去做别的事
                        </p>
                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                          <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {done ? (
                      <a
                        href={api.originalDownloadUrl(job.id)}
                        className="inline-flex h-7 items-center gap-1 rounded-lg border border-slate-200 px-2 text-[11px] font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        <Download className="h-3 w-3" />
                        重新下载
                      </a>
                    ) : null}
                    <button
                      type="button"
                      title={done ? '关闭（临时文件会在下载完成后自动删除）' : '取消并删除临时文件'}
                      onClick={() => void cancelJob(job)}
                      className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}

      {/* ---------------- 6 位下载密码 ---------------- */}
      <Modal
        open={pending !== null}
        title="下载原始文件"
        description={pending ? `${pending.name}（${formatBytes(pending.sizeBytes)}）将被临时解密成原始文件` : ''}
        onClose={() => (busy ? undefined : setPending(null))}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setPending(null)} disabled={busy}>
              取消
            </Button>
            <Button loading={busy} onClick={() => void submitCode()}>
              确认
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
          <div className="flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
            <Lock className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>
              请输入 <strong>6 位数字下载密码</strong>。它每{' '}
              {status ? Math.round(status.codeWindowSec / 60) : 15} 分钟自动换一次；
              在服务器上执行 <code className="rounded bg-slate-200/70 px-1 dark:bg-slate-700">sudo ./deploy.sh --orig-code</code> 可以查看当前密码。
              输对之后 15 分钟内不再询问。
            </span>
          </div>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={code}
            autoFocus
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitCode()
            }}
            placeholder="000000"
            className="h-12 w-full rounded-xl border border-slate-200 bg-white text-center font-mono text-2xl tracking-[0.5em] text-slate-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          {codeError ? <p className="text-xs text-red-600 dark:text-red-400">{codeError}</p> : null}
          <p className="text-[11px] text-slate-400 dark:text-slate-500">
            解密出来的文件是临时文件：下载完成后服务器会立刻删除；若无法确认下载完成，最多保留 1 小时。
          </p>
        </div>
      </Modal>
    </Ctx.Provider>
  )
}
