import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  Copy,
  GitBranch,
  RefreshCw,
  RotateCcw,
  Terminal,
} from 'lucide-react'
import { Badge, Button, Card, CardHeader, Spinner, Switch } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { api } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { cn } from '../lib/cn'
import type { UpdateStatus } from '../types'

/** ISO → 「2026-10-08 10:41」 */
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 「更新」页 —— 用户自己点「检查更新 / 立即更新」的地方。
 *
 * 这里要讲清楚三件事（用户最关心的）：
 *   1. 现在是哪个版本、远端是哪个版本；
 *   2. 升级**不会**损坏正在下载的任务：会先暂停、升完自动恢复；
 *   3. 升级过程服务会重启，页面会短暂断开（1~3 分钟），刷新即可。
 */
export default function UpdatePage() {
  const toast = useToast()
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)

  const load = useCallback(async () => {
    try {
      const st = await api.updateStatus()
      setStatus(st)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    // 升级期间服务会重启，页面自动重连后刷新状态
    const timer = window.setInterval(() => void load(), 15000)
    return () => window.clearInterval(timer)
  }, [load])

  const onCheck = async () => {
    setChecking(true)
    try {
      const st = await api.updateCheck()
      setStatus(st)
      if (st.error) toast.error('检查失败', st.error)
      else if (st.versionNewer) toast.success(`发现新版本 ${st.latestVersion}`, st.message)
      else if (st.versionUnchanged) toast.warning('远端有新提交但版本号没抬', st.message)
      else toast.success('已是最新版本', `当前 v${st.currentVersion}`)
    } catch (e) {
      toast.error('检查更新失败', (e as Error).message)
    } finally {
      setChecking(false)
    }
  }

  const onApply = async (force = false) => {
    if (!status) return
    const target = status.latestVersion ?? status.latestCommit ?? '最新提交'
    const lines = [
      `当前版本：v${status.currentVersion}`,
      `目标版本：${target}`,
      '',
      '升级会：① 先暂停正在下载的任务 → ② 拉代码并重新构建 → ③ 重启服务 → ④ 自动恢复下载。',
      `现在有 ${status.activeTasks} 个任务在排队/下载中，它们会被暂停并在升级后恢复。`,
      '服务重启期间（约 1~3 分钟）页面会断开，恢复后刷新即可。',
      '',
      '确定现在升级吗？',
    ]
    if (!window.confirm(lines.join('\n'))) return
    setApplying(true)
    try {
      const r = await api.updateApply({ manual: true, force })
      toast.success('升级已开始', r.message)
      setStatus(r.status)
    } catch (e) {
      toast.error('升级启动失败', (e as Error).message)
      setApplying(false)
    }
  }

  const onToggleAuto = async (enabled: boolean) => {
    try {
      const r = await api.saveUpdateSettings({ enabled })
      setStatus((s) => (s ? { ...s, autoEnabled: r.update.enabled } : s))
      toast.success(enabled ? '已开启自动更新' : '已关闭自动更新')
    } catch (e) {
      toast.error('保存失败', (e as Error).message)
    }
  }

  const commits = useMemo(() => status?.commits ?? [], [status])

  /** 手动更新命令：服务器上执行它 = 点「立即更新」；自动升级起不来时的兜底 */
  const manualCommand = status?.manualCommand || 'cd ~/ttdownload-web && sudo ./deploy.sh --update'
  const [copied, setCopied] = useState(false)
  const copyManualCommand = async () => {
    try {
      await copyText(manualCommand)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
      toast.success('命令已复制', '在服务器（树莓派）的终端里粘贴执行即可')
    } catch (e) {
      toast.error('复制失败', (e as Error).message)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-500">
        <Spinner /> <span className="ml-2">正在读取更新状态…</span>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="项目更新"
          subtitle="检查并升级服务器上的代码。升级只更新代码并重新构建，涉及系统依赖的变更仍需手动执行 sudo ./deploy.sh --update"
          action={
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" icon={<RefreshCw className="h-4 w-4" />} loading={checking} onClick={onCheck}>
                检查更新
              </Button>
              <Button
                size="sm"
                icon={<ArrowUpCircle className="h-4 w-4" />}
                loading={applying}
                disabled={!status?.repoReady || !status?.available}
                onClick={() => void onApply(status?.versionUnchanged ?? false)}
              >
                立即更新
              </Button>
            </div>
          }
        />

        {error ? (
          <div className="mb-4 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>读取更新状态失败：{error}（服务可能正在重启，稍等自动刷新）</div>
          </div>
        ) : null}

        {status && !status.repoReady ? (
          <div className="mb-4 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>当前部署目录不是 git 仓库（可能是压缩包上传的），自动更新不可用。请改用 deploy.sh 重新拉取代码后再用。</div>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Info label="当前版本" value={`v${status?.currentVersion ?? '—'}`} tone="neutral" />
          <Info
            label="远端版本"
            value={status?.latestVersion ? `v${status.latestVersion}` : '—'}
            tone={status?.versionNewer ? 'brand' : 'neutral'}
          />
          <Info label="当前提交" value={status?.currentCommit ?? '—'} tone="neutral" mono />
          <Info
            label="远端提交"
            value={status?.latestCommit ?? '—'}
            tone={status?.behind ? 'brand' : 'neutral'}
            mono
          />
        </div>

        <div className="mt-4 space-y-2 text-sm">
          {status?.versionNewer ? (
            <p className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
              <ArrowUpCircle className="h-4 w-4" />
              发现新版本 <b>v{status.latestVersion}</b>（当前 v{status.currentVersion}），共 {status.behind} 个新提交
              {status.majorBump ? '（⚠️ 这是大版本升级，可能有不兼容变更）' : ''}
            </p>
          ) : status?.versionUnchanged ? (
            <p className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4" />
              远端有 {status.behind} 个新提交，但版本号没有抬高（仍是 v{status.latestVersion ?? '未知'}）。
              按版本规范这不算一次发布，**不会自动升级**；确实要装可以点上面的「立即更新」（强制装最新提交）。
            </p>
          ) : (
            <p className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              已是最新版本 {status?.checkedAt ? `（上次检查 ${fmtTime(status.checkedAt)}）` : ''}
            </p>
          )}
          {status?.error ? (
            <p className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4" />
              上次拉取失败：{status.error}（已用本地代码继续运行，会按间隔自动重试）
            </p>
          ) : null}
          <p className="text-xs text-slate-500 dark:text-slate-400">
            代码来源：<code className="rounded bg-slate-100 px-1 dark:bg-slate-800">{status?.remote}/{status?.branch}</code>
            · 正在排队/下载的任务 {status?.activeTasks ?? 0} 个（升级会先暂停它们，升完自动恢复）
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title="自动更新" subtitle="开机后自动拉取最新代码；运行期间定时检查，有新版本就自动升级（拉不到就用本地代码继续跑）" />
        <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <div className="text-sm">
            <div className="font-medium text-slate-800 dark:text-slate-100">开启自动更新</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              开机 {status?.bootDelaySec ?? 20} 秒后首次检查，之后每 {status?.intervalMin ?? 60} 分钟检查一次
            </div>
          </div>
          <Switch checked={status?.autoEnabled ?? false} onChange={(v) => void onToggleAuto(v)} />
        </div>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          想让服务器升级到某个版本，就在代码里把 package.json 的版本号按 <b>主.次.修订</b> 抬上去再推送（规范见 docs/VERSIONING.md）；
          版本号没变的新提交不会被自动安装。
        </p>
      </Card>

      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><GitBranch className="h-4 w-4" /> 待更新内容</span>}
          subtitle={commits.length ? `远端比本机多 ${commits.length} 个提交` : '没有新提交'}
        />
        {commits.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">暂无。点「检查更新」拉取远端最新状态。</p>
        ) : (
          <ul className="space-y-2">
            {commits.map((c) => (
              <li key={c.sha} className="flex items-start gap-3 text-sm">
                <code className="mt-0.5 shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {c.sha}
                </code>
                <span className="min-w-0 flex-1 text-slate-700 dark:text-slate-200">{c.subject}</span>
                <span className="shrink-0 text-xs text-slate-400">{fmtTime(c.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><Terminal className="h-4 w-4" /> 手动更新命令</span>}
          subtitle="在服务器（树莓派）的终端里执行下面这条命令，效果等于本页的「立即更新」；页面上的升级万一失败，用它兜底最稳"
          action={
            <Button
              size="sm"
              variant={copied ? 'secondary' : 'outline'}
              icon={copied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              onClick={() => void copyManualCommand()}
            >
              {copied ? '已复制' : '复制命令'}
            </Button>
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          <code
            className={cn(
              'flex-1 overflow-x-auto whitespace-pre rounded-lg bg-slate-950 px-3 py-2.5 font-mono text-xs text-emerald-300',
            )}
          >
            {manualCommand}
          </code>
        </div>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          它会：拉最新代码 → 装依赖 → 构建后端+前端 → 重启服务（并自检）。装的是远端 <b>main</b> 分支的最新提交，
          不受"版本号有没有抬"限制。
        </p>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          服务器上的实际目录：
          <code className="ml-1 rounded bg-slate-100 px-1 dark:bg-slate-800">{status?.rootDir ?? '—'}</code>
          {status?.rootDir && status.manualCommand.includes('~/')
            ? '（命令里的 ~ 就是你自己账号的家目录，两者指向同一个地方）'
            : ''}
        </p>
        {status?.autoApplySkipReason ? (
          <p className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              自动升级暂时不会重试：{status.autoApplySkipReason}
            </span>
          </p>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><Terminal className="h-4 w-4" /> 上次升级结果</span>}
          action={
            <Button variant="ghost" size="sm" onClick={() => setShowLog((v) => !v)}>
              {showLog ? '收起日志' : '查看升级日志'}
            </Button>
          }
        />
        {status?.lastResult ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {status.lastResult.ok ? (
              <Badge tone="success">升级成功</Badge>
            ) : (
              <Badge tone="danger">{status.lastResult.rolledBack ? '失败（已回滚）' : '失败'}</Badge>
            )}
            <span className="text-slate-700 dark:text-slate-200">{status.lastResult.message}</span>
            <span className="text-xs text-slate-400">{fmtTime(status.lastResult.at)}</span>
            {status.lastResult.rolledBack ? <RotateCcw className="h-3.5 w-3.5 text-amber-500" /> : null}
          </div>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">还没有通过本页面升级过。</p>
        )}
        {showLog ? (
          <pre className={cn('mt-3 max-h-80 overflow-auto rounded-lg bg-slate-950 p-3 text-xs leading-relaxed text-slate-200')}>
            {status?.logTail || '（暂无日志）'}
          </pre>
        ) : null}
      </Card>
    </div>
  )
}

function Info({
  label,
  value,
  tone,
  mono,
}: {
  label: string
  value: string
  tone: 'neutral' | 'brand'
  mono?: boolean
}) {
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div
        className={cn(
          'mt-1 truncate font-semibold',
          tone === 'brand' ? 'text-brand-600 dark:text-brand-400' : 'text-slate-800 dark:text-slate-100',
          mono && 'font-mono text-sm',
        )}
        title={value}
      >
        {value}
      </div>
    </div>
  )
}
