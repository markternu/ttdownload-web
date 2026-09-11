import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padded?: boolean
}

export function Card({ className, padded = true, children, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-slate-200/80 bg-white shadow-soft transition-colors',
        'dark:border-slate-800 dark:bg-slate-900',
        padded && 'p-4 sm:p-5',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

export interface CardHeaderProps {
  title: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
  className?: string
}

export function CardHeader({ title, subtitle, action, className }: CardHeaderProps) {
  return (
    <div className={cn('mb-4 flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h3 className="truncate text-base font-semibold text-slate-900 dark:text-slate-50">
          {title}
        </h3>
        {subtitle ? (
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

/** 统计卡片（Dashboard / 顶部概览使用） */
export interface StatCardProps {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  tone?: 'brand' | 'success' | 'warning' | 'danger' | 'neutral'
  className?: string
}

const TONES: Record<NonNullable<StatCardProps['tone']>, string> = {
  brand: 'bg-brand-500/10 text-brand-600 dark:text-brand-300',
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  danger: 'bg-red-500/10 text-red-600 dark:text-red-400',
  neutral: 'bg-slate-500/10 text-slate-600 dark:text-slate-300',
}

export function StatCard({ label, value, hint, icon, tone = 'neutral', className }: StatCardProps) {
  return (
    <Card className={cn('flex items-start gap-3', className)}>
      {icon ? (
        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', TONES[tone])}>
          {icon}
        </span>
      ) : null}
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
        <p className="mt-1 truncate text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50 sm:text-2xl">
          {value}
        </p>
        {hint ? <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{hint}</p> : null}
      </div>
    </Card>
  )
}
