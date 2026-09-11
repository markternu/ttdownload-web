import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ToastViewport } from '../components/ui/Toast'
import type { ToastItem, ToastTone } from '../components/ui/Toast'

export interface ToastOptions {
  tone?: ToastTone
  title: string
  description?: string
  duration?: number
}

interface ToastContextValue {
  push: (options: ToastOptions) => number
  success: (title: string, description?: string) => number
  error: (title: string, description?: string) => number
  info: (title: string, description?: string) => number
  warning: (title: string, description?: string) => number
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const DEFAULT_DURATION = 4000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id))
  }, [])

  const push = useCallback(
    (options: ToastOptions) => {
      const id = nextId.current++
      const duration = options.duration ?? DEFAULT_DURATION
      setToasts((current) => {
        const next = [
          ...current,
          {
            id,
            tone: options.tone ?? 'info',
            title: options.title,
            description: options.description,
            duration,
          },
        ]
        // 最多同时展示 4 条，避免刷屏
        return next.slice(-4)
      })
      if (duration > 0) {
        window.setTimeout(() => dismiss(id), duration)
      }
      return id
    },
    [dismiss],
  )

  const value = useMemo<ToastContextValue>(
    () => ({
      push,
      dismiss,
      success: (title, description) => push({ tone: 'success', title, description }),
      error: (title, description) => push({ tone: 'error', title, description, duration: 6000 }),
      info: (title, description) => push({ tone: 'info', title, description }),
      warning: (title, description) => push({ tone: 'warning', title, description, duration: 6000 }),
    }),
    [push, dismiss],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onClose={dismiss} />
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast 必须在 ToastProvider 内使用')
  return context
}
