import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'

/** 通用异步数据加载（含 loading / error / 手动刷新） */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[],
  options: { immediate?: boolean } = {},
): {
  data: T | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  setData: (value: T | null) => void
} {
  const { immediate = true } = options
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(immediate)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    setLoading(true)
    try {
      const result = await loader()
      setData(result)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    if (!immediate) return
    void run()
  }, [run, immediate])

  return { data, loading, error, refresh: run, setData }
}

/** 发布文件列表（GET /api/files） */
export function useFiles(query: { q?: string; page?: number; pageSize?: number }) {
  const { q = '', page = 1, pageSize = 20 } = query
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.files>>['items']>([])
  const [total, setTotal] = useState(0)
  const [totalBytes, setTotalBytes] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.files({ q: q || undefined, page, pageSize })
      setItems(res.items ?? [])
      setTotal(res.total ?? 0)
      setTotalBytes(res.totalBytes ?? 0)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [q, page, pageSize])

  useEffect(() => {
    void load()
  }, [load])

  return { items, total, totalBytes, loading, error, refresh: load, setItems }
}

/** 防抖值（搜索框用） */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/** 媒体查询（响应式布局用） */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false,
  )

  useEffect(() => {
    if (!window.matchMedia) return
    const media = window.matchMedia(query)
    const listener = (event: MediaQueryListEvent) => setMatches(event.matches)
    setMatches(media.matches)
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [query])

  return matches
}
