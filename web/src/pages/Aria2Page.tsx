import { useCallback, useEffect, useState } from 'react'
import { Link2, ListPlus, Server, Trash2 } from 'lucide-react'
import { TaskCard } from '../components/task/TaskCard'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Textarea,
} from '../components/ui'
import { useToast } from '../context/ToastContext'
import { useTasks } from '../hooks/useTasks'
import { api, MODULE_LABELS } from '../lib/api'
import { formatBytes, humanizeError } from '../lib/format'
import type { Aria2Status } from '../types'

const PLACEHOLDER = `https://example.com/video1.mp4
https://example.com/video2.zip`

interface SkippedItem {
  url: string
  reason: string
}

export default function Aria2Page() {
  const toast = useToast()
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [skipped, setSkipped] = useState<SkippedItem[]>([])
  const [status, setStatus] = useState<Aria2Status | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)

  const { tasks, loading, error, refresh, act, pendingIds } = useTasks(
    { module: 'aria2', sort: 'created_desc', pageSize: 30 },
    { poll: true },
  )

  const loadStatus = useCallback(async () => {
    try {
      const data = await api.aria2Status()
      setStatus(data)
      setStatusError(null)
    } catch (err) {
      setStatusError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
    const timer = window.setInterval(() => void loadStatus(), 15_000)
    return () => window.clearInterval(timer)
  }, [loadStatus])

  const urlLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const invalidLines = urlLines.filter((line) => !/^https?:\/\//i.test(line))

  const handleSubmit = async () => {
    if (!urlLines.length) {
      toast.warning('请先输入至少一个 URL', '每行一个链接，仅支持 http/https')
      return
    }
    if (invalidLines.length) {
      toast.error('存在非法 URL', `非 http/https 开头的链接：${invalidLines.slice(0, 3).join('、')}`)
      return
    }
    setSubmitting(true)
    setSkipped([])
    try {
      const res = await api.aria2Urls(urlLines)
      setText('')
      setSkipped(res.skipped ?? [])
      toast.success('已提交下载任务', `成功创建 ${res.created} 个任务`)
      void refresh()
      void loadStatus()
    } catch (err) {
      const code = (err as { code?: string }).code ?? ''
      toast.error('提交失败', humanizeError(code, (err as Error).message))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id: number, deleteFile: boolean) => {
    try {
      await act(id, 'delete', deleteFile)
      toast.success(deleteFile ? '已删除任务和文件' : '已删除任务记录')
    } catch (err) {
      toast.error('操作失败', humanizeError((err as { code?: string }).code ?? '', (err as Error).message))
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">URL 直链下载</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {MODULE_LABELS.aria2}模块 · 支持多行 URL，一行一个，下载到独立目录并统一归档
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={status?.running ? 'success' : 'danger'} dot pulse={!!status?.running}>
            aria2 {status?.running ? '运行中' : '未运行'}
          </Badge>
          {status?.version ? <Badge tone="neutral">v{status.version}</Badge> : null}
          <Badge tone="neutral">
            RPC {status ? `${status.rpc.host}:${status.rpc.port}` : '—'}
          </Badge>
          <Badge tone={(status?.pending ?? 0) > 0 ? 'warning' : 'neutral'}>
            排队 {status?.pending ?? 0}
          </Badge>
        </div>
      </div>

      {statusError ? (
        <p className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
          无法获取 aria2 状态：{statusError}（后端可能未启动 aria2，任务仍可提交并进入等待队列）
        </p>
      ) : null}

      <Card>
        <CardHeader
          title="批量提交 URL"
          subtitle="仅支持 http / https 直链，每行一个"
          action={
            <span className="inline-flex items-center gap-1 text-xs text-slate-400">
              <ListPlus className="h-3.5 w-3.5" />
              已识别 {urlLines.length} 条
            </span>
          }
        />
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={PLACEHOLDER}
          className="min-h-[160px] font-mono text-xs"
          spellCheck={false}
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            loading={submitting}
            disabled={!urlLines.length}
            icon={<Link2 className="h-4 w-4" />}
            onClick={() => void handleSubmit()}
          >
            提交到下载队列
          </Button>
          <Button variant="outline" onClick={() => setText('')} disabled={!text}>
            清空
          </Button>
          {invalidLines.length ? (
            <span className="text-xs text-red-600 dark:text-red-400">
              有 {invalidLines.length} 行不是合法的 http/https 链接
            </span>
          ) : null}
        </div>

        {skipped.length ? (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300">
            <p className="font-medium">后端跳过了 {skipped.length} 条 URL：</p>
            <ul className="mt-1.5 space-y-1">
              {skipped.map((item) => (
                <li key={item.url} className="truncate font-mono">
                  {item.url} —— {item.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="模块任务"
          subtitle={`共 ${tasks.length} 个 URL 直链任务`}
          action={
            <Button variant="outline" size="sm" loading={loading} onClick={() => void refresh()}>
              刷新
            </Button>
          }
        />

        {error ? (
          <ErrorState message={`加载任务失败：${error}`} onRetry={() => void refresh()} />
        ) : loading && !tasks.length ? (
          <LoadingBlock text="正在加载 aria2 任务…" />
        ) : !tasks.length ? (
          <EmptyState
            title="暂无 URL 直链任务"
            description="在上方文本框中粘贴直链（每行一个）后提交，任务会进入统一等待队列。"
            icon={<Server className="h-5 w-5" />}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {tasks.map((task) => (
              <div key={task.id} className="space-y-2">
                <TaskCard
                  task={task}
                  onChanged={() => void refresh()}
                  onError={(message) => toast.error('操作失败', message)}
                />
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
                  <span className="truncate font-mono" title={task.url ?? ''}>
                    {task.url ?? '—'}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums">
                      {formatBytes(task.downloadedBytes, '0 B')} / {formatBytes(task.totalBytes, '未知')}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={pendingIds.includes(task.id)}
                      onClick={() => void handleDelete(task.id, false)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      删除
                    </Button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
