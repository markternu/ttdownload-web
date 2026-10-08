import { useCallback, useState } from 'react'
import { api } from '../lib/api'
import type { Task, TaskAction, TaskBulkResult, TaskQuery } from '../types'
/** 批量动作 → 该动作对哪些状态有意义（用来算"能执行几个/跳过几个"） */
export const BULK_ELIGIBLE: Record<TaskAction, (task: Task) => boolean> = {
  pause: (t) => t.status === 'waiting' || t.status === 'downloading' || t.status === 'parsing',
  // 「恢复/继续」只对已暂停的有意义；失败/已取消的请用「重试」
  resume: (t) => t.status === 'paused',
  retry: (t) => t.status === 'failed' || t.status === 'cancelled',
  cancel: (t) => t.status !== 'completed' && t.status !== 'cancelled' && t.status !== 'failed',
  delete: () => true,
}

/** 批量动作的中文名（提示语/按钮用同一份，避免各处写不一样） */
export const BULK_ACTION_LABEL: Record<TaskAction, string> = {
  pause: '暂停',
  resume: '恢复',
  retry: '重试',
  cancel: '取消',
  delete: '删除',
}

export interface UseTaskSelectionResult {
  /** 已选中的任务 id */
  selected: Set<number>
  count: number
  isSelected: (id: number) => boolean
  toggle: (id: number) => void
  /** 全选 / 取消全选「当前页」（rows 就是当前渲染的这一页） */
  toggleAllOnPage: () => void
  /** 选中当前**筛选条件下的全部**（跨页；id 从后端按同一套筛选条件取） */
  selectAllMatching: () => Promise<void>
  clear: () => void
  allOnPageSelected: boolean
  someOnPageSelected: boolean
  /** 正在"取全部 id"（跨页全选） */
  selectingAll: boolean
}

/**
 * 任务列表的勾选状态（任务页 / 历史页 / URL 直链页共用）。
 *
 * 为什么要抽出来：这三个页面都是「useTasks + TaskCard/Table」，勾选与批量操作的
 * 语义必须完全一致（全选当前页 / 跨页全选 / 已选 N 个 / 执行后清空），
 * 各写一份迟早会出现"这个页面能全选、那个页面不能"。
 */
export function useTaskSelection(rows: Task[], query: TaskQuery = {}): UseTaskSelectionResult {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [selectingAll, setSelectingAll] = useState(false)

  const toggle = useCallback((id: number) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleAllOnPage = useCallback(() => {
    setSelected((current) => {
      const pageIds = rows.map((t) => t.id)
      const allSelected = pageIds.length > 0 && pageIds.every((id) => current.has(id))
      const next = new Set(current)
      if (allSelected) pageIds.forEach((id) => next.delete(id))
      else pageIds.forEach((id) => next.add(id))
      return next
    })
  }, [rows])

  const selectAllMatching = useCallback(async () => {
    setSelectingAll(true)
    try {
      const { ids } = await api.taskIds(query)
      setSelected(new Set(ids))
    } finally {
      setSelectingAll(false)
    }
  }, [query.module, query.status, query.q, query.sort, query.kind])

  const clear = useCallback(() => setSelected(new Set()), [])

  const allOnPageSelected = rows.length > 0 && rows.every((t) => selected.has(t.id))
  const someOnPageSelected = rows.some((t) => selected.has(t.id))

  return {
    selected,
    count: selected.size,
    isSelected: (id: number) => selected.has(id),
    toggle,
    toggleAllOnPage,
    selectAllMatching,
    clear,
    allOnPageSelected,
    someOnPageSelected,
    selectingAll,
  }
}

/** 批量执行的结果摘要（页面拿去弹 toast；把"跳过了几个"说清楚，别让人以为全成功了） */
export function summarizeBulkResult(result: TaskBulkResult): { tone: 'success' | 'warning'; title: string; description: string } {
  const label = BULK_ACTION_LABEL[result.action] ?? result.action
  const first = result.results.find((r) => !r.ok)?.message ?? ''
  if (result.failed === 0) {
    return { tone: 'success', title: `已${label} ${result.succeeded} 个任务`, description: '' }
  }
  if (result.succeeded === 0) {
    return { tone: 'warning', title: `没有任务被${label}`, description: first || `${result.failed} 个任务状态不允许` }
  }
  return {
    tone: 'warning',
    title: `已${label} ${result.succeeded} 个，${result.failed} 个跳过`,
    description: first ? `第一个跳过的原因：${first}` : '',
  }
}
