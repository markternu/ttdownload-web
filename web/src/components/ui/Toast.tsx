import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { cn } from '../../lib/cn'

export type ToastTone = 'success' | 'error' | 'info' | 'warning'

export interface ToastItem {
  id: number
  tone: ToastTone
  title: string
  description?: string
  duration: number
}

const TONES: Record<ToastTone, { icon: ReactNode; ring: string; iconColor: string }> = {
  success: {
    icon: <CheckCircle2 className="h-5 w-5" />,
    ring: 'border-emerald-200 dark:border-emerald-900/60',
    iconColor: 'text-emerald-500',
  },
  error: {
    icon: <XCircle className="h-5 w-5" />,
    ring: 'border-red-200 dark:border-red-900/60',
    iconColor: 'text-red-500',
  },
  warning: {
    icon: <AlertTriangle className="h-5 w-5" />,
    ring: 'border-amber-200 dark:border-amber-900/60',
    iconColor: 'text-amber-500',
  },
  info: {
    icon: <Info className="h-5 w-5" />,
    ring: 'border-slate-200 dark:border-slate-700',
    iconColor: 'text-brand-500',
  },
}

export interface ToastProps {
  toast: ToastItem
  onClose: (id: number) => void
}

export function Toast({ toast, onClose }: ToastProps) {
  const tone = TONES[toast.tone]
  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border bg-white p-3.5 shadow-lift',
        'animate-slide-in-right dark:bg-slate-900',
        tone.ring,
      )}
    >
      <span className={cn('mt-0.5 shrink-0', tone.iconColor)}>{tone.icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">{toast.title}</p>
        {toast.description ? (
          <p className="mt-1 break-words text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {toast.description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onClose(toast.id)}
        aria-label="关闭提示"
        className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

export interface ToastViewportProps {
  toasts: ToastItem[]
  onClose: (id: number) => void
}

export function ToastViewport({ toasts, onClose }: ToastViewportProps) {
  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-3 z-[60] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-5 sm:bottom-5">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onClose={onClose} />
      ))}
    </div>
  )
}
