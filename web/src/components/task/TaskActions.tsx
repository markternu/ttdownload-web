import { useState } from 'react'
import { Ban, Pause, Play, RotateCcw, Trash2 } from 'lucide-react'
import { api } from '../../lib/api'
import { humanizeError } from '../../lib/format'
import type { Task, TaskAction } from '../../types'
import { Button, Modal } from '../ui'
import { cn } from '../../lib/cn'

export interface TaskActionsProps {
  task: Task
  onDone?: () => void
  onError?: (message: string) => void
  size?: 'sm' | 'md'
  className?: string
  /** 手机端仅显示图标按钮，避免按钮溢出 */
  compact?: boolean
}

interface ActionConfig {
  action: TaskAction
  label: string
  icon: typeof Pause
  variant: 'primary' | 'outline' | 'ghost' | 'danger' | 'secondary'
  show: boolean
}

function actionsFor(task: Task): ActionConfig[] {
  const canPause = task.status === 'downloading' || task.status === 'waiting'
  const canResume = task.status === 'paused'
  const canCancel =
    task.status !== 'completed' && task.status !== 'cancelled' && task.status !== 'failed'
  const canRetry = task.status === 'failed' || task.status === 'cancelled'
  return [
    { action: 'pause', label: '暂停', icon: Pause, variant: 'outline', show: canPause },
    { action: 'resume', label: '继续', icon: Play, variant: 'primary', show: canResume },
    { action: 'cancel', label: '取消', icon: Ban, variant: 'ghost', show: canCancel },
    { action: 'retry', label: '重试', icon: RotateCcw, variant: 'secondary', show: canRetry },
    { action: 'delete', label: '删除', icon: Trash2, variant: 'danger', show: true },
  ]
}

/**
 * 任务行内操作：调用 POST /api/tasks/:id/actions。
 * 删除提供二次确认，并明确区分「仅删除记录」与「同时删除文件」。
 */
export function TaskActions({
  task,
  onDone,
  onError,
  size = 'sm',
  className,
  compact = false,
}: TaskActionsProps) {
  const [pending, setPending] = useState<TaskAction | null>(null)
  const [showDelete, setShowDelete] = useState(false)

  const run = async (action: TaskAction, deleteFile = false) => {
    setPending(action)
    try {
      await api.taskAction(task.id, action, deleteFile ? { deleteFile: true } : {})
      setShowDelete(false)
      onDone?.()
    } catch (err) {
      onError?.(humanizeError((err as { code?: string }).code ?? '', (err as Error).message))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {actionsFor(task)
        .filter((item) => item.show)
        .map((item) => {
          const Icon = item.icon
          return (
            <Button
              key={item.action}
              size={size}
              variant={item.variant}
              loading={pending === item.action}
              disabled={pending !== null && pending !== item.action}
              onClick={() => (item.action === 'delete' ? setShowDelete(true) : void run(item.action))}
              title={item.label}
              aria-label={item.label}
            >
              <Icon className="h-3.5 w-3.5" />
              {!compact ? <span>{item.label}</span> : null}
            </Button>
          )
        })}

      <Modal
        open={showDelete}
        title="删除任务"
        description={`确认删除任务 #${task.id}「${task.title}」？`}
        onClose={() => setShowDelete(false)}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowDelete(false)} disabled={pending !== null}>
              取消
            </Button>
            <Button
              variant="secondary"
              loading={pending === 'delete'}
              onClick={() => void run('delete', false)}
            >
              仅删除记录
            </Button>
            <Button
              variant="danger"
              loading={pending === 'delete'}
              onClick={() => void run('delete', true)}
            >
              同时删除文件
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          「仅删除记录」只移除任务条目，磁盘上的文件（含已发布成品）会保留；
          「同时删除文件」会一并删除尚未发布完成的下载产物，此操作不可撤销。
        </p>
      </Modal>
    </div>
  )
}

/** 显式的“删除记录 + 文件”入口（历史页使用） */
export function DeleteWithFileButton({
  taskId,
  onDone,
  onError,
}: {
  taskId: number
  onDone?: () => void
  onError?: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} title="删除记录和文件">
        <Trash2 className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">删除文件</span>
      </Button>
      <Modal
        open={open}
        title="删除记录和文件"
        description="将同时删除磁盘上的下载产物，操作不可撤销。"
        onClose={() => setOpen(false)}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              取消
            </Button>
            <Button
              variant="danger"
              loading={pending}
              onClick={async () => {
                setPending(true)
                try {
                  await api.taskAction(taskId, 'delete', { deleteFile: true })
                  setOpen(false)
                  onDone?.()
                } catch (err) {
                  onError?.(
                    humanizeError((err as { code?: string }).code ?? '', (err as Error).message),
                  )
                } finally {
                  setPending(false)
                }
              }}
            >
              确认删除
            </Button>
          </>
        }
      />
    </>
  )
}
