import type {
  ApiErrorBody,
  Aria2Status,
  Aria2SubmitResponse,
  BtEvictSummary,
  BtStatus,
  BtUploadResponse,
  CookiesStatus,
  DebugStatus,
  FileListResponse,
  HealthStatus,
  LogLevel,
  LogsTail,
  ModuleId,
  NetworkReport,
  ParseResult,
  SeedAction,
  SeedItem,
  SeedListResponse,
  Settings,
  Stats,
  SystemStatus,
  Task,
  TaskAction,
  TaskListResponse,
  TaskQuery,
  TestTool,
} from '../types'

/** 统一 API 前缀（生产同源部署时留空即可） */
export const API_BASE = import.meta.env.VITE_API_BASE ?? ''

/** 后端统一错误体（{ error: { code, message } }）对应的异常类型 */
export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

type QueryValue = string | number | boolean | null | undefined

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = `${API_BASE}${path}`
  if (!query) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${url}?${qs}` : url
}

/** 非 2xx/网络异常统一转成 ApiError（中文兜底文案） */
async function request<T>(
  path: string,
  init: RequestInit = {},
  query?: Record<string, QueryValue>,
): Promise<T> {
  const url = buildUrl(path, query)
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body && !(init.body instanceof FormData)
          ? { 'Content-Type': 'application/json; charset=utf-8' }
          : {}),
        ...(init.headers ?? {}),
      },
    })
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    throw new ApiError('NETWORK_ERROR', '网络连接中断，请检查后端服务是否运行', 0)
  }

  if (response.status === 204) return undefined as T

  const text = await response.text()
  let payload: unknown = undefined
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = undefined
    }
  }

  if (!response.ok) {
    const body = payload as ApiErrorBody | undefined
    const code = body?.error?.code ?? `HTTP_${response.status}`
    const message = body?.error?.message ?? fallbackMessage(response.status)
    throw new ApiError(code, message, response.status)
  }

  return payload as T
}

function fallbackMessage(status: number): string {
  switch (status) {
    case 400:
      return '请求参数有误'
    case 401:
      return '鉴权失败，请检查访问令牌'
    case 404:
      return '请求的资源不存在'
    case 409:
      return '当前任务状态不允许该操作'
    case 500:
      return '服务端发生错误，请稍后重试'
    default:
      return `请求失败（HTTP ${status}）`
  }
}

function jsonBody(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) }
}

/* ------------------------------- 系统 ------------------------------- */

export const api = {
  health: () => request<HealthStatus>('/api/health'),

  system: () => request<SystemStatus>('/api/system'),

  stats: () => request<Stats>('/api/stats'),

  /* ---------------------------- 日志 / 调试 ---------------------------- */

  /** 读取日志尾部（GET /api/system/logs），最新一行在数组末尾 */
  getLogs: (params: { lines?: number; level?: string; q?: string; marker?: string } = {}) =>
    request<LogsTail>('/api/system/logs', {}, {
      lines: params.lines,
      level: params.level,
      q: params.q,
      marker: params.marker,
    }),

  /** 清空全部日志文件（DELETE /api/system/logs） */
  clearLogs: () =>
    request<{ ok: boolean; cleared: number; bytes: number }>('/api/system/logs', {
      method: 'DELETE',
    }),

  /** 读取调试开关 / 日志级别（GET /api/system/debug） */
  getDebug: () => request<DebugStatus>('/api/system/debug'),

  /** 修改调试开关 / 日志级别（POST /api/system/debug），返回最新状态 */
  setDebug: (patch: { debugMode?: boolean; logLevel?: LogLevel }) =>
    request<DebugStatus>('/api/system/debug', jsonBody(patch)),

  /** 日志文件下载地址（可直接 window.open / <a download>；不传 file 时为当前日志文件） */
  logsDownloadUrl: (file?: string): string =>
    buildUrl('/api/system/logs/download', file ? { file } : undefined),

  /** 诊断包下载地址（JSON 附件，Content-Disposition: attachment） */
  diagnosticsDownloadUrl: (): string => buildUrl('/api/system/diagnostics'),

  /* ------------------------------ 任务 ------------------------------ */

  tasks: (query: TaskQuery = {}) =>
    request<TaskListResponse>('/api/tasks', {}, {
      module: query.module,
      status: query.status,
      q: query.q,
      sort: query.sort,
      page: query.page,
      pageSize: query.pageSize,
    }),

  task: (id: number) => request<Task>(`/api/tasks/${id}`),

  taskAction: (id: number, action: TaskAction, extra: { deleteFile?: boolean } = {}) =>
    request<{ ok?: boolean; task?: Task } | Task | undefined>(
      `/api/tasks/${id}/actions`,
      jsonBody({ action, ...extra }),
    ),

  /* ------------------------------ aria2 ------------------------------ */

  aria2Urls: (urls: string[]) =>
    request<Aria2SubmitResponse>('/api/aria2/urls', jsonBody({ urls })),

  aria2Status: () => request<Aria2Status>('/api/aria2/status'),

  /* -------------------------------- BT -------------------------------- */

  btUpload: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<BtUploadResponse>('/api/bt/upload', { method: 'POST', body: form })
  },

  btSeeds: () => request<SeedListResponse>('/api/bt/seeds'),

  btSeedsAction: (ids: number[], action: SeedAction) =>
    request<{ ok?: boolean; items?: SeedItem[] }>(
      '/api/bt/seeds/actions',
      jsonBody({ ids, action }),
    ),

  btStatus: () => request<BtStatus>('/api/bt/status'),

  /** BT 出清：预览（dry-run，不修改任何数据） */
  btStale: () => request<BtEvictSummary>('/api/bt/stale'),

  /** BT 出清：立即执行一次 */
  btEvict: () => request<BtEvictSummary>('/api/bt/evict', { method: 'POST' }),

  /* ----------------------------- webvideo ----------------------------- */

  webvideoParse: (url: string, signal?: AbortSignal) =>
    request<ParseResult>('/api/webvideo/parse', { ...jsonBody({ url }), signal }),

  webvideoCreateTask: (payload: {
    url: string
    formatId?: string
    quality?: string
    title?: string
  }) => request<{ task: Task }>('/api/webvideo/tasks', jsonBody(payload)),

  webvideoPlatforms: async (): Promise<string[]> => {
    const res = await request<{ platforms?: string[]; items?: string[] }>(
      '/api/webvideo/platforms',
    )
    return res.platforms ?? res.items ?? []
  },

  /** 网络自检（GET /api/webvideo/network；refresh=true 跳过服务端 60s 缓存） */
  networkCheck: (refresh = false) =>
    request<NetworkReport>('/api/webvideo/network', {}, refresh ? { refresh: 1 } : undefined),

  /** 读取当前 yt-dlp cookies 状态（GET /api/webvideo/cookies） */
  getWebvideoCookies: () => request<CookiesStatus>('/api/webvideo/cookies'),

  /** 上传 cookies.txt（POST /api/webvideo/cookies，multipart 字段名 file） */
  uploadWebvideoCookies: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<CookiesStatus>('/api/webvideo/cookies', { method: 'POST', body: form })
  },

  /** 删除服务器上的 cookies.txt（DELETE /api/webvideo/cookies） */
  deleteWebvideoCookies: () =>
    request<CookiesStatus>('/api/webvideo/cookies', { method: 'DELETE' }),

  /* ------------------------------ 文件 ------------------------------ */

  files: (query: { q?: string; page?: number; pageSize?: number } = {}) =>
    request<FileListResponse>('/api/files', {}, query),

  deleteFile: (id: number, withFile = false) =>
    request<{ ok?: boolean } | undefined>(
      `/api/files/${id}`,
      { method: 'DELETE' },
      withFile ? { withFile: 1 } : undefined,
    ),

  fileDownloadUrl: (id: number, name?: string): string => {
    const base = `${API_BASE}/api/files/${id}/download`
    return name ? `${base}?name=${encodeURIComponent(name)}` : base
  },

  /* ------------------------------ 设置 ------------------------------ */

  settings: () => request<Settings>('/api/settings'),

  updateSettings: (patch: Partial<Settings>) =>
    request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),

  testConnection: (tool: TestTool) =>
    request<{ ok: boolean; message: string }>(
      '/api/settings/test-connection',
      jsonBody({ tool }),
    ),
}

/** SSE 事件地址 */
export const eventsUrl = (): string => `${API_BASE}/api/events`

/** 任务模块中文名 */
export const MODULE_LABELS: Record<ModuleId, string> = {
  transmission: 'BT 种子',
  aria2: 'URL 直链',
  webvideo: '公开视频',
}
