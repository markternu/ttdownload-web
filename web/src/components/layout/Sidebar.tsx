import { NavLink } from 'react-router-dom'
import {
  BarChart3,
  CheckCircle2,
  Database,
  Download,
  FileVideo2,
  HardDrive,
  History,
  Link2,
  ListChecks,
  Magnet,
  Settings as SettingsIcon,
  Video,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatBytes } from '../../lib/format'
import { useAppData } from '../../context/AppDataContext'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  description: string
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '首页', icon: Video, description: '粘贴链接，解析并加入下载队列' },
  { to: '/tasks', label: '任务', icon: ListChecks, description: '下载中 / 等待中 / 已完成 / 失败' },
  { to: '/history', label: '历史', icon: History, description: '检索、筛选与删除历史记录' },
  { to: '/dashboard', label: 'Dashboard', icon: BarChart3, description: '数据统计与趋势图表' },
  { to: '/aria2', label: 'URL 直链', icon: Link2, description: '批量提交直链下载任务' },
  { to: '/bt', label: 'BT 种子', icon: Magnet, description: '上传种子 zip 并入队' },
  { to: '/files', label: '已发布文件', icon: FileVideo2, description: '消费者目录中的加密成品' },
  { to: '/settings', label: '设置', icon: SettingsIcon, description: '下载 / 网络 / 外观 / 系统' },
]

export interface SidebarProps {
  open: boolean
  onClose: () => void
}

function SidebarContent({ onClose }: { onClose: () => void }) {
  const { stats, system } = useAppData()

  const diskPercent =
    system && system.disk.totalBytes > 0
      ? Math.round((system.disk.usedBytes / system.disk.totalBytes) * 100)
      : 0

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto px-4 py-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
            <Download className="h-5 w-5" />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">下载管理器</p>
            <p className="text-[11px] text-slate-400">ttdownload-web</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭菜单"
          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 lg:hidden dark:hover:bg-slate-800"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              onClick={onClose}
              className={({ isActive }) =>
                cn(
                  'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-50',
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.label}</span>
              {item.to === '/tasks' && stats?.downloading ? (
                <span className="ml-auto rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  {stats.downloading}
                </span>
              ) : null}
              {item.to === '/tasks' && stats?.failed && !stats?.downloading ? (
                <span className="ml-auto rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  {stats.failed}
                </span>
              ) : null}
            </NavLink>
          )
        })}
      </nav>

      <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/80 p-3.5 dark:border-slate-800 dark:bg-slate-800/40">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
          <HardDrive className="h-3.5 w-3.5" />
          磁盘可用空间
        </div>
        <p className="text-lg font-semibold text-slate-900 tabular-nums dark:text-slate-50">
          {system ? formatBytes(system.disk.freeBytes, '未知') : '—'}
        </p>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              diskPercent > 90 ? 'bg-red-500' : diskPercent > 75 ? 'bg-amber-500' : 'bg-brand-500',
            )}
            style={{ width: `${Math.min(100, diskPercent)}%` }}
          />
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          已用 {diskPercent}% · 预留 {system ? formatBytes(system.disk.reserveBytes, '0 B') : '—'}
        </p>
        <div className="flex items-center gap-3 border-t border-slate-200 pt-2.5 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400">
          <span className="inline-flex items-center gap-1">
            <Download className="h-3 w-3" />
            下载中 {stats?.downloading ?? 0}
          </span>
          <span className="inline-flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" />
            完成 {stats?.todayCompleted ?? 0}
          </span>
          <span className="inline-flex items-center gap-1">
            <Database className="h-3 w-3" />
            任务 {stats?.totalTasks ?? 0}
          </span>
        </div>
      </div>
    </div>
  )
}

export function Sidebar({ open, onClose }: SidebarProps) {
  return (
    <>
      {/* 桌面端固定侧边栏 */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-slate-200 bg-white lg:block dark:border-slate-800 dark:bg-slate-900">
        <SidebarContent onClose={onClose} />
      </aside>

      {/* 移动端抽屉 */}
      <div
        className={cn(
          'fixed inset-0 z-50 lg:hidden',
          open ? 'pointer-events-auto' : 'pointer-events-none',
        )}
        aria-hidden={!open}
      >
        <div
          className={cn(
            'absolute inset-0 bg-slate-900/50 backdrop-blur-sm transition-opacity duration-200',
            open ? 'opacity-100' : 'opacity-0',
          )}
          onClick={onClose}
        />
        <div
          className={cn(
            'absolute inset-y-0 left-0 w-[264px] max-w-[85vw] bg-white shadow-lift transition-transform duration-250 dark:bg-slate-900',
            open ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <SidebarContent onClose={onClose} />
        </div>
      </div>
    </>
  )
}
