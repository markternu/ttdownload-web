import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from './components/layout/AppLayout'
import { LoadingBlock } from './components/ui'
import HomePage from './pages/HomePage'

// 首屏之外的页面按需加载，减小首包体积
const TasksPage = lazy(() => import('./pages/TasksPage'))
const HistoryPage = lazy(() => import('./pages/HistoryPage'))
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const Aria2Page = lazy(() => import('./pages/Aria2Page'))
const BtPage = lazy(() => import('./pages/BtPage'))
const FilesPage = lazy(() => import('./pages/FilesPage'))
const LogsPage = lazy(() => import('./pages/LogsPage'))
const ReportPage = lazy(() => import('./pages/ReportPage'))
const ScriptsPage = lazy(() => import('./pages/ScriptsPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'))

export default function App() {
  return (
    <Routes>
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
  )
}
