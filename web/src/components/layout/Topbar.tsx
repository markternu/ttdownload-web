import { useEffect } from 'react'
import { AlertTriangle, Menu, Moon, RefreshCw, Sun, Wifi, WifiOff } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatBytes, isLowSpace } from '../../lib/format'
import { useAppData } from '../../context/AppDataContext'
import { useTheme } from '../../context/ThemeContext'
import { Badge, Button } from '../ui'
import { reconnectSse } from '../../hooks/useSse'
import { useToast } from '../../context/ToastContext'

export interface TopbarProps {
  title: string
  onOpenSidebar: () => void
}

const SSE_LABEL = {
  open: '实时连接',
  connecting: '连接中',
  closed: '已断开',
} as const

export function Topbar({ title, onOpenSidebar }: TopbarProps) {
  const { stats, system, sseStatus, refreshAll, loading, lastSpaceEvent } = useAppData()
  const { theme, resolved, setTheme } = useTheme()
  const toast = useToast()

  // 空间腾挪广播：只要有空间被释放就提示（服务端同时也已通知等待队列立即重新评估）
  useEffect(() => {
    if (!lastSpaceEvent) return
    const reasonLabel: Record<string, string> = {
      'android-reported-done': '安卓已下载完成并删除服务器文件',
      'bt-evict': 'BT 出清（长时间无资源/停滞/极慢）',
      'bt-salvage-cleanup': 'BT 可播放文件归档后的目录清理',
      'bt-cancel': '用户取消 BT 任务',
    }
    toast.info(
      '空间已腾挪',
      `释放 ${formatBytes(Math.max(0, lastSpaceEvent.bytes || 0))}（${reasonLabel[lastSpaceEvent.reason] ?? lastSpaceEvent.reason}），等待队列已重新评估`,
    )
  }, [lastSpaceEvent, toast])

  const lowSpace = system
    ? isLowSpace(system.disk.freeBytes, system.disk.reserveBytes)
    : false

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/85 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/85">
      <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label="打开菜单"
          className="rounded-xl p-2 text-slate-500 hover:bg-slate-100 lg:hidden dark:hover:bg-slate-800"
        >
          <Menu className="h-5 w-5" />
        </button>

        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-slate-900 dark:text-slate-50 sm:text-lg">
          {title}
        </h1>

        <div className="flex items-center gap-2">
          {/* 全局统计：桌面端展示 */}
          <div className="hidden items-center gap-2 md:flex">
            <Badge tone="brand" dot pulse={!!stats?.downloading}>
              下载中 {stats?.downloading ?? 0}
            </Badge>
            <Badge tone="warning">等待 {stats?.waiting ?? 0}</Badge>
            <Badge tone={(stats?.failed ?? 0) > 0 ? 'danger' : 'neutral'}>
              失败 {stats?.failed ?? 0}
            </Badge>
            <Badge tone="success">
              累计 {formatBytes(stats?.totalDownloadedBytes ?? 0, '0 B')}
            </Badge>
          </div>

          {/* 磁盘空间 */}
          <div
            className={cn(
              'hidden items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium sm:flex',
              lowSpace
                ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
            )}
            title={
              system
                ? [
                    `项目可用于下载：${formatBytes(system.disk.usableBytes, '未知')} —— 这是能拿去下资源的空间`,
                    `操作系统实际可用：${formatBytes(system.disk.freeBytes, '未知')}`
                      + ` ＝ 可用于下载 ${formatBytes(system.disk.usableBytes, '未知')}`
                      + ` ＋ 预留 ${formatBytes(system.disk.reserveBytes, '0 B')}`,
                    `预留用途：加密 / 归档 / 发布时的文件操作周转空间（加密完成后才删源文件，所以这块一直留着）。`,
                    `⚠️ 不要随意调小这条预留：空间用尽时加密/归档会直接失败。`,
                    `另有正在下载的任务已按预计大小预扣 ${formatBytes(system.disk.reservedBytes ?? 0, '0 B')}`
                      + `（下完/失败会归还），当前还能再放行 ${formatBytes(system.disk.admittableBytes ?? system.disk.usableBytes, '未知')}`,
                    `路径：${system.disk.path}`,
                  ].join('\n')
                : '暂无系统状态'
            }
          >
            {lowSpace ? <AlertTriangle className="h-3.5 w-3.5" /> : null}
            可用于下载 {system ? formatBytes(system.disk.usableBytes, '未知') : '—'}
          </div>

          {/* SSE 状态 */}
          <button
            type="button"
            onClick={() => reconnectSse()}
            title="点击重新连接实时事件流"
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
              sseStatus === 'open'
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : sseStatus === 'connecting'
                  ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                  : 'bg-slate-200/70 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
            )}
          >
            {sseStatus === 'open' ? (
              <Wifi className="h-3.5 w-3.5" />
            ) : (
              <WifiOff className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">{SSE_LABEL[sseStatus]}</span>
          </button>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => void refreshAll()}
            aria-label="刷新"
            title="刷新数据"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
            aria-label="切换主题"
            title={theme === 'system' ? '当前：跟随系统' : theme === 'dark' ? '当前：深色' : '当前：浅色'}
          >
            {resolved === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {lowSpace ? (
        <div className="flex items-start gap-2 border-t border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700 sm:px-6 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            「可用于下载」的空间已不足预留阈值（预留{' '}
            {system ? formatBytes(system.disk.reserveBytes, '0 B') : '—'}
            是给归档/加密/发布等文件操作周转用的，不参与下载），新任务会先排队等待。
            可清理「已发布文件」，或把设置里的「预留磁盘空间」调小。
          </span>
        </div>
      ) : null}
    </header>
  )
}
