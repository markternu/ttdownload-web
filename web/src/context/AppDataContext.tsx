import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { api } from '../lib/api'
import type { Settings, SpaceFreedEvent, SseFileEvent, Stats, SseTaskEvent, SystemStatus } from '../types'
import type { SseStatus } from '../hooks/useSse'
import { useSse } from '../hooks/useSse'

/* ------------------------- 事件订阅（组件级） ------------------------- */

type TaskEventListener = (task: SseTaskEvent) => void
type FileEventListener = (event: SseFileEvent) => void

const taskListeners = new Set<TaskEventListener>()
const fileListeners = new Set<FileEventListener>()

/** 订阅任务实时事件（SSE），返回取消订阅函数 */
export function subscribeTaskEvents(listener: TaskEventListener): () => void {
  taskListeners.add(listener)
  return () => taskListeners.delete(listener)
}

/** 订阅发布文件实时事件（SSE），返回取消订阅函数 */
export function subscribeFileEvents(listener: FileEventListener): () => void {
  fileListeners.add(listener)
  return () => fileListeners.delete(listener)
}

/** 订阅 SSE 任务事件的 hook */
export function useTaskEvents(listener: TaskEventListener): void {
  const ref = useRef(listener)
  ref.current = listener
  useEffect(() => subscribeTaskEvents((task) => ref.current(task)), [])
}

/** 订阅 SSE 文件事件的 hook */
export function useFileEvents(listener: FileEventListener): void {
  const ref = useRef(listener)
  ref.current = listener
  useEffect(() => subscribeFileEvents((event) => ref.current(event)), [])
}

/* ---------------------------- 全局应用数据 ---------------------------- */

export interface AppDataValue {
  stats: Stats | null
  system: SystemStatus | null
  sseStatus: SseStatus
  loading: boolean
  error: string | null
  lastTaskEvent: SseTaskEvent | null
  lastFileEvent: SseFileEvent | null
  /** 最近一次“空间已腾挪”广播（用于提示与刷新） */
  lastSpaceEvent: SpaceFreedEvent | null
  refreshStats: () => Promise<void>
  refreshSystem: () => Promise<void>
  refreshAll: () => Promise<void>
}

const AppDataContext = createContext<AppDataValue | null>(null)

const STATS_POLL_MS = 30_000
const SYSTEM_POLL_MS = 60_000

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [system, setSystem] = useState<SystemStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastTaskEvent, setLastTaskEvent] = useState<SseTaskEvent | null>(null)
  const [lastFileEvent, setLastFileEvent] = useState<SseFileEvent | null>(null)
  const [lastSpaceEvent, setLastSpaceEvent] = useState<SpaceFreedEvent | null>(null)

  const refreshStats = useCallback(async () => {
    try {
      const data = await api.stats()
      setStats(data)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  const refreshSystem = useCallback(async () => {
    try {
      const data = await api.system()
      setSystem(data)
    } catch {
      // 系统状态失败不打断页面（后端未启动属于常见场景）
    }
  }, [])

  const refreshAll = useCallback(async () => {
    setLoading(true)
    await Promise.all([refreshStats(), refreshSystem()])
    setLoading(false)
  }, [refreshStats, refreshSystem])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  // 兜底轮询：SSE 异常时的降级路径
  useEffect(() => {
    const statsTimer = window.setInterval(() => void refreshStats(), STATS_POLL_MS)
    const systemTimer = window.setInterval(() => void refreshSystem(), SYSTEM_POLL_MS)
    return () => {
      window.clearInterval(statsTimer)
      window.clearInterval(systemTimer)
    }
  }, [refreshStats, refreshSystem])

  const sseStatus = useSse({
    onStats: (data) => setStats(data as Stats),
    onTask: (data) => {
      const event = data as SseTaskEvent
      setLastTaskEvent(event)
      for (const listener of taskListeners) listener(event)
    },
    onFile: (data) => {
      const event = data as SseFileEvent
      setLastFileEvent(event)
      for (const listener of fileListeners) listener(event)
    },
    onLog: () => {
      // 日志事件当前仅用于调试，可在浏览器 Network/EventStream 面板查看
    },
    onSpace: (data) => {
      // 空间腾挪广播：刷新磁盘与统计，页面上的等待/下载任务会随之更新
      setLastSpaceEvent(data as SpaceFreedEvent)
      void refreshSystem()
      void refreshStats()
    },
  })

  // SSE 连接恢复后刷新一次统计，抵消离线期间的漂移
  useEffect(() => {
    if (sseStatus === 'open') void refreshStats()
  }, [sseStatus, refreshStats])

  const value = useMemo<AppDataValue>(
    () => ({
      stats,
      system,
      sseStatus,
      loading,
      error,
      lastTaskEvent,
      lastFileEvent,
      lastSpaceEvent,
      refreshStats,
      refreshSystem,
      refreshAll,
    }),
    [
      stats,
      system,
      sseStatus,
      loading,
      error,
      lastTaskEvent,
      lastFileEvent,
      lastSpaceEvent,
      refreshStats,
      refreshSystem,
      refreshAll,
    ],
  )

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>
}

export function useAppData(): AppDataValue {
  const context = useContext(AppDataContext)
  if (!context) throw new Error('useAppData 必须在 AppDataProvider 内使用')
  return context
}

/* ------------------------------ 设置缓存 ------------------------------ */

export interface SettingsValue {
  settings: Settings | null
  loading: boolean
  error: string | null
  saving: boolean
  refresh: () => Promise<void>
  save: (patch: Partial<Settings>) => Promise<Settings | null>
}

const SettingsContext = createContext<SettingsValue | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.settings()
      setSettings(data)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  const save = useCallback(async (patch: Partial<Settings>) => {
    setSaving(true)
    try {
      const data = await api.updateSettings(patch)
      setSettings(data)
      return data
    } finally {
      setSaving(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const value = useMemo<SettingsValue>(
    () => ({ settings, loading, error, saving, refresh, save }),
    [settings, loading, error, saving, refresh, save],
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettingsStore(): SettingsValue {
  const context = useContext(SettingsContext)
  if (!context) throw new Error('useSettingsStore 必须在 SettingsProvider 内使用')
  return context
}
