import type { ReactNode } from 'react'
import { AlertTriangle, Inbox, Loader2 } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Button } from './Button'

export interface EmptyStateProps {
  title: string
  description?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  className?: string
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-200 px-6 py-12 text-center',
        'dark:border-slate-700',
        className,
      )}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">
        {icon ?? <Inbox className="h-5 w-5" />}
      </span>
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{title}</p>
      {description ? (
        <p className="max-w-md text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

export interface ErrorStateProps {
  message: string
  onRetry?: () => void
  className?: string
  retryText?: string
}

export function ErrorState({ message, onRetry, className, retryText = '重新加载' }: ErrorStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-2xl border border-red-200 bg-red-50/60 px-6 py-10 text-center',
        'dark:border-red-900/50 dark:bg-red-950/20',
        className,
      )}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-red-100 text-red-500 dark:bg-red-900/40">
        <AlertTriangle className="h-5 w-5" />
      </span>
      <p className="max-w-md text-sm text-red-700 dark:text-red-300">{message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {retryText}
        </Button>
      ) : null}
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin text-brand-600', className)} aria-hidden />
}

export function LoadingBlock({ text = '加载中…', className }: { text?: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 py-10 text-sm text-slate-500', className)}>
      <Spinner />
      {text}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800',
        className,
      )}
    />
  )
}

export interface PaginationProps {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  className?: string
}

export function Pagination({ page, pageSize, total, onPageChange, className }: PaginationProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (total <= pageSize) return null
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        上一页
      </Button>
      <span className="text-xs text-slate-500 dark:text-slate-400">
        第 {page} / {pages} 页 · 共 {total} 条
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={page >= pages}
        onClick={() => onPageChange(page + 1)}
      >
        下一页
      </Button>
    </div>
  )
}
