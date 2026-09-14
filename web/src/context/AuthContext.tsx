/**
 * 全站登录状态
 *
 * - 启动时调用一次 GET /api/auth/me（公开接口）判断是否需要登录、是否已登录；
 * - 业务接口返回 401 时，api.ts 会广播「会话过期」，这里收到后立刻把
 *   authenticated 置为 false，界面自动回到登录页（不整页刷新）；
 * - 登录 / 退出都直接复用 api.ts 的相对地址请求，因此子路径反代下同样可用。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, onUnauthorized } from '../lib/api'
import type { AuthStatus } from '../types'

export interface AuthValue {
  /** 首次拉取 /api/auth/me 是否仍在进行中 */
  loading: boolean
  /** 服务端是否配置了账号密码（false = 无需登录） */
  enabled: boolean
  authenticated: boolean
  username: string | null
  /** 拉取登录状态失败的原因（后端未启动 / 网络中断），可直接展示 */
  error: string | null
  login: (username: string, password: string) => Promise<AuthStatus>
  logout: () => Promise<void>
  /** 重新拉取登录状态 */
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [username, setUsername] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const applyStatus = useCallback((status: AuthStatus) => {
    setEnabled(status.enabled)
    // 服务端未配置账号密码时无需登录（后端此时也返回 authenticated:true，这里再兜底一次）
    setAuthenticated(status.authenticated || !status.enabled)
    setUsername(status.username)
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      applyStatus(await api.authMe())
      setError(null)
    } catch (err) {
      // 拉不到状态（后端未启动 / 网络中断）→ 按未登录处理，让用户看到登录页与错误提示
      setAuthenticated(false)
      setUsername(null)
      setError((err as Error)?.message || '无法获取登录状态，请确认后端服务是否运行')
    } finally {
      setLoading(false)
    }
  }, [applyStatus])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 会话过期（业务接口 401）→ 直接切回未登录，由 App 的路由守卫渲染登录页
  useEffect(
    () =>
      onUnauthorized(() => {
        setAuthenticated(false)
        setUsername(null)
      }),
    [],
  )

  const login = useCallback(
    async (user: string, password: string) => {
      const status = await api.authLogin(user, password)
      applyStatus(status)
      setError(null)
      return status
    },
    [applyStatus],
  )

  const logout = useCallback(async () => {
    try {
      await api.authLogout()
    } catch {
      // 请求失败也要让界面退出到登录页（Cookie 失效时本身也没什么可清的）
    } finally {
      setAuthenticated(false)
      setUsername(null)
    }
  }, [])

  const value = useMemo<AuthValue>(
    () => ({ loading, enabled, authenticated, username, error, login, logout, refresh }),
    [loading, enabled, authenticated, username, error, login, logout, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return context
}
