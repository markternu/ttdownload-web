import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface Column<T> {
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  className?: string
  headerClassName?: string
  /** 手机端是否隐藏该列（节省空间，避免横向撑破布局） */
  hideOnMobile?: boolean
}

export interface TableProps<T> {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string | number
  empty?: ReactNode
  className?: string
  onRowClick?: (row: T) => void
  /** 保留最小宽度，超宽时在容器内横向滚动（不会撑破页面） */
  minWidthClass?: string
  footer?: ReactNode
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  empty,
  className,
  onRowClick,
  minWidthClass = 'min-w-[720px]',
  footer,
}: TableProps<T>) {
  if (!rows.length && empty) {
    return <div className={className}>{empty}</div>
  }

  return (
    <div className={cn('w-full', className)}>
      <div className="-mx-1 w-full overflow-x-auto overscroll-x-contain px-1">
        <table className={cn('w-full border-collapse text-left text-sm', minWidthClass)}>
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    'whitespace-nowrap px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400',
                    column.hideOnMobile && 'hidden md:table-cell',
                    column.headerClassName,
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  'border-b border-slate-100 last:border-0 dark:border-slate-800/70',
                  onRowClick && 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50',
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      'px-3 py-3 align-middle text-slate-700 dark:text-slate-200',
                      column.hideOnMobile && 'hidden md:table-cell',
                      column.className,
                    )}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-500 dark:text-slate-400">
          {footer}
        </div>
      ) : null}
    </div>
  )
}
