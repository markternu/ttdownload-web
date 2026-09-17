import { Clock, Cpu, Download, Gauge, HardDrive, Link2, Magnet, Timer, User } from 'lucide-react'
import { cn } from '../../lib/cn'
import {
  clampPercent,
  formatBytes,
  formatDateTime,
  formatEta,
  formatSpeed,
  statusMeta,
  taskFormat,
  taskQuality,
  taskSizeBytes,
  isPublishTask,
} from '../../lib/format'
import { MODULE_LABELS } from '../../lib/api'
import { platformTone } from '../../lib/constants'
import type { Task } from '../../types'
import { Badge, ProgressBar, Thumbnail } from '../ui'
import { TaskActions } from './TaskActions'

const MODULE_ICON = {
  webvideo: Download,
  aria2: Link2,
  transmission: Magnet,
} as const

export interface TaskCardProps {
  task: Task
  onChanged?: () => void
  onError?: (message: string) => void
  className?: string
  /** 紧凑模式（Dashboard 最近任务） */
  compact?: boolean
  /** 是否显示文件大小（一级任务页不显示，各自列表页显示） */
  showSize?: boolean
}

/** 任务卡片：移动端与卡片视图使用，突出下载进度 */
export function TaskCard({ task, onChanged, onError, className, compact = false, showSize = true }: TaskCardProps) {
  const meta = statusMeta(task.status)
  const Icon = MODULE_ICON[task.module] ?? Download
  const size = taskSizeBytes(task)
  const showProgress = task.status === 'downloading' || task.status === 'paused' || task.progress > 0
  const progressTone =
    task.status === 'failed' ? 'danger' : task.status === 'completed' ? 'success' : 'brand'

  return (
    <div
      className={cn(
        'rounded-2xl border border-slate-200 bg-white p-4 shadow-soft transition-shadow hover:shadow-lift',
        'dark:border-slate-800 dark:bg-slate-900',
        className,
      )}
    >
      <div className="flex gap-3">
        <Thumbnail
          src={task.meta?.thumbnail}
          alt={task.title}
          className={cn('w-28', compact && 'w-20')}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3
              className={cn(
                'line-clamp-2 text-sm font-semibold text-slate-900 dark:text-slate-50',
                compact ? 'text-xs' : 'text-sm',
              )}
              title={task.title}
            >
              {task.title || `任务 #${task.id}`}
            </h3>
            <Badge tone={meta.tone} dot pulse={task.status === 'downloading'} className="shrink-0">
              {meta.label}
            </Badge>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium',
                platformTone(task.platform),
              )}
            >
              {task.platform || '未知平台'}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <Icon className="h-3 w-3" />
              {MODULE_LABELS[task.module]}
            </span>
            {isPublishTask(task) ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                归档发布
              </span>
            ) : null}
            {task.meta?.resolution ? (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {taskQuality(task)}
              </span>
            ) : null}
            {task.meta?.format ? (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono uppercase text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {taskFormat(task)}
              </span>
            ) : null}
          </div>

          {showProgress ? (
            <div className="mt-2.5">
              <ProgressBar value={clampPercent(task.progress)} tone={progressTone} showLabel />
            </div>
          ) : null}

          <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-500 sm:grid-cols-4 dark:text-slate-400">
            {showSize ? (
              <div className="inline-flex items-center gap-1">
                <HardDrive className="h-3 w-3" />
                <dt className="sr-only">大小</dt>
                <dd className="tabular-nums">{formatBytes(size, '未知')}</dd>
              </div>
            ) : null}
            <div className="inline-flex items-center gap-1">
              <Gauge className="h-3 w-3" />
              <dt className="sr-only">速度</dt>
              <dd className="tabular-nums">{formatSpeed(task.speedBps)}</dd>
            </div>
            <div className="inline-flex items-center gap-1">
              <Timer className="h-3 w-3" />
              <dt className="sr-only">剩余时间</dt>
              <dd className="tabular-nums">剩余 {formatEta(task.etaSec)}</dd>
            </div>
            <div className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              <dt className="sr-only">创建时间</dt>
              <dd className="tabular-nums">{formatDateTime(task.createdAt)}</dd>
            </div>
            {task.meta?.author ? (
              <div className="col-span-2 inline-flex items-center gap-1 truncate">
                <User className="h-3 w-3 shrink-0" />
                <dd className="truncate">{task.meta.author}</dd>
              </div>
            ) : null}
            {task.publishedName ? (
              <div className="col-span-2 inline-flex items-center gap-1 truncate">
                <Cpu className="h-3 w-3 shrink-0" />
                <dd className="truncate font-mono">已发布：{task.publishedName}</dd>
              </div>
            ) : null}
          </dl>

          {task.error ? (
            <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700 dark:bg-red-950/30 dark:text-red-300">
              失败原因：{task.error}
            </p>
          ) : null}

          <div className="mt-3">
            <TaskActions task={task} onDone={onChanged} onError={onError} compact={compact} />
          </div>
        </div>
      </div>
    </div>
  )
}
