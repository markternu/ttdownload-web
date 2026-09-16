import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  Download,
  HardDrive,
  Layers,
  TrendingUp,
} from 'lucide-react'
import {
  CumulativeChart,
  DailyTrendChart,
  PlatformBarChart,
  SuccessRateChart,
} from '../components/charts/StatsCharts'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorState,
  LoadingBlock,
  ProgressBar,
  StatCard,
  Thumbnail,
} from '../components/ui'
import { useAppData } from '../context/AppDataContext'
import { formatBytes, formatDateTime, formatRelative, statusMeta } from '../lib/format'
import { platformTone } from '../lib/constants'

export default function DashboardPage() {
  const navigate = useNavigate()
  const { stats, system, loading, error, refreshAll } = useAppData()

  const finished = useMemo(() => {
    if (!stats) return 0
    return Math.max(0, stats.totalTasks - stats.downloading - stats.waiting - stats.failed)
  }, [stats])

  if (loading && !stats) return <LoadingBlock text="正在加载统计数据…" />

  if (error && !stats) {
    return <ErrorState message={`加载统计数据失败：${error}`} onRetry={() => void refreshAll()} />
  }

  const diskUsedRatio =
    system && system.disk.totalBytes > 0 ? system.disk.usedBytes / system.disk.totalBytes : 0

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">数据统计</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            今日任务、下载量趋势与平台分布一览
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refreshAll()}>
          <Activity className="h-3.5 w-3.5" />
          刷新数据
        </Button>
      </div>

      {/* 关键指标 */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="今日任务"
          value={stats?.todayTasks ?? 0}
          tone="brand"
          icon={<Layers className="h-4 w-4" />}
        />
        <StatCard
          label="已完成"
          value={stats?.todayCompleted ?? 0}
          hint="今日完成"
          tone="success"
          icon={<CheckCircle2 className="h-4 w-4" />}
        />
        <StatCard
          label="下载中"
          value={stats?.downloading ?? 0}
          hint={`排队 ${stats?.waiting ?? 0}`}
          tone="brand"
          icon={<Download className="h-4 w-4" />}
        />
        <StatCard
          label="失败"
          value={stats?.failed ?? 0}
          tone={stats?.failed ? 'danger' : 'neutral'}
          icon={<AlertTriangle className="h-4 w-4" />}
        />
        <StatCard
          label="累计下载"
          value={formatBytes(stats?.totalDownloadedBytes ?? 0, '0 B')}
          tone="neutral"
          icon={<HardDrive className="h-4 w-4" />}
        />
        <StatCard
          label="累计任务"
          value={stats?.totalTasks ?? 0}
          hint={`成功 ${finished}`}
          tone="neutral"
          icon={<Database className="h-4 w-4" />}
        />
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="每日下载量" subtitle="任务数量与数据量（GB）" />
          <DailyTrendChart data={stats?.daily ?? []} />
        </Card>

        <Card>
          <CardHeader title="成功率" subtitle="已完成 / 未完成任务占比" />
          <SuccessRateChart
            successRate={stats?.successRate ?? 0}
            completed={finished}
            pending={(stats?.downloading ?? 0) + (stats?.waiting ?? 0) + (stats?.failed ?? 0)}
          />
        </Card>

        <Card>
          <CardHeader title="各平台下载数量" subtitle="按平台统计的任务数" />
          <PlatformBarChart data={stats?.perPlatform ?? []} />
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader title="总下载数据量" subtitle="按天累计增长曲线" />
          <CumulativeChart data={stats?.daily ?? []} />
        </Card>
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* 最近下载任务 */}
        <Card className="xl:col-span-2">
          <CardHeader
            title="最近下载任务"
            subtitle="最新创建或更新的任务"
            action={
              <Button variant="ghost" size="sm" onClick={() => navigate('/tasks')}>
                全部任务 <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            }
          />
          {stats?.recentTasks?.length ? (
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <th className="px-2 py-2 font-semibold">任务</th>
                    <th className="px-2 py-2 font-semibold">平台</th>
                    <th className="px-2 py-2 font-semibold">进度</th>
                    <th className="px-2 py-2 font-semibold">状态</th>
                    <th className="px-2 py-2 font-semibold">时间</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recentTasks.map((task) => {
                    const meta = statusMeta(task.status)
                    return (
                      <tr key={task.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/70">
                        <td className="px-2 py-2.5">
                          <div className="flex items-center gap-2">
                            <Thumbnail src={task.meta?.thumbnail} alt={task.title} className="w-12" />
                            <span
                              className="max-w-[200px] truncate text-sm text-slate-700 dark:text-slate-200"
                              title={task.title}
                            >
                              {task.title}
                            </span>
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          <span className={`rounded-full px-2 py-0.5 text-xs ${platformTone(task.platform)}`}>
                            {task.platform ?? '未知'}
                          </span>
                        </td>
                        <td className="px-2 py-2.5">
                          <div className="w-28">
                            <ProgressBar value={task.progress} size="sm" />
                            <span className="text-[11px] text-slate-400 tabular-nums">
                              {Math.round(task.progress)}%
                            </span>
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          <Badge tone={meta.tone}>{meta.label}</Badge>
                        </td>
                        <td className="whitespace-nowrap px-2 py-2.5 text-xs text-slate-400">
                          {formatRelative(task.updatedAt || task.createdAt)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="py-8 text-center text-sm text-slate-400">暂无下载任务</p>
          )}
        </Card>

        {/* 系统状态摘要 */}
        <Card>
          <CardHeader title="系统状态" subtitle="磁盘与运行信息" />
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span className="inline-flex items-center gap-1">
                  <HardDrive className="h-3.5 w-3.5" />
                  磁盘使用
                </span>
                <span className="tabular-nums">
                  {system ? formatBytes(system.disk.usedBytes, '—') : '—'} /{' '}
                  {system ? formatBytes(system.disk.totalBytes, '—') : '—'}
                </span>
              </div>
              <ProgressBar
                className="mt-2"
                value={diskUsedRatio * 100}
                tone={diskUsedRatio > 0.9 ? 'danger' : diskUsedRatio > 0.75 ? 'warning' : 'brand'}
              />
              <p className="mt-1.5 text-[11px] text-slate-400">
                <span className="font-medium text-slate-500 dark:text-slate-300">
                  可用于下载 {system ? formatBytes(system.disk.usableBytes, '未知') : '—'}
                </span>{' '}
                · 系统实际可用 {system ? formatBytes(system.disk.freeBytes, '未知') : '—'} · 预留{' '}
                {system ? formatBytes(system.disk.reserveBytes, '0 B') : '—'}
              </p>
              <p className="mt-1 text-[11px] leading-4 text-slate-400">
                预留那份是留给「归档 → 加密 → 发布」等文件操作周转的（加密时源文件是边读边删，
                留够一次操作的空间就不会把自己写满）。所以<b>新下载能用的 = 系统实际可用 − 预留</b>；
                想让它多下点就把设置里的「预留磁盘空间」调小。
                {system && (system.disk.reservedBytes ?? 0) > 0 ? (
                  <>
                    <br />
                    当前运行中的任务已预留 {formatBytes(system.disk.reservedBytes ?? 0, '0 B')}，
                    实际还能再放行 {formatBytes(system.disk.admittableBytes ?? 0, '0 B')} 的新任务。
                  </>
                ) : null}
              </p>
            </div>

            <dl className="space-y-2 border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
              <div className="flex justify-between">
                <dt className="text-slate-500 dark:text-slate-400">版本</dt>
                <dd className="font-mono text-slate-700 dark:text-slate-200">
                  {system?.version ?? '—'}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500 dark:text-slate-400">数据库</dt>
                <dd className="text-slate-700 dark:text-slate-200">
                  {system ? (
                    <Badge tone={system.db.ok ? 'success' : 'danger'}>
                      {system.db.ok ? '正常' : '异常'} · {formatBytes(system.db.sizeBytes, '0 B')}
                    </Badge>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500 dark:text-slate-400">Node</dt>
                <dd className="font-mono text-slate-700 dark:text-slate-200">{system?.node ?? '—'}</dd>
              </div>
            </dl>

            <div className="border-t border-slate-100 pt-3 dark:border-slate-800">
              <p className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                <TrendingUp className="h-3.5 w-3.5" />
                外部工具
              </p>
              <div className="flex flex-wrap gap-1.5">
                {system
                  ? Object.entries(system.tools).map(([name, tool]) => (
                      <Badge key={name} tone={tool.ok ? 'success' : 'danger'}>
                        {name} {tool.ok ? (tool.version ? `v${tool.version}` : '可用') : '不可用'}
                      </Badge>
                    ))
                  : <span className="text-xs text-slate-400">—</span>}
              </div>
            </div>
          </div>
        </Card>
      </section>

      <p className="text-center text-[11px] text-slate-400">
        数据更新时间：{formatDateTime(new Date().toISOString())}
      </p>
    </div>
  )
}
