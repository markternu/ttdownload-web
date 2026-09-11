import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'brand'

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  info: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  danger: 'bg-red-500/10 text-red-600 dark:text-red-400',
  brand: 'bg-brand-500/10 text-brand-600 dark:text-brand-300',
}

export interface BadgeProps {
  children: ReactNode
  tone?: BadgeTone
  dot?: boolean
  pulse?: boolean
  className?: string
}

export function Badge({ children, tone = 'neutral', dot = false, pulse = false, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium',
        TONES[tone],
        className,
      )}
    >
      {dot ? (
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full bg-current',
            pulse && 'animate-pulse',
          )}
        />
      ) : null}
      {children}
    </span>
  )
}
