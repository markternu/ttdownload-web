import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar, NAV_ITEMS } from './Sidebar'
import { Topbar } from './Topbar'

/** 路由 → 标题映射（未命中时回退为应用名） */
function titleForPath(pathname: string): string {
  if (pathname === '/') return '在线视频下载管理器'
  const matched = NAV_ITEMS.find((item) => item.to !== '/' && pathname.startsWith(item.to))
  return matched ? matched.label : '在线视频下载管理器'
}

export function AppLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()

  // 路由变化时关闭移动端抽屉并回到顶部
  useEffect(() => {
    setDrawerOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [location.pathname])

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Sidebar open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      <div className="lg:pl-64">
        <Topbar title={titleForPath(location.pathname)} onOpenSidebar={() => setDrawerOpen(true)} />
        <main className="mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6 sm:py-6">
          <Outlet />
        </main>
        <footer className="mx-auto w-full max-w-[1400px] px-4 pb-8 pt-2 text-center text-xs text-slate-400 sm:px-6 dark:text-slate-500">
          在线视频下载管理器 · 仅用于下载你拥有权利或已获授权的公开视频资源
        </footer>
      </div>
    </div>
  )
}
