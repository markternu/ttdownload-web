import type { SeedItem, Task, TaskStatus } from '../types'

/* ------------------------------ 字节 / 速度 ------------------------------ */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/** 人类可读字节数，如 18.7 GB；0 或未知返回 '—' */
export function formatBytes(bytes: number | null | undefined, unknownText = '—'): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes) || bytes <= 0) {
    return unknownText
  }
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${UNITS[unit]}`
}

/** 速度展示，0 显示为 '—' */
export function formatSpeed(bps: number | null | undefined): string {
  if (!bps || bps <= 0) return '—'
  return `${formatBytes(bps)}/s`
}

/** 秒 → mm:ss / hh:mm:ss */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '—'
  }
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** 剩余时间（与 formatDuration 同格式，未知返回“未知”） */
export function formatEta(etaSec: number | null | undefined): string {
  if (etaSec === null || etaSec === undefined || !Number.isFinite(etaSec) || etaSec < 0) {
    return '未知'
  }
  return formatDuration(etaSec)
}

/* -------------------------------- 时间 -------------------------------- */

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`
}

/** 相对时间，如 “3 分钟前” */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const diff = Date.now() - date.getTime()
  if (diff < 0) return formatDateTime(iso)
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return formatDate(iso)
}

/* ------------------------------ 状态元信息 ------------------------------ */

export interface StatusMeta {
  label: string
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'brand'
}

const STATUS_META: Record<TaskStatus, StatusMeta> = {
  waiting: { label: '等待中', tone: 'warning' },
  parsing: { label: '解析中', tone: 'info' },
  downloading: { label: '下载中', tone: 'brand' },
  paused: { label: '已暂停', tone: 'neutral' },
  archiving: { label: '归档中', tone: 'info' },
  encrypting: { label: '加密中', tone: 'info' },
  completed: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
}

export function statusMeta(status: TaskStatus | string): StatusMeta {
  return STATUS_META[status as TaskStatus] ?? { label: String(status), tone: 'neutral' }
}

export const TASK_STATUS_OPTIONS: { value: TaskStatus; label: string }[] = (
  Object.keys(STATUS_META) as TaskStatus[]
).map((value) => ({ value, label: STATUS_META[value].label }))

const SEED_STATUS_META: Record<SeedItem['status'], StatusMeta> = {
  pending: { label: '待入队', tone: 'warning' },
  queued: { label: '已入队', tone: 'info' },
  downloading: { label: '下载中', tone: 'brand' },
  done: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
}

export function seedStatusMeta(status: SeedItem['status'] | string): StatusMeta {
  return SEED_STATUS_META[status as SeedItem['status']] ?? { label: String(status), tone: 'neutral' }
}

/* --------------------------- 任务校验与派生 --------------------------- */

/** 是否处于活动状态（需要实时刷新） */
export function isActiveTask(task: Pick<Task, 'status'>): boolean {
  return (
    task.status === 'downloading' ||
    task.status === 'parsing' ||
    task.status === 'waiting' ||
    task.status === 'archiving' ||
    task.status === 'encrypting'
  )
}

export function isFinishedTask(task: Pick<Task, 'status'>): boolean {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'
}

/** 任务可用于展示的大小：优先 totalBytes，其次 expectBytes */
export function taskSizeBytes(task: Task): number {
  return task.totalBytes > 0 ? task.totalBytes : task.expectBytes
}

/** 任务质量/格式展示 */
export function taskQuality(task: Task): string {
  return task.meta?.resolution ?? '—'
}

export function taskFormat(task: Task): string {
  const format = task.meta?.format
  if (!format) return '—'
  return format.toUpperCase()
}

/** 从错误码/消息映射到清晰中文提示 */
export function humanizeError(code: string, message: string): string {
  const map: Record<string, string> = {
    NETWORK_ERROR: '网络连接中断，请检查后端服务是否运行',
    INVALID_URL: 'URL 格式错误，请检查链接是否完整（需以 http/https 开头）',
    UNSUPPORTED_PLATFORM: '当前平台不支持',
    PLATFORM_UNSUPPORTED: '当前平台不支持',
    VIDEO_NOT_FOUND: '视频资源不可访问或已被删除',
    VIDEO_UNAVAILABLE: '视频资源不可访问',
    PARSE_TIMEOUT: '视频解析超时，请稍后重试',
    NO_SPACE: '磁盘空间不足，请清理空间后重试',
    DISK_FULL: '磁盘空间不足，请清理空间后重试',
    DUPLICATE_TASK: '该视频已在下载队列中',
    TASK_NOT_FOUND: '任务不存在',
    CONFLICT: '当前任务状态不允许该操作',
    WRITE_FAILED: '文件写入失败，请检查目录权限',
    DOWNLOAD_TIMEOUT: '下载超时',
  }
  if (message && message.trim()) return message
  return map[code] ?? map[code.toUpperCase()] ?? '操作失败，请稍后重试'
}

/** 磁盘空间是否紧张（可用空间低于阈值） */
export function isLowSpace(freeBytes: number, reserveBytes: number): boolean {
  if (!Number.isFinite(freeBytes)) return false
  return freeBytes - reserveBytes <= 0
}

/** 已用比例 0-1 */
export function ratio(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0
  return Math.min(1, Math.max(0, part / whole))
}

export function clampPercent(value: number | null | undefined): number {
  if (value === null || value === undefined || Number.isNaN(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10))
}
