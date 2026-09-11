import { LayoutGrid, List, Search, X } from 'lucide-react'
import { MODULE_TABS, TASK_SORT_OPTIONS } from '../../lib/constants'
import { TASK_STATUS_OPTIONS } from '../../lib/format'
import { Button, Input, Select } from '../ui'
import { cn } from '../../lib/cn'

export type ViewMode = 'card' | 'table'

export interface TaskFilterBarProps {
  module: string
  status: string
  query: string
  sort: string
  view: ViewMode
  showViewToggle?: boolean
  onModuleChange: (value: string) => void
  onStatusChange: (value: string) => void
  onQueryChange: (value: string) => void
  onSortChange: (value: string) => void
  onViewChange: (value: ViewMode) => void
  onReset: () => void
}

/** 任务筛选栏：模块 / 状态 / 搜索 / 排序 / 视图切换 */
export function TaskFilterBar({
  module,
  status,
  query,
  sort,
  view,
  showViewToggle = true,
  onModuleChange,
  onStatusChange,
  onQueryChange,
  onSortChange,
  onViewChange,
  onReset,
}: TaskFilterBarProps) {
  const dirty = Boolean(module || status || query)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5 rounded-2xl bg-slate-100 p-1 dark:bg-slate-800/70">
        {MODULE_TABS.map((tab) => (
          <button
            key={tab.value || 'all'}
            type="button"
            onClick={() => onModuleChange(tab.value)}
            className={cn(
              'rounded-xl px-3 py-1.5 text-xs font-medium transition-colors sm:text-sm',
              module === tab.value
                ? 'bg-white text-brand-700 shadow-sm dark:bg-slate-900 dark:text-brand-300'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-50',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索标题或 URL"
          leading={<Search className="h-4 w-4" />}
          wrapperClassName="flex-1"
          trailing={
            query ? (
              <button
                type="button"
                onClick={() => onQueryChange('')}
                aria-label="清空搜索"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null
          }
        />

        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
          <Select
            value={status}
            onChange={(event) => onStatusChange(event.target.value)}
            placeholder="全部状态"
            options={TASK_STATUS_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            className="sm:w-36"
          />
          <Select
            value={sort}
            onChange={(event) => onSortChange(event.target.value)}
            options={TASK_SORT_OPTIONS}
            className="sm:w-48"
          />

          {showViewToggle ? (
            <div className="col-span-2 flex items-center gap-1 rounded-xl bg-slate-100 p-1 sm:col-span-1 dark:bg-slate-800/70">
              <button
                type="button"
                onClick={() => onViewChange('card')}
                aria-label="卡片视图"
                className={cn(
                  'flex flex-1 items-center justify-center rounded-lg px-2.5 py-1.5 transition-colors',
                  view === 'card'
                    ? 'bg-white text-brand-600 shadow-sm dark:bg-slate-900 dark:text-brand-300'
                    : 'text-slate-500 dark:text-slate-400',
                )}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => onViewChange('table')}
                aria-label="表格视图"
                className={cn(
                  'flex flex-1 items-center justify-center rounded-lg px-2.5 py-1.5 transition-colors',
                  view === 'table'
                    ? 'bg-white text-brand-600 shadow-sm dark:bg-slate-900 dark:text-brand-300'
                    : 'text-slate-500 dark:text-slate-400',
                )}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
          ) : null}

          {dirty ? (
            <Button variant="ghost" size="sm" onClick={onReset} className="col-span-2 sm:col-span-1">
              重置
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
