import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppLayout } from './components/layout/AppLayout'
import { LoadingBlock } from './components/ui'
import { AppDataProvider, SettingsProvider } from './context/AppDataContext'
import { useAuth } from './context/AuthContext'
import HomePage from './pages/HomePage'
import LoginPage from './pages/LoginPage'

// 首屏之外的页面按需加载，减小首包体积
const TasksPage = lazy(() => import('./pages/TasksPage'))
const HistoryPage = lazy(() => import('./pages/HistoryPage'))
const NetworkPage = lazy(() => import('./pages/NetworkPage'))
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const Aria2Page = lazy(() => import('./pages/Aria2Page'))
const BtPage = lazy(() => import('./pages/BtPage'))
const FilesPage = lazy(() => import('./pages/FilesPage'))
const PendingFilesPage = lazy(() => import('./pages/PendingFilesPage'))
const LogsPage = lazy(() => import('./pages/LogsPage'))
const ReportPage = lazy(() => import('./pages/ReportPage'))
const ScriptsPage = lazy(() => import('./pages/ScriptsPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'))

export default function App() {
  const { loading, authenticated } = useAuth()
  const location = useLocation()

  // 登录状态未知：先整屏加载，避免未登录时闪一下控制台
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
        <LoadingBlock text="正在检查登录状态…" />
      </div>
    )
  }

  // 未登录：只暴露 /login，其余路由一律带着回跳地址重定向到登录页
  if (!authenticated) {
    const next = `${location.pathname}${location.search}`
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="*"
          element={<Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />}
        />
      </Routes>
    )
  }

  return (
    // 业务数据 Provider 只挂在已登录分支：未登录时不做任何业务接口轮询 / SSE 连接
    <SettingsProvider>
      <AppDataProvider>
        <Routes>
          {/* 已登录时 /login 仍可访问（服务端未开鉴权时展示“无需登录”提示） */}
          <Route path="/login" element={<LoginPage />} />

          <Route element={<AppLayout />}>
            <Route path="/" element={<HomePage />} />
            <Route
              path="/tasks"
              element={
                <Suspense fallback={<LoadingBlock text="正在加载任务页…" />}>
                  <TasksPage />
                </Suspense>
              }
            />
            {/* 任务区的独立列表页（一级任务页给入口） */}
            {(['tasks-waiting', 'tasks-publish', 'tasks-other'] as const).map((sub) => (
              <Route
                key={sub}
                path={`/${sub}`}
                element={
                  <Suspense fallback={<LoadingBlock text="正在加载任务列表…" />}>
                    <TasksPage />
                  </Suspense>
                }
              />
            ))}
            <Route
              path="/network"
              element={
                <Suspense fallback={<LoadingBlock text="正在检测网络…" />}>
                  <NetworkPage />
                </Suspense>
              }
            />
            <Route
              path="/history"
              element={
                <Suspense fallback={<LoadingBlock text="正在加载历史页…" />}>
                  <HistoryPage />
                </Suspense>
              }
            />
            <Route
              path="/dashboard"
              element={
                <Suspense fallback={<LoadingBlock text="正在加载统计页…" />}>
                  <DashboardPage />
                </Suspense>
              }
            />
            <Route
              path="/aria2"
              element={
                <Suspense fallback={<LoadingBlock text="正在加载模块页…" />}>
                  <Aria2Page />
                </Suspense>
              }
            />
            <Route
              path="/bt"
              element={
                <Suspense fallback={<LoadingBlock text="正在加载模块页…" />}>
                  <BtPage />
                </Suspense>
              }
            />
            <Route
              path="/files"
              element={
                <Suspense fallback={<LoadingBlock text="正在加载文件页…" />}>
                  <FilesPage />
                </Suspense>
              }
            />
            <Route
              path="/pending"
              element={
                <Suspense fallback={<LoadingBlock text="正在加载待下载页…" />}>
                  <PendingFilesPage />
                </Suspense>
              }
            />
            <Route
              path="/logs"
              element={
                <Suspense fallback={<LoadingBlock text="正在加载日志页…" />}>
                  <LogsPage />
                </Suspense>
              }
            />
            <Route
              path="/report"
              element={
                <Suspense fallback={<LoadingBlock text="正在加载问题反馈页…" />}>
                  <ReportPage />
                </Suspense>
              }
            />
            <Route
              path="/scripts"
              element={
                <Suspense fallback={<LoadingBlock text="正在加载修复脚本页…" />}>
                  <ScriptsPage />
                </Suspense>
              }
            />
            <Route
              path="/settings"
              element={
                <Suspense fallback={<LoadingBlock text="正在加载设置页…" />}>
                  <SettingsPage />
                </Suspense>
              }
            />
            <Route path="/index.html" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </AppDataProvider>
    </SettingsProvider>
  )
}
