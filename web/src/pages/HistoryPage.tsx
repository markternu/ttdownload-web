import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download, FileVideo2, FolderOpen, RotateCcw, Trash2 } from 'lucide-react'
import { TaskCard } from '../components/task/TaskCard'
import { TaskFilterBar } from '../components/task/TaskFilterBar'
import type { ViewMode } from '../components/task/TaskFilterBar'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Pagination,
  Table,
  Thumbnail,
} from '../components/ui'
import type { Column } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { useDebouncedValue, useMediaQuery } from '../hooks/useAsync'
import { useTasks } from '../hooks/useTasks'
import { MODULE_LABELS } from '../lib/api'
import { platformTone } from '../lib/constants'
import {
  TASK_STATUS_OPTIONS,
  formatBytes,
  formatDateTime,
  humanizeError,
  statusMeta,
  taskFormat,
  taskQuality,
  taskSizeBytes,
} from '../lib/format'
import type { Task } from '../types'

export default function HistoryPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const isMobile = useMediaQuery('(max-width: 767px)')

  const [platform, setPlatform] = useState('')
  const [status, setStatus] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('created_desc')
  const [view, setView] = useState<ViewMode>('table')
  const [page, setPage] = useState(1)

  const debouncedQuery = useDebouncedValue(query, 350)
  const { tasks, total, loading, error, refresh, act, pendingIds } = useTasks({
    status,
    q: debouncedQuery,
    sort,
    page,
    pageSize: 20,
  })

  // 平台选项来自当前数据中出现的平台
  const platformOptions = useMemo(() => {
    const set = new Set<string>()
    for (const task of tasks) {
      if (task.platform) set.add(task.platform)
    }
    return Array.from(set).sort()
  }, [tasks])

  const filtered = useMemo(
    () => (platform ? tasks.filter((task) => task.platform === platform) : tasks),
    [tasks, platform],
  )

  // 历史页只关心已结束的任务（完成/失败/取消），如需查看全部可清空状态筛选
  const showAll = status === ''

  const handleError = (message: string) => toast.error('操作失败', message)

  const removeRecord = async (task: Task, withFile: boolean) => {
    try {
      await act(task.id, 'delete', withFile)
      toast.success(withFile ? '已删除记录和文件' : '已删除历史记录')
    } catch (err) {
      handleError(humanizeError((err as { code?: string }).code ?? '', (err as Error).message))
    }
  }

  const retry = async (task: Task) => {
    try {
      await act(task.id, 'retry')
      toast.success('已重新加入队列', task.title)
    } catch (err) {
      handleError(humanizeError((err as { code?: string }).code ?? '', (err as Error).message))
    }
  }

  const columns: Column<Task>[] = [
    {
      key: 'title',
      header: '视频名称',
      render: (task) => (
        <div className="flex items-center gap-3">
          <Thumbnail src={task.meta?.thumbnail} alt={task.title} className="w-14" />
          <div className="min-w-0 max-w-[260px]">
            <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100" title={task.title}>
              {task.title}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {taskQuality(task)} · {taskFormat(task)} · {MODULE_LABELS[task.module]}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: 'platform',
      header: '平台',
      render: (task) => (
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${platformTone(
            task.platform,
          )}`}
        >
          {task.platform ?? '未知平台'}
        </span>
      ),
    },
    {
      key: 'size',
      header: '文件大小',
      render: (task) => (
        <span className="whitespace-nowrap text-xs tabular-nums text-slate-600 dark:text-slate-300">
          {formatBytes(taskSizeBytes(task), '未知')}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: '下载时间',
      render: (task) => (
        <span className="whitespace-nowrap text-xs tabular-nums text-slate-500 dark:text-slate-400">
          {formatDateTime(task.createdAt)}
        </span>
      ),
    },
    {
      key: 'status',
      header: '下载状态',
      render: (task) => {
        const meta = statusMeta(task.status)
        return <Badge tone={meta.tone}>{meta.label}</Badge>
      },
    },
    {
      key: 'path',
      header: '文件路径',
      hideOnMobile: true,
      render: (task) => (
        <span
          className="block max-w-[220px] truncate font-mono text-[11px] text-slate-500 dark:text-slate-400"
          title={task.outputPath ?? task.publishedName ?? ''}
        >
          {task.publishedName ? `已发布：${task.publishedName}` : task.outputPath ?? '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      headerClassName: 'text-right',
      className: 'text-right',
      render: (task) => (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate('/files')}
            title="在已发布文件中查看"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">打开文件夹</span>
          </Button>
          {(task.status === 'failed' || task.status === 'cancelled') && (
            <Button
              size="sm"
              variant="secondary"
              loading={pendingIds.includes(task.id)}
              onClick={() => void retry(task)}
              title="重试"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">重试</span>
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            loading={pendingIds.includes(task.id)}
            onClick={() => void removeRecord(task, false)}
            title="仅删除记录（不删除文件）"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">删除记录</span>
          </Button>
          {task.outputPath || task.publishedName ? (
            <Button
              size="sm"
              variant="danger"
              loading={pendingIds.includes(task.id)}
              onClick={() => void removeRecord(task, true)}
              title="删除记录和文件"
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">删除文件</span>
            </Button>
          ) : null}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">下载历史</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            共 {total} 条记录 · 删除记录不会删除磁盘文件，如需一并删除请使用「删除文件」
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate('/files')}>
            <FileVideo2 className="h-3.5 w-3.5" />
            已发布文件
          </Button>
          <Button variant="outline" size="sm" loading={loading} onClick={() => void refresh()}>
            刷新
          </Button>
        </div>
      </div>

      <TaskFilterBar
        module=""
        status={status}
        query={query}
        sort={sort}
        view={view}
        showViewToggle={!isMobile}
        onModuleChange={() => undefined}
        onStatusChange={setStatus}
        onQueryChange={setQuery}
        onSortChange={setSort}
        onViewChange={setView}
        onReset={() => {
          setStatus('')
          setQuery('')
          setSort('created_desc')
          setPlatform('')
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">平台筛选：</span>
        <button
          type="button"
          onClick={() => setPlatform('')}
          className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
            platform === ''
              ? 'bg-brand-600 text-white'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
          }`}
        >
          全部
        </button>
        {platformOptions.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setPlatform(item)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
              platform === item
                ? 'bg-brand-600 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
            }`}
          >
            {item}
          </button>
        ))}
      </div>

      {!showAll ? (
        <p className="text-[11px] text-slate-400">
          当前按状态筛选：{TASK_STATUS_OPTIONS.find((option) => option.value === status)?.label}
        </p>
      ) : null}

      {error ? (
        <ErrorState message={`加载历史失败：${error}`} onRetry={() => void refresh()} />
      ) : loading && !tasks.length ? (
        <LoadingBlock text="正在加载历史记录…" />
      ) : !filtered.length ? (
        <EmptyState
          title="暂无历史记录"
          description="完成或失败的下载任务会出现在这里，可按平台与状态筛选。"
        />
      ) : isMobile || view === 'card' ? (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {filtered.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onChanged={() => void refresh()}
              onError={handleError}
            />
          ))}
        </div>
      ) : (
        <Card padded={false} className="p-3 sm:p-4">
          <Table columns={columns} rows={filtered} rowKey={(task) => task.id} />
        </Card>
      )}

      <Pagination page={page} pageSize={20} total={total} onPageChange={setPage} />
    </div>
  )
}
