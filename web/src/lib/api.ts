import type {
  ApiErrorBody,
  Aria2Status,
  Aria2SubmitResponse,
  AuthStatus,
  BtEvictSummary,
  BtProxyPreview,
  BtProxyStatus,
  BtStatus,
  BtUploadResponse,
  CookieHarvestMeta,
  CookieHarvestStatus,
  CookiesStatus,
  DebugStatus,
  FileListResponse,
  HealthStatus,
  LogLevel,
  LogsTail,
  ModuleId,
  NetworkReport,
  ParseResult,
  PendingFilesResponse,
  ReportListResponse,
  SeedAction,
  SeedItem,
  SeedListResponse,
  Settings,
  Stats,
  SystemStatus,
  UsbStatus,
  Task,
  TaskAction,
  TaskListResponse,
  TaskQuery,
  TestTool,
} from '../types'

/**
 * 统一 API 前缀。
 *
 * - 默认留空 → buildUrl 会生成**相对路径**（如 `api/health`），
 *   于是它能同时适配两种部署：
 *     根路径部署           页面 /tasks       → api/health 解析成 /api/health
 *     nginx 子路径反代     页面 /ttdownload/ → api/health 解析成 /ttdownload/api/health
 * - 也可以用 VITE_API_BASE 显式指定（构建时注入），例如 VITE_API_BASE=/ttdownload
 *
 * 说明：本项目前端路由都是单段（/tasks、/logs…），因此相对路径解析始终正确；
 * 这样用 nginx 挂到任意子路径都不需要重新构建前端。
 */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')

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

/* ------------------------- 会话过期（401）广播 ------------------------- */

type UnauthorizedHandler = () => void

const unauthorizedHandlers = new Set<UnauthorizedHandler>()

/**
 * 订阅「会话已过期」信号：任意业务接口返回 401（且不是登录接口本身）时触发。
 * 返回取消订阅函数。React 层据此切回登录页，不需要整页刷新。
 */
export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  unauthorizedHandlers.add(handler)
  return () => {
    unauthorizedHandlers.delete(handler)
  }
}

/** 通知所有订阅者（单个订阅者抛错不影响其它订阅者） */
function notifyUnauthorized(): void {
  // 直接迭代 Set：订阅者在回调里取消订阅是安全的（已删除的元素不会再被访问）
  for (const handler of unauthorizedHandlers) {
    try {
      handler()
    } catch {
      /* 忽略订阅者自身异常 */
    }
  }
}

/**
 * 是否为鉴权接口本身（/api/auth/...）。
 * 这些接口的 401 代表「账号或密码错误」，是登录尝试失败，不是会话过期，
 * 因此不能触发全局的 unauthorized 广播。
 */
function isAuthPath(path: string): boolean {
  return path.startsWith('/api/auth/')
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  // 无显式前缀时去掉前导 '/' → 相对当前页面解析（子路径反代下自动带上前缀）
  const url = API_BASE ? `${API_BASE}${path}` : path.replace(/^\//, '')
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
    // 会话过期（Cookie 失效 / 服务端重启换了账号密码）→ 广播给 React 层切回登录页。
    // 登录接口自身的 401（BAD_CREDENTIALS）属于「这次登录输错了」，不广播。
    if (response.status === 401 && !isAuthPath(path)) notifyUnauthorized()
    throw new ApiError(code, message, response.status)
  }

  return payload as T
}

function fallbackMessage(status: number): string {
  switch (status) {
    case 400:
      return '请求参数有误'
    case 401:
      return '需要登录：请先在本页面登录'
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
  /* ------------------------------ 鉴权 ------------------------------ */

  /** 当前登录状态（公开接口，未登录也返回 200） */
  authMe: () => request<AuthStatus>('/api/auth/me'),

  /** 登录：成功后服务端种下 HttpOnly 会话 Cookie，返回最新状态 */
  authLogin: (username: string, password: string) =>
    request<AuthStatus>('/api/auth/login', jsonBody({ username, password })),

  /** 退出登录：服务端清除会话 Cookie */
  authLogout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  health: () => request<HealthStatus>('/api/health'),

  system: () => request<SystemStatus>('/api/system'),

  usb: () => request<{ usb: UsbStatus }>('/api/usb'),
  usbMount: () => request<{ usb: UsbStatus }>('/api/usb/mount', { method: 'POST' }),
  usbEject: () => request<{ usb: UsbStatus }>('/api/usb/eject', { method: 'POST' }),

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

  /* --------------------------- 问题反馈 / 诊断报告 --------------------------- */

  /** 诊断报告清单（GET /api/system/report/list），含单项下载地址与历史报告 */
  reportList: () => request<ReportListResponse>('/api/system/report/list'),

  /**
   * 完整诊断报告下载地址（zip，服务器无 zip 时后端会退化为 json）。
   * clear 不传时按服务端设置 clearLogsAfterReport 执行；传 true/false 可强制本次行为。
   */
  reportUrl: (opts: { clear?: boolean } = {}): string =>
    buildUrl('/api/system/report', { clear: opts.clear === undefined ? undefined : opts.clear ? '1' : '0' }),

  /** 历史报告 / 单个报告文件下载地址（GET /api/system/report/file?name=...） */
  reportFileUrl: (name: string): string => buildUrl('/api/system/report/file', { name }),

  /** 过滤后的日志导出地址（level 支持 all；marker / q 为空则不过滤） */
  logExportUrl: (
    opts: { level?: string; lines?: number; marker?: string; q?: string } = {},
  ): string =>
    buildUrl('/api/system/logs/export', {
      level: opts.level,
      lines: opts.lines,
      marker: opts.marker,
      q: opts.q,
    }),

  /** 部署日志下载地址（GET /api/system/deploy-log） */
  deployLogUrl: (): string => buildUrl('/api/system/deploy-log'),

  /** 任务清单导出地址（GET /api/system/report/tasks?format=json|csv） */
  tasksReportUrl: (format: 'json' | 'csv' = 'json'): string =>
    buildUrl('/api/system/report/tasks', { format }),

  /** 网络自检报告下载地址（GET /api/system/report/network） */
  networkReportUrl: (): string => buildUrl('/api/system/report/network'),

  /** 最近失败的任务（GET /api/tasks?status=failed），用于页面内展示失败原因 */
  failedTasks: (pageSize = 10) =>
    request<{ items: Task[]; total: number }>('/api/tasks', {}, {
      status: 'failed',
      pageSize,
    }),

  /* ------------------------------ 任务 ------------------------------ */

  tasks: (query: TaskQuery = {}) =>
    request<TaskListResponse>('/api/tasks', {}, {
      module: query.module,
      status: query.status,
      q: query.q,
      sort: query.sort,
      page: query.page,
      pageSize: query.pageSize,
      kind: query.kind,
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

  /** transmission 反向代理开关状态（GET /api/bt/proxy；含 nginx / transmission 诊断信息） */
  btProxy: () => request<BtProxyStatus>('/api/bt/proxy'),

  /** 反代配置预览（GET /api/bt/proxy/preview；只读，不修改任何文件） */
  btProxyPreview: () => request<BtProxyPreview>('/api/bt/proxy/preview'),

  /**
   * 开关反代（POST /api/bt/proxy）。
   * enabled=true 开启（transmission 未设 RPC 密码时后端返回 400，需 force=true）；
   * enabled=false 关闭 → nginx 配置被彻底删除，外界再也访问不到 9091。
   */
  btProxyToggle: (body: { enabled: boolean; force?: boolean; subPath?: string }) =>
    request<BtProxyStatus>('/api/bt/proxy', jsonBody(body)),

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

  /** 读取「自动获取访客 cookies」状态（GET /api/webvideo/cookies/harvest） */
  getCookieHarvest: () => request<CookieHarvestStatus>('/api/webvideo/cookies/harvest'),

  /** 立即刷新某个站点的访客 cookies（POST /api/webvideo/cookies/harvest） */
  refreshCookieHarvest: (site: string) =>
    request<{ ok: boolean; meta: CookieHarvestMeta; status: CookieHarvestStatus }>(
      '/api/webvideo/cookies/harvest',
      jsonBody({ site }),
    ),

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

  /** 待下载清单（GET /api/files/pending）：已加密归档但安卓端还没取走的成品 + 等待时长统计 */
  pendingFiles: (params: { q?: string; page?: number; pageSize?: number } = {}) =>
    request<PendingFilesResponse>('/api/files/pending', {}, params),

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
export const eventsUrl = (): string => buildUrl('/api/events')

/** 任务模块中文名 */
export const MODULE_LABELS: Record<ModuleId, string> = {
  transmission: 'BT 种子',
  aria2: 'URL 直链',
  webvideo: '公开视频',
}
