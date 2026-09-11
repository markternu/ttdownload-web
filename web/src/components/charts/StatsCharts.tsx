import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useTheme } from '../../context/ThemeContext'
import { formatBytes } from '../../lib/format'

export interface PlatformDatum {
  platform: string
  count: number
}

export interface DailyDatum {
  date: string
  count: number
  bytes: number
}

const PALETTE = ['#3567f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899']

function useChartTheme() {
  const { resolved } = useTheme()
  return useMemo(() => {
    const dark = resolved === 'dark'
    return {
      grid: dark ? '#1e293b' : '#e2e8f0',
      axis: dark ? '#94a3b8' : '#64748b',
      tooltipBg: dark ? '#0f172a' : '#ffffff',
      tooltipBorder: dark ? '#1e293b' : '#e2e8f0',
      tooltipText: dark ? '#e2e8f0' : '#0f172a',
    }
  }, [resolved])
}

const tooltipStyle = (theme: ReturnType<typeof useChartTheme>) => ({
  backgroundColor: theme.tooltipBg,
  border: `1px solid ${theme.tooltipBorder}`,
  borderRadius: 12,
  fontSize: 12,
  color: theme.tooltipText,
  boxShadow: '0 12px 30px -18px rgba(15,23,42,0.4)',
})

/** 各平台下载数量 */
export function PlatformBarChart({ data }: { data: PlatformDatum[] }) {
  const theme = useChartTheme()
  if (!data.length) {
    return <ChartEmpty text="暂无平台数据" />
  }
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
          <XAxis
            dataKey="platform"
            tick={{ fontSize: 11, fill: theme.axis }}
            axisLine={{ stroke: theme.grid }}
            tickLine={false}
            interval={0}
            angle={data.length > 5 ? -20 : 0}
            textAnchor={data.length > 5 ? 'end' : 'middle'}
            height={data.length > 5 ? 44 : 28}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 11, fill: theme.axis }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={tooltipStyle(theme)}
            formatter={(value: number) => [`${value} 个`, '任务数']}
            cursor={{ fill: theme.grid, fillOpacity: 0.4 }}
          />
          <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={44}>
            {data.map((item, index) => (
              <Cell key={item.platform} fill={PALETTE[index % PALETTE.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** 每日下载量（任务数 + 数据量） */
export function DailyTrendChart({ data }: { data: DailyDatum[] }) {
  const theme = useChartTheme()
  if (!data.length) {
    return <ChartEmpty text="暂无每日数据" />
  }
  const shaped = data.map((item) => ({
    ...item,
    gb: Number((item.bytes / 1024 ** 3).toFixed(3)),
  }))
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={shaped} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id="dailyCount" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3567f6" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#3567f6" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="dailyBytes" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: theme.axis }}
            axisLine={{ stroke: theme.grid }}
            tickLine={false}
            tickFormatter={(value: string) => value.slice(5)}
          />
          <YAxis
            yAxisId="left"
            allowDecimals={false}
            tick={{ fontSize: 11, fill: theme.axis }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 11, fill: theme.axis }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(value: number) => `${value}G`}
          />
          <Tooltip
            contentStyle={tooltipStyle(theme)}
            formatter={(value: number, name: string) =>
              name === '数据量' ? [`${value} GB`, name] : [`${value} 个`, name]
            }
          />
          <Legend wrapperStyle={{ fontSize: 12, color: theme.axis }} />
          <Area
            yAxisId="left"
            type="monotone"
            dataKey="count"
            name="任务数"
            stroke="#3567f6"
            strokeWidth={2}
            fill="url(#dailyCount)"
          />
          <Area
            yAxisId="right"
            type="monotone"
            dataKey="gb"
            name="数据量"
            stroke="#10b981"
            strokeWidth={2}
            fill="url(#dailyBytes)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

/** 成功率（完成 vs 未完成） */
export function SuccessRateChart({
  successRate,
  completed,
  pending,
}: {
  successRate: number
  completed: number
  pending: number
}) {
  const theme = useChartTheme()
  const total = completed + pending
  const data = [
    { name: '成功', value: completed },
    { name: '未完成', value: Math.max(0, pending) },
  ]
  if (total <= 0) return <ChartEmpty text="暂无成功率数据" />

  return (
    <div className="relative h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="62%"
            outerRadius="88%"
            paddingAngle={2}
            stroke="none"
          >
            <Cell fill="#10b981" />
            <Cell fill={theme.grid} />
          </Pie>
          <Tooltip
            contentStyle={tooltipStyle(theme)}
            formatter={(value: number, name: string) => [`${value} 个`, name]}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-semibold text-slate-900 tabular-nums dark:text-slate-50">
          {(successRate * 100).toFixed(1)}%
        </span>
        <span className="text-xs text-slate-400">成功率</span>
      </div>
    </div>
  )
}

/** 累计数据量趋势（按天累加，展示增长曲线） */
export function CumulativeChart({ data }: { data: DailyDatum[] }) {
  const theme = useChartTheme()
  if (!data.length) return <ChartEmpty text="暂无累计数据" />
  let running = 0
  const shaped = data.map((item) => {
    running += item.bytes
    return { date: item.date, total: Number((running / 1024 ** 3).toFixed(3)) }
  })
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={shaped} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id="cumulative" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3567f6" stopOpacity={0.4} />
              <stop offset="100%" stopColor="#3567f6" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: theme.axis }}
            axisLine={{ stroke: theme.grid }}
            tickLine={false}
            tickFormatter={(value: string) => value.slice(5)}
          />
          <YAxis
            tick={{ fontSize: 11, fill: theme.axis }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(value: number) => `${value}G`}
          />
          <Tooltip
            contentStyle={tooltipStyle(theme)}
            formatter={(value: number) => [`${value} GB`, '累计数据量']}
          />
          <Area
            type="monotone"
            dataKey="total"
            stroke="#3567f6"
            strokeWidth={2}
            fill="url(#cumulative)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function ChartEmpty({ text }: { text: string }) {
  return (
    <div className="flex h-64 w-full items-center justify-center rounded-xl border border-dashed border-slate-200 text-xs text-slate-400 dark:border-slate-700">
      {text}
    </div>
  )
}

/** 用于表格/卡片的体积格式化导出（统一走 formatBytes） */
export const chartFormatBytes = formatBytes
