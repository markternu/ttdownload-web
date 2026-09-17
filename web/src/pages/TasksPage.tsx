import { useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { TaskFilterBar } from '../components/task/TaskFilterBar'
import type { ViewMode } from '../components/task/TaskFilterBar'
import { TaskCard } from '../components/task/TaskCard'
import { TaskActions } from '../components/task/TaskActions'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Pagination,
  ProgressBar,
  Table,
  Thumbnail,
} from '../components/ui'
import type { Column } from '../components/ui'
import { useAppData } from '../context/AppDataContext'
import { useToast } from '../context/ToastContext'
import { useTasks, groupBySection } from '../hooks/useTasks'
import { useDebouncedValue, useMediaQuery } from '../hooks/useAsync'
import { MODULE_LABELS } from '../lib/api'
import { platformTone } from '../lib/constants'
import {
  clampPercent,
  formatBytes,
  formatDateTime,
  formatEta,
  formatSpeed,
  humanizeError,
  statusMeta,
  taskFormat,
  taskQuality,
  taskSizeBytes,
  isPublishTask,
} from '../lib/format'
import type { Task } from '../types'
import { AlertTriangle, Archive, ArrowLeft, CheckCircle2, ChevronRight, Clock, Download, Loader2, PauseCircle } from 'lucide-react'

interface SectionConfig {
  key: string
  title: string
  description: string
  tone: 'brand' | 'warning' | 'success' | 'danger'
  icon: typeof Download
}

const SECTIONS: SectionConfig[] = [
  { key: 'downloading', title: '正在下载', description: '正在下载 / 暂停', tone: 'brand', icon: Download },
  { key: 'waiting', title: '排队中', description: '等待并发名额或磁盘空间放行', tone: 'warning', icon: Clock },
  { key: 'publish', title: '归档发布', description: '扫货后归档 → 加密 → 发布（种子下载产生的子任务，不算种子任务）', tone: 'success', icon: Archive },
  { key: 'finished', title: '已下载', description: '已完成并进入归档/发布流程', tone: 'success', icon: CheckCircle2 },
  { key: 'failed', title: '失败 / 已取消', description: '可重试或删除', tone: 'danger', icon: AlertTriangle },
]

/**
 * 任务区的视图（一级页面 + 各自的独立页面）。
 *
 * 用户要求：**一级页面只展示"正在下载"和"已下载"**；排队下载、扫货（归档发布）、
 * 其它任务各自有独立页面，一级页面给入口点进去。文件大小只在各自的列表页显示。
 */
type ViewKey = 'main' | 'waiting' | 'publish' | 'other'

interface ViewConfig {
  key: ViewKey
  path: string
  title: string
  description: string
  /** 固定筛选：状态（空 = 不限制） */
  statuses: string
  /** 固定筛选：download=下载任务 / publish=归档发布子任务 */
  kind?: 'download' | 'publish'
  /** 一级页面固定为"下载中 + 已下载"两档 */
  sections: string[]
  /** 是否显示文件大小 */
  showSize: boolean
  /** 一级页面的入口卡片 */
  entries: { to: string; label: string; hint: string; icon: typeof Download; count: (s: StatsLike) => number }[]
  emptyHint: string
}

type StatsLike = { waiting?: number; failed?: number; publishTasks?: number; publishing?: number }

const VIEWS: Record<ViewKey, ViewConfig> = {
  main: {
    key: 'main',
    path: '/tasks',
    title: '下载任务',
    description: '正在下载与已经下载完成的任务（不含排队、归档发布等）',
    statuses: 'downloading,parsing,paused,completed',
    kind: 'download',
    sections: ['downloading', 'finished'],
    showSize: false,
    entries: [
      { to: '/tasks-waiting', label: '排队下载', hint: '等磁盘空间/并发名额', icon: Clock, count: (s) => s.waiting ?? 0 },
      { to: '/tasks-publish', label: '归档发布（扫货）', hint: '归档 → 加密 → 发布', icon: Archive, count: (s) => s.publishTasks ?? 0 },
      { to: '/tasks-other', label: '其它任务', hint: '失败 / 已取消', icon: AlertTriangle, count: (s) => s.failed ?? 0 },
    ],
    emptyHint: '还没有下载任务。回到首页粘贴链接，或在「BT 种子下载」页上传种子。',
  },
  waiting: {
    key: 'waiting',
    path: '/tasks-waiting',
    title: '排队下载',
    description: '等待放行的任务（磁盘空间或并发名额）',
    statuses: 'waiting,paused',
    kind: 'download',
    sections: ['waiting', 'downloading'],
    showSize: true,
    entries: [],
    emptyHint: '队列是空的，没有任务在排队。',
  },
  publish: {
    key: 'publish',
    path: '/tasks-publish',
    title: '归档发布（扫货任务）',
    description: 'BT 扫货把下好的文件交付归档 → 加密 → 发布；这些是下载任务产生的子任务',
    statuses: '',
    kind: 'publish',
    sections: ['downloading', 'publish', 'finished', 'failed'],
    showSize: true,
    entries: [],
    emptyHint: '暂无归档发布任务。',
  },
  other: {
    key: 'other',
    path: '/tasks-other',
    title: '其它任务',
    description: '失败与已取消的任务',
    statuses: 'failed,cancelled',
    kind: 'download',
    sections: ['failed', 'finished'],
    showSize: true,
    entries: [],
    emptyHint: '没有失败或已取消的任务。',
  },
}

function viewFromPath(pathname: string): ViewKey {
  if (pathname.endsWith('/tasks-waiting')) return 'waiting'
  if (pathname.endsWith('/tasks-publish')) return 'publish'
  if (pathname.endsWith('/tasks-other')) return 'other'
  return 'main'
}

export default function TasksPage() {
  const toast = useToast()
  const { stats, sseStatus } = useAppData()
  const isMobile = useMediaQuery('(max-width: 767px)')
  const { pathname } = useLocation()
  const pageView = viewFromPath(pathname)
  const cfg = VIEWS[pageView]
  const isMain = pageView === 'main'
  const shownSections = SECTIONS.filter((s) => cfg.sections.includes(s.key))

  const [module, setModule] = useState('')
  const [status, setStatus] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('created_desc')
  const [view, setView] = useState<ViewMode>('card')
  const [page, setPage] = useState(1)

  const debouncedQuery = useDebouncedValue(query, 350)
  // 独立页面用**固定筛选**（排队/扫货/其它各自的口径），一级页面固定为"下载中 + 已下载"
  const { tasks, total, loading, error, refresh, act } = useTasks({
    module: module as '' | 'transmission' | 'aria2' | 'webvideo',
    status: cfg.statuses || status,
    kind: cfg.kind,
    q: debouncedQuery,
    sort,
    page,
    pageSize: 20,
  })

  const sections = useMemo(() => groupBySection(tasks), [tasks])
  const activeView: ViewMode = isMobile ? 'card' : view

  const handleError = (message: string) => toast.error('操作失败', message)

  const runAction = async (task: Task, action: 'retry' | 'delete') => {
    try {
      await act(task.id, action)
      toast.success(action === 'retry' ? '已重新加入队列' : '任务已删除')
    } catch (err) {
      handleError(humanizeError((err as { code?: string }).code ?? '', (err as Error).message))
    }
  }

  const allColumns: Column<Task>[] = [
    {
      key: 'title',
      header: '任务',
      render: (task) => (
        <div className="flex items-center gap-3">
          <Thumbnail src={task.meta?.thumbnail} alt={task.title} className="w-16" />
          <div className="min-w-0 max-w-[240px]">
            <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100" title={task.title}>
              {task.title}
            </p>
            {isPublishTask(task) ? (
              <span className="mt-0.5 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                归档发布（种子下载产生的子任务）
              </span>
            ) : null}
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
              <span className={platformTone(task.platform)}>{task.platform ?? '未知平台'}</span>
              <span>· {MODULE_LABELS[task.module]}</span>
            </p>
          </div>
        </div>
      ),
    },
    {
      key: 'spec',
      header: '规格',
      hideOnMobile: true,
      render: (task) => (
        <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
          {taskQuality(task)} · {taskFormat(task)}
        </span>
      ),
    },
    {
      key: 'size',
      header: '大小',
      render: (task) => (
        <span className="whitespace-nowrap text-xs tabular-nums text-slate-500 dark:text-slate-400">
          {formatBytes(taskSizeBytes(task), '未知')}
        </span>
      ),
    },
    {
      key: 'progress',
      header: '进度',
      render: (task) => (
        <div className="w-40">
          <ProgressBar
            value={clampPercent(task.progress)}
            size="sm"
            tone={task.status === 'failed' ? 'danger' : task.status === 'completed' ? 'success' : 'brand'}
          />
          <div className="mt-1 flex justify-between text-[11px] text-slate-400">
            <span className="tabular-nums">{clampPercent(task.progress)}%</span>
            <span className="tabular-nums">{formatSpeed(task.speedBps)}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'eta',
      header: '剩余',
      hideOnMobile: true,
      render: (task) => (
        <span className="whitespace-nowrap text-xs tabular-nums text-slate-500 dark:text-slate-400">
          {formatEta(task.etaSec)}
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      render: (task) => {
        const meta = statusMeta(task.status)
        return (
          <Badge tone={meta.tone} dot pulse={task.status === 'downloading'}>
            {meta.label}
          </Badge>
        )
      },
    },
    {
      key: 'createdAt',
      header: '创建时间',
      hideOnMobile: true,
      render: (task) => (
        <span className="whitespace-nowrap text-xs tabular-nums text-slate-500 dark:text-slate-400">
          {formatDateTime(task.createdAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      headerClassName: 'text-right',
      className: 'text-right',
      render: (task) => (
        <div className="flex justify-end">
          <TaskActions task={task} onDone={() => void refresh()} onError={handleError} compact />
        </div>
      ),
    },
  ]

  // 文件大小只在"各自的列表页面"显示（一级页面不显示）
  const columns = cfg.showSize ? allColumns : allColumns.filter((c) => c.key !== 'size')

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {!isMain ? (
            <Link
              to="/tasks"
              className="mb-1 inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-400"
            >
              <ArrowLeft className="h-3 w-3" />
              返回下载任务
            </Link>
          ) : null}
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">{cfg.title}</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {cfg.description} · 共 {total} 个
            {' · '}
            {sseStatus === 'open' ? (
              <span className="text-emerald-600 dark:text-emerald-400">实时更新已连接</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <Loader2 className="h-3 w-3 animate-spin" />
                实时连接中断，已启用 3 秒轮询兜底
              </span>
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" loading={loading} onClick={() => void refresh()}>
          刷新
        </Button>
      </div>

      {isMain ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {cfg.entries.map((e) => {
            const Icon = e.icon
            return (
              <Link
                key={e.to}
                to={e.to}
                className="group flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 transition hover:border-brand-300 hover:shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:hover:border-brand-600"
              >
                <span className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span>
                    <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">{e.label}</span>
                    <span className="block text-xs text-slate-400">{e.hint}</span>
                  </span>
                </span>
                <span className="flex items-center gap-1 text-sm font-semibold tabular-nums text-slate-500 dark:text-slate-300">
                  {e.count((stats ?? {}) as StatsLike)}
                  <ChevronRight className="h-4 w-4 text-slate-300 transition group-hover:text-brand-500" />
                </span>
              </Link>
            )
          })}
        </div>
      ) : null}

      {isMain ? (
      <TaskFilterBar
        module={module}
        status={status}
        query={query}
        sort={sort}
        view={activeView}
        showViewToggle={!isMobile}
        onModuleChange={setModule}
        onStatusChange={setStatus}
        onQueryChange={setQuery}
        onSortChange={setSort}
        onViewChange={setView}
        onReset={() => {
          setModule('')
          setStatus('')
          setQuery('')
          setSort('created_desc')
        }}
      />
      ) : null}

      {error ? (
        <ErrorState message={`加载任务失败：${error}`} onRetry={() => void refresh()} />
      ) : loading && !tasks.length ? (
        <LoadingBlock text="正在加载任务列表…" />
      ) : !tasks.length ? (
        <EmptyState title="没有匹配的任务" description={cfg.emptyHint} />
      ) : (
        <div className="space-y-6">
          {shownSections.map((section) => {
            const list = sections[section.key as keyof typeof sections] ?? []
            if (!list.length) return null
            const Icon = section.icon
            return (
              <section key={section.key} className="space-y-3">
                <div className="flex items-center gap-2">
                  <span
                    className={
                      section.tone === 'brand'
                        ? 'text-brand-600 dark:text-brand-400'
                        : section.tone === 'warning'
                          ? 'text-amber-600 dark:text-amber-400'
                          : section.tone === 'success'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-red-600 dark:text-red-400'
                    }
                  >
                    <Icon className={section.key === 'downloading' ? 'h-4 w-4 animate-pulse' : 'h-4 w-4'} />
                  </span>
                  <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    {section.title}
                  </h3>
                  <Badge tone="neutral">{list.length}</Badge>
                  <span className="hidden text-xs text-slate-400 sm:inline">{section.description}</span>
                </div>

                {section.key === 'finished' ? (
                  <p className="flex items-center gap-1.5 rounded-xl bg-slate-100/70 px-3 py-2 text-[11px] text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
                    <PauseCircle className="h-3.5 w-3.5" />
                    已完成的任务文件位于消费者目录，可在「已发布文件」页查看与删除。
                  </p>
                ) : null}

                {activeView === 'card' ? (
                  <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                    {list.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        showSize={cfg.showSize}
                        onChanged={() => void refresh()}
                        onError={handleError}
                      />
                    ))}
                  </div>
                ) : (
                  <Card padded={false} className="overflow-hidden p-3 sm:p-4">
                    <Table
                      columns={columns}
                      rows={list}
                      rowKey={(task) => task.id}
                      minWidthClass="min-w-[860px]"
                    />
                  </Card>
                )}

                {section.key === 'failed' ? (
                  <div className="flex flex-wrap gap-2">
                    {list.map((task) => (
                      <Button
                        key={task.id}
                        size="sm"
                        variant="outline"
                        onClick={() => void runAction(task, 'retry')}
                      >
                        重试 #{task.id}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </section>
            )
          })}

          <Pagination page={page} pageSize={20} total={total} onPageChange={setPage} />
        </div>
      )}
    </div>
  )
}
