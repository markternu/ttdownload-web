import { cn } from '../../lib/cn'
import { clampPercent } from '../../lib/format'

export interface ProgressBarProps {
  /** 0-100 */
  value: number
  className?: string
  tone?: 'brand' | 'success' | 'warning' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  showLabel?: boolean
  animated?: boolean
  label?: string
}

const TONES = {
  brand: 'bg-brand-600',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
}

const SIZES = {
  sm: 'h-1.5',
  md: 'h-2.5',
  lg: 'h-3.5',
}

export function ProgressBar({
  value,
  className,
  tone = 'brand',
  size = 'md',
  showLabel = false,
  animated = true,
  label,
}: ProgressBarProps) {
  const percent = clampPercent(value)
  return (
    <div className={cn('w-full', className)}>
      {showLabel ? (
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="font-medium text-slate-600 dark:text-slate-300">{label ?? '下载进度'}</span>
          <span className="font-mono font-semibold text-slate-800 tabular-nums dark:text-slate-100">
            {percent.toFixed(percent % 1 === 0 ? 0 : 1)}%
          </span>
        </div>
      ) : null}
      <div
        className={cn(
          'w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800',
          SIZES[size],
        )}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500 ease-out',
            TONES[tone],
            animated && percent > 0 && percent < 100 && 'animate-pulse',
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
