import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useTaskEvents } from '../context/AppDataContext'
import { isActiveTask, isPublishTask } from '../lib/format'
import type { SseTaskEvent, Task, TaskAction, TaskListResponse, TaskQuery } from '../types'

const POLL_MS = 3000

export interface UseTasksResult {
  tasks: Task[]
  total: number
  page: number
  pages: number
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  setPage: (page: number) => void
  /** 对任务执行动作，成功后自动刷新 */
  act: (id: number, action: TaskAction, deleteFile?: boolean) => Promise<boolean>
  /** 正在执行动作的任务 id 集合 */
  pendingIds: number[]
  /** 与 total 同源的统计口径（下载任务 / 归档发布子任务） */
  summary?: TaskListResponse['summary']
}

/**
 * 任务列表数据源：
 * - 首次/条件变化时拉取 GET /api/tasks；
 * - SSE 收到 task 事件时原地合并，避免整表刷新造成闪烁；
 * - 存在活动任务时按 3 秒轮询兜底（SSE 不可用的降级方案）。
 */
export function useTasks(query: TaskQuery, options: { poll?: boolean } = {}): UseTasksResult {
  const { module = '', status = '', q = '', sort = 'created_desc', pageSize = 20 } = query
  const [page, setPage] = useState(query.page ?? 1)
  const [tasks, setTasks] = useState<Task[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<TaskListResponse['summary']>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pendingIds, setPendingIds] = useState<number[]>([])
  const queryRef = useRef({ module, status, q, sort, pageSize, page })
  queryRef.current = { module, status, q, sort, pageSize, page }

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await api.tasks({
        module: module || undefined,
        status: status || undefined,
        q: q || undefined,
        sort,
        page: queryRef.current.page,
        pageSize,
      })
      setTasks(res.items ?? [])
      setTotal(res.total ?? 0)
      setSummary(res.summary)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [module, status, q, sort, pageSize])

  // 条件变化时回到第一页并重新加载
  useEffect(() => {
    setPage(1)
  }, [module, status, q, sort, pageSize])

  useEffect(() => {
    void load()
  }, [load, page])

  // SSE 增量合并：已存在的任务原地更新，不再匹配筛选条件的任务移除
  useTaskEvents((event: SseTaskEvent) => {
    if (!event || typeof event.id !== 'number') return
    setTasks((current) => {
      const index = current.findIndex((task) => task.id === event.id)
      if (index === -1) return current
      const merged: Task = { ...current[index], ...event }
      const matchesModule = !queryRef.current.module || merged.module === queryRef.current.module
      const statusList = queryRef.current.status
        ? queryRef.current.status.split(',').map((item) => item.trim())
        : []
      const matchesStatus = !statusList.length || statusList.includes(merged.status)
      if (!matchesModule || !matchesStatus) {
        return current.filter((task) => task.id !== event.id)
      }
      const next = [...current]
      next[index] = merged
      return next
    })
  })

  const hasActive = useMemo(() => tasks.some((task) => isActiveTask(task)), [tasks])
  const shouldPoll = options.poll !== false && hasActive

  useEffect(() => {
    if (!shouldPoll) return
    const timer = window.setInterval(() => void load(true), POLL_MS)
    return () => window.clearInterval(timer)
  }, [shouldPoll, load])

  const act = useCallback(
    async (id: number, action: TaskAction, deleteFile = false): Promise<boolean> => {
      setPendingIds((current) => [...current, id])
      try {
        await api.taskAction(id, action, deleteFile ? { deleteFile: true } : {})
        if (action === 'delete') {
          setTasks((current) => current.filter((task) => task.id !== id))
          setTotal((current) => Math.max(0, current - 1))
        } else {
          await load(true)
        }
        return true
      } catch (err) {
        setError((err as Error).message)
        throw err
      } finally {
        setPendingIds((current) => current.filter((item) => item !== id))
      }
    },
    [load],
  )

  const pages = Math.max(1, Math.ceil(total / (pageSize || 20)))

  return {
    tasks,
    total,
    page,
    pages,
    loading,
    error,
    refresh: () => load(true),
    setPage,
    act,
    pendingIds,
    summary,
  }
}

/** 按状态对任务分组（任务页分区展示） */
export function groupBySection(tasks: Task[]) {
  const downloading: Task[] = []
  const waiting: Task[] = []
  const publish: Task[] = []
  const finished: Task[] = []
  const failed: Task[] = []
  for (const task of tasks) {
    if (task.status === 'failed') failed.push(task)
    else if (task.status === 'completed' || task.status === 'cancelled') finished.push(task)
    // 「归档 → 加密 → 发布」是扫货为每个目录**另建**的子任务（不是种子下载任务）→ 单独一档，
    // 否则 14 个种子会混着 9 个发布子任务一起显示，看着就是"乱七八糟"
    else if (isPublishTask(task)) publish.push(task)
    else if (
      task.status === 'downloading' ||
      task.status === 'paused' ||
      task.status === 'archiving' ||
      task.status === 'encrypting'
    ) {
      downloading.push(task)
    } else waiting.push(task)
  }
  return { downloading, waiting, publish, finished, failed }
}
