/**
 * 登录页（路由 /login）
 *
 * - 独立于 AppLayout，不渲染任何侧边栏 / 顶栏；
 * - 登录成功后回跳到 ?next= 指定的页面（只接受站内路径），否则回首页；
 * - 服务端未配置账号密码（enabled=false）时显示提示并允许直接进入。
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AlertCircle, ArrowRight, Download, KeyRound, LogIn, ShieldCheck, UserRound } from 'lucide-react'
import { Button, Input } from '../components/ui'
import { useAuth } from '../context/AuthContext'

/** 从 ?next= 取出回跳地址：只接受站内路径，避免被 ?next=//evil.com 带到外站 */
function resolveNext(search: string): string {
  const raw = new URLSearchParams(search).get('next') ?? ''
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/'
  // 回跳目标就是登录页本身 → 无意义，回首页
  if (raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/login/')) return '/'
  return raw
}

export default function LoginPage() {
  const { enabled, authenticated, username, error: statusError, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const next = resolveNext(location.search)

  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const enter = () => navigate(next, { replace: true })

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    if (!user.trim() || !password) {
      setError('请输入账号和密码')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      await login(user.trim(), password)
      enter()
    } catch (err) {
      // 直接展示后端返回的中文原因（账号或密码错误 / 失败次数过多…）
      setError((err as Error)?.message || '登录失败，请稍后重试')
      setSubmitting(false)
    }
  }

  const errorText = error ?? statusError

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 dark:bg-slate-950">
      <div className="w-full max-w-[400px]">
        <div className="mb-5 flex flex-col items-center gap-2.5 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-soft">
            <Download className="h-6 w-6" />
          </span>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            ttdownload-web 下载管理器
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {enabled ? '请先登录后再使用' : '当前无需登录'}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-soft sm:p-6 dark:border-slate-800 dark:bg-slate-900">
          {enabled ? (
            <form className="space-y-4" onSubmit={handleSubmit}>
              <Input
                label="用户名"
                value={user}
                onChange={(event) => setUser(event.target.value)}
                placeholder="请输入用户名"
                autoComplete="username"
                autoFocus
                disabled={submitting}
                leading={<UserRound className="h-4 w-4" />}
              />
              <Input
                label="密码"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="请输入密码"
                autoComplete="current-password"
                disabled={submitting}
                leading={<KeyRound className="h-4 w-4" />}
              />

              {errorText ? (
                <p className="flex items-start gap-1.5 rounded-xl bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700 dark:bg-red-950/30 dark:text-red-300">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{errorText}</span>
                </p>
              ) : null}

              <Button type="submit" size="lg" block loading={submitting} icon={<LogIn className="h-4 w-4" />}>
                登录
              </Button>

              {authenticated ? (
                <Button type="button" variant="ghost" size="sm" block onClick={enter}>
                  直接进入{username ? `（当前已登录：${username}）` : ''}
                </Button>
              ) : null}
            </form>
          ) : (
            <div className="space-y-4">
              <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-3 text-xs leading-relaxed text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/25 dark:text-amber-300">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  服务端未配置账号密码，当前无需登录
                  <br />
                  （.env 里的 WEB_AUTH_USER / WEB_AUTH_PASSWORD 为空）
                </span>
              </p>

              {errorText ? (
                <p className="flex items-start gap-1.5 rounded-xl bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700 dark:bg-red-950/30 dark:text-red-300">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{errorText}</span>
                </p>
              ) : null}

              <Button size="lg" block onClick={enter} icon={<ArrowRight className="h-4 w-4" />}>
                直接进入
              </Button>
            </div>
          )}
        </div>

        <p className="mt-4 px-1 text-center text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
          账号密码见部署时终端输出的「网页登录账号」，或服务器{' '}
          <code className="rounded bg-slate-100 px-1 py-px font-mono text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            .env
          </code>{' '}
          里的{' '}
          <code className="rounded bg-slate-100 px-1 py-px font-mono text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            WEB_AUTH_USER
          </code>{' '}
          /{' '}
          <code className="rounded bg-slate-100 px-1 py-px font-mono text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            WEB_AUTH_PASSWORD
          </code>
        </p>
      </div>
    </div>
  )
}
