/**
 * 子路径部署支持：推导 SPA 的 basename。
 *
 * 场景：远程服务器只开放 80，用 nginx 把 http://host/ttdownload/ 反代到后端
 *       http://127.0.0.1:8080/（nginx 去掉前缀）。此时浏览器地址是
 *       /ttdownload/、/ttdownload/tasks…，而 <BrowserRouter> 必须知道
 *       basename="/ttdownload"，否则会把 /ttdownload/tasks 当成未知路由 → 404 页面。
 *
 * 推导规则（本项目前端路由都是单段：/tasks /bt /aria2 /files /settings /logs /report /scripts /history）：
 *   - 第一个路径段就是已知路由（/tasks）→ 没有前缀（根路径部署）
 *   - 已知路由之前还有段（/ttdownload/tasks、/apps/x/logs）→ 前缀就是它前面的部分
 *   - 路径以 / 结尾且首段不是已知路由（/ttdownload/）→ 入口地址，前缀就是整段
 *   - 其它情况（例如根路径下访问 /foobar）→ 不算前缀，交给 404 页面
 *
 * 也可以用 VITE_BASE_PATH 显式指定（构建期注入），优先级最高。
 */

export const APP_ROUTES = [
  'tasks',
  'history',
  'dashboard',
  'aria2',
  'bt',
  'files',
  'settings',
  'logs',
  'report',
  'scripts',
] as const

const ROUTE_SET = new Set<string>(APP_ROUTES)

/** 推导 basename（'' 表示部署在根路径） */
export function detectBasename(pathname?: string): string {
  const envBase = (import.meta.env.VITE_BASE_PATH as string | undefined)?.trim()
  if (envBase) return `/${envBase.replace(/^\/+|\/+$/g, '')}`

  const path = pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '/')
  const segs = path.split('/').filter(Boolean)
  if (segs.length === 0) return ''

  const idx = segs.findIndex((s) => ROUTE_SET.has(s))
  if (idx === 0) return '' // /tasks → 根部署
  if (idx > 0) return `/${segs.slice(0, idx).join('/')}` // /ttdownload/tasks → /ttdownload
  // 没有已知路由：仅当是"目录式入口"（以 / 结尾）时才当作前缀
  if (path.endsWith('/')) return `/${segs.join('/')}`
  return ''
}

/** 当前部署的 basename（给 API/SSE 之外的场景用） */
export const APP_BASENAME = detectBasename()
