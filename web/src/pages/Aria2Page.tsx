import { useCallback, useEffect, useState } from 'react'
import { Link2, ListPlus, Server, Trash2 } from 'lucide-react'
import { TaskCard } from '../components/task/TaskCard'
import { TaskBulkBar } from '../components/task/TaskBulkBar'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DangerConfirmModal,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Textarea,
} from '../components/ui'
import { useToast } from '../context/ToastContext'
import { useTasks } from '../hooks/useTasks'
import { summarizeBulkResult, useTaskSelection } from '../hooks/useTaskSelection'
import { api, MODULE_LABELS } from '../lib/api'
import { formatBytes, humanizeError } from '../lib/format'
import type { Aria2Status, TaskAction } from '../types'

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

  const taskQuery = { module: 'aria2' as const, sort: 'created_desc', pageSize: 30 }
  const { tasks, total, loading, error, refresh, act, bulkAct, bulkBusy, pendingIds } = useTasks(taskQuery, {
    poll: true,
  })

  // 勾选 + 批量操作（暂停/恢复/重试/取消/删除），与任务页/历史页同一套语义
  const selection = useTaskSelection(tasks, taskQuery)
  const [bulkPendingDelete, setBulkPendingDelete] = useState(false)

  const reportBulk = (result: Awaited<ReturnType<typeof bulkAct>>) => {
    const s = summarizeBulkResult(result)
    if (s.tone === 'success') toast.success(s.title)
    else toast.warning(s.title, s.description)
  }

  const runBulk = async (action: TaskAction) => {
    const ids = [...selection.selected]
    if (!ids.length) return
    if (action === 'delete') {
      setBulkPendingDelete(true)
      return
    }
    try {
      reportBulk(await bulkAct(ids, action))
      selection.clear()
    } catch (err) {
      toast.error('操作失败', (err as Error).message)
    }
  }

  const confirmBulkDelete = async () => {
    try {
      reportBulk(await bulkAct([...selection.selected], 'delete'))
      selection.clear()
      setBulkPendingDelete(false)
    } catch (err) {
      toast.error('操作失败', (err as Error).message)
      setBulkPendingDelete(false)
    }
  }

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
          <div className="space-y-3">
            <TaskBulkBar
              pageCount={tasks.length}
              totalMatching={total ?? tasks.length}
              selectedCount={selection.count}
              allOnPageSelected={selection.allOnPageSelected}
              someOnPageSelected={selection.someOnPageSelected}
              selectingAll={selection.selectingAll}
              busy={bulkBusy}
              onToggleAllOnPage={selection.toggleAllOnPage}
              onSelectAllMatching={() => selection.selectAllMatching()}
              onClear={selection.clear}
              onAction={(action) => void runBulk(action)}
            />
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {tasks.map((task) => (
              <div key={task.id} className="space-y-2">
                <TaskCard
                  task={task}
                  selectable
                  selected={selection.isSelected(task.id)}
                  onToggleSelect={selection.toggle}
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
          </div>
        )}
      </Card>

      <DangerConfirmModal
        open={bulkPendingDelete}
        busy={bulkBusy}
        title="批量删除直链任务"
        description={`已选中 ${selection.count} 个任务`}
        items={tasks
          .filter((t) => selection.isSelected(t.id))
          .map((t) => ({ id: t.id, name: t.title || t.url || `任务 #${t.id}`, hint: t.status }))}
        rangeWarning={
          <span>
            你即将删除 <strong>{selection.count}</strong> 条直链任务记录，请先核对清单。
            {selection.count > tasks.length ? '（清单只显示当前页，其余在其它页）' : ''}
          </span>
        }
        step2Label="确认影响"
        step2Content={
          <ul className="list-disc space-y-1 pl-5">
            <li>正在下载的任务会被先取消，并删除任务<strong>记录</strong>（列表里不再出现）。</li>
            <li>已经下载归档的成品文件<strong>不会</strong>被删除（要删文件请去「文件」页）。</li>
            <li>此操作<strong>不可撤销</strong>。</li>
          </ul>
        }
        finalSummary={
          <span>
            最后确认：将删除 <strong>{selection.count}</strong> 条直链任务 ——
          </span>
        }
        executeLabel={`确认全部删除（${selection.count} 个）`}
        onClose={() => setBulkPendingDelete(false)}
        onConfirm={() => void confirmBulkDelete()}
      />
    </div>
  )
}
