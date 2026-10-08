import { Ban, Pause, Play, RotateCcw, Trash2, X } from 'lucide-react'
import { Button } from '../ui'
import { cn } from '../../lib/cn'
import type { TaskAction } from '../../types'

export interface TaskBulkBarProps {
  /** 当前页可选的任务数 */
  pageCount: number
  /** 当前筛选条件下的**全部**任务数（跨页全选时用；等于 pageCount 说明只有一页） */
  totalMatching: number
  selectedCount: number
  allOnPageSelected: boolean
  someOnPageSelected: boolean
  selectingAll: boolean
  busy: boolean
  onToggleAllOnPage: () => void
  onSelectAllMatching: () => void | Promise<void>
  onClear: () => void
  /** 点某个批量动作（删除会由页面走三步确认） */
  onAction: (action: TaskAction) => void
  className?: string
}

const ACTION_BUTTONS: { action: TaskAction; label: string; icon: typeof Pause; variant: 'outline' | 'danger' | 'secondary' }[] = [
  { action: 'pause', label: '全部暂停', icon: Pause, variant: 'outline' },
  { action: 'resume', label: '全部恢复', icon: Play, variant: 'outline' },
  { action: 'retry', label: '全部重试', icon: RotateCcw, variant: 'outline' },
  { action: 'cancel', label: '全部取消', icon: Ban, variant: 'outline' },
  { action: 'delete', label: '全部删除', icon: Trash2, variant: 'danger' },
]

/**
 * 任务列表的「全选 + 批量操作」工具条（任务页 / 历史页 / URL 直链页共用）。
 *
 * 语义（必须和页面上的勾选框一致）：
 *   · 勾选框 = **全选当前页**（列表是分页的，每页 20 条）；
 *   · 「选中全部 N 个」= 按**当前筛选条件**跨页全选（后端按同一套条件取 id）；
 *   · 批量动作逐条执行、逐条回报，状态不允许的会被跳过并说明原因（不会假装成功）。
 */
export function TaskBulkBar({
  pageCount,
  totalMatching,
  selectedCount,
  allOnPageSelected,
  someOnPageSelected,
  selectingAll,
  busy,
  onToggleAllOnPage,
  onSelectAllMatching,
  onClear,
  onAction,
  className,
}: TaskBulkBarProps) {
  const hasSelection = selectedCount > 0
  const canSelectAllMatching = totalMatching > pageCount

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2.5 transition-colors',
        hasSelection
          ? 'border-brand-300 bg-brand-50/70 dark:border-brand-700 dark:bg-brand-950/30'
          : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
        className,
      )}
    >
      <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer rounded border-slate-300 accent-brand-600 dark:border-slate-600"
          checked={allOnPageSelected}
          ref={(el) => {
            if (el) el.indeterminate = someOnPageSelected && !allOnPageSelected
          }}
          aria-label="全选当前页"
          title="全选当前页"
          disabled={!pageCount}
          onChange={onToggleAllOnPage}
        />
        全选当前页
      </label>

      {canSelectAllMatching ? (
        <button
          type="button"
          className="text-xs text-brand-600 underline-offset-2 hover:underline disabled:opacity-50 dark:text-brand-400"
          disabled={selectingAll || busy}
          onClick={() => void onSelectAllMatching()}
        >
          {selectingAll ? '正在取全部…' : `选中全部 ${totalMatching} 个（跨页）`}
        </button>
      ) : null}

      <span className="text-sm text-slate-500 dark:text-slate-400">
        已选 <strong className="tabular-nums text-slate-800 dark:text-slate-100">{selectedCount}</strong> 个
      </span>

      {hasSelection ? (
        <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} disabled={busy} onClick={onClear}>
          清空选择
        </Button>
      ) : null}

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {ACTION_BUTTONS.map(({ action, label, icon: Icon, variant }) => (
          <Button
            key={action}
            size="sm"
            variant={variant}
            icon={<Icon className="h-3.5 w-3.5" />}
            disabled={!hasSelection || busy}
            loading={busy}
            onClick={() => onAction(action)}
          >
            {label}
          </Button>
        ))}
      </div>
    </div>
  )
}
