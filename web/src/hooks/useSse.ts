import { useEffect, useRef, useState } from 'react'
import { eventsUrl } from '../lib/api'

export type SseStatus = 'connecting' | 'open' | 'closed'

export interface SseHandlers {
  /** event: task */
  onTask?: (data: unknown) => void
  /** event: stats */
  onStats?: (data: unknown) => void
  /** event: file */
  onFile?: (data: unknown) => void
  /** event: log */
  onLog?: (data: unknown) => void
  /** event: space（空间已腾挪广播） */
  onSpace?: (data: unknown) => void
  /** 连接状态变化 */
  onStatus?: (status: SseStatus) => void
}

const EVENT_NAMES = ['task', 'stats', 'file', 'log', 'space'] as const

/** 全局重连触发（供顶部“实时连接”指示器点击重连使用） */
const reconnectListeners = new Set<() => void>()

export function reconnectSse(): void {
  for (const listener of reconnectListeners) listener()
}

/**
 * 订阅后端 SSE（/api/events）。
 * - 断线自动重连：优先使用 EventSource 原生重连；若连接被彻底关闭（readyState=CLOSED）
 *   则按指数退避（1s → 2s → 4s …，最长 30s）重建连接；
 * - 页面重新可见 / 网络恢复在线时立即重连，避免移动端切后台后长期失联；
 * - 组件卸载时关闭连接，定时器与监听器全部清理。
 */
export function useSse(handlers: SseHandlers, enabled = true): SseStatus {
  const [status, setStatus] = useState<SseStatus>('closed')
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    if (!enabled) {
      setStatus('closed')
      handlersRef.current.onStatus?.('closed')
      return
    }

    let source: EventSource | null = null
    let retryTimer: number | null = null
    let attempt = 0
    let disposed = false

    const clearRetry = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer)
        retryTimer = null
      }
    }

    const updateStatus = (next: SseStatus) => {
      setStatus(next)
      handlersRef.current.onStatus?.(next)
    }

    const connect = () => {
      if (disposed) return
      clearRetry()
      try {
        source = new EventSource(eventsUrl(), { withCredentials: false })
      } catch {
        updateStatus('closed')
        scheduleReconnect()
        return
      }

      updateStatus('connecting')

      source.onopen = () => {
        attempt = 0
        updateStatus('open')
      }

      for (const name of EVENT_NAMES) {
        source.addEventListener(name, ((event: MessageEvent<string>) => {
          let data: unknown = event.data
          try {
            data = JSON.parse(event.data)
          } catch {
            /* 非 JSON 事件按原始字符串透传 */
          }
          const current = handlersRef.current
          if (name === 'task') current.onTask?.(data)
          else if (name === 'stats') current.onStats?.(data)
          else if (name === 'file') current.onFile?.(data)
          else if (name === 'space') current.onSpace?.(data)
          else current.onLog?.(data)
        }) as EventListener)
      }

      source.onerror = () => {
        if (disposed) return
        updateStatus('connecting')
        if (source && source.readyState === EventSource.CLOSED) {
          source.close()
          source = null
          updateStatus('closed')
          scheduleReconnect()
        }
      }
    }

    function scheduleReconnect() {
      if (disposed) return
      clearRetry()
      const delay = Math.min(30_000, 1000 * 2 ** attempt)
      attempt += 1
      retryTimer = window.setTimeout(() => {
        retryTimer = null
        connect()
      }, delay)
    }

    const onVisible = () => {
      if (document.visibilityState !== 'visible' || disposed) return
      if (!source || source.readyState === EventSource.CLOSED) {
        attempt = 0
        connect()
      }
    }

    const onOnline = () => {
      if (disposed) return
      attempt = 0
      if (!source || source.readyState === EventSource.CLOSED) connect()
    }

    const forceReconnect = () => {
      if (disposed) return
      attempt = 0
      source?.close()
      source = null
      connect()
    }

    connect()
    reconnectListeners.add(forceReconnect)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)

    return () => {
      disposed = true
      clearRetry()
      reconnectListeners.delete(forceReconnect)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      source?.close()
      source = null
    }
  }, [enabled])

  return status
}
