import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Cookie,
  Database,
  Gauge,
  Globe,
  HardDrive,
  Info,
  Monitor,
  Moon,
  Palette,
  Plug,
  RefreshCw,
  Save,
  Settings2,
  Sun,
  Trash2,
  Undo2,
  UploadCloud,
  Wifi,
  XCircle, Filter } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  ProgressBar,
  Select,
  Switch,
} from '../components/ui'
import { useAppData, useSettingsStore } from '../context/AppDataContext'
import { useTheme } from '../context/ThemeContext'
import { useToast } from '../context/ToastContext'
import { api } from '../lib/api'
import { CONCURRENCY_OPTIONS, FORMAT_OPTIONS, QUALITY_OPTIONS } from '../lib/constants'
import { formatBytes, humanizeError } from '../lib/format'
import type {
  CookieHarvestSite,
  CookieHarvestStatus,
  CookiesStatus,
  Settings,
  TestTool,
  ThemeMode,
} from '../types'

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun; description: string }[] = [
  { value: 'light', label: 'Light', icon: Sun, description: '始终使用浅色界面' },
  { value: 'dark', label: 'Dark', icon: Moon, description: '始终使用深色界面' },
  { value: 'system', label: 'System', icon: Monitor, description: '跟随操作系统设置' },
]

const TEST_TOOLS: { value: TestTool; label: string }[] = [
  { value: 'aria2', label: 'aria2 RPC' },
  { value: 'transmission', label: 'transmission RPC' },
  { value: 'ytdlp', label: 'yt-dlp' },
]

/** yt-dlp 支持的“从浏览器读取 cookies”来源 */
const COOKIES_BROWSER_OPTIONS = [
  { value: '', label: '不使用' },
  { value: 'chrome', label: 'chrome' },
  { value: 'chromium', label: 'chromium' },
  { value: 'edge', label: 'edge' },
  { value: 'firefox', label: 'firefox' },
  { value: 'brave', label: 'brave' },
  { value: 'opera', label: 'opera' },
  { value: 'vivaldi', label: 'vivaldi' },
  { value: 'safari', label: 'safari' },
]

function toSpeedInput(bps: number): string {
  if (!bps) return '0'
  return String(Math.round((bps / 1024 / 1024) * 100) / 100)
}

/**
 * YouTube 登录态依赖的关键 cookie 名（与后端 CRITICAL_COOKIE_KEYS 一致）。
 * 后端 stats.keys 只包含“已存在”的键（值恒为 true），缺失的不会出现，
 * 因此页面用这份清单补全「缺少哪些关键字段」。
 */
const CRITICAL_COOKIE_KEYS = [
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  '__Secure-1PSID',
  '__Secure-3PSID',
  'LOGIN_INFO',
]

/** 关键 cookie 中缺失的名字（后端没返回的也算缺失） */
function missingCookieKeys(keys: Record<string, boolean>): string[] {
  const names = Array.from(new Set([...CRITICAL_COOKIE_KEYS, ...Object.keys(keys)]))
  return names.filter((name) => keys[name] !== true)
}

/** 域名分布：按条数降序，最多展示 5 项，例如 youtube.com×12、google.com×8 */
function formatDomainSpread(byDomain: Record<string, number>): string {
  const entries = Object.entries(byDomain).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )
  if (!entries.length) return '—'
  const top = entries
    .slice(0, 5)
    .map(([domain, count]) => `${domain}×${count}`)
    .join('、')
  return entries.length > 5 ? `${top} 等 ${entries.length} 个域名` : top
}

/** 访客 cookies 的缓存 TTL（与后端 COOKIE_HARVEST_TTL_HOURS 默认一致：6 小时） */
const HARVEST_TTL_MINUTES = 360

/** 人性化「多久之前」：<1 分钟 → 刚刚，<60 → N 分钟前，<24h → N 小时前，否则 N 天前 */
function humanizeAge(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return '刚刚'
  if (minutes < 60) return `${Math.round(minutes)} 分钟前`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} 小时前`
  return `${Math.round(minutes / (24 * 60))} 天前`
}

/** 这份访客 cookies 是否可能已过期（超过 TTL；下载时会自动重新获取） */
function harvestStale(site: CookieHarvestSite): boolean {
  return site.hasCookies && site.ageMinutes !== null && site.ageMinutes > HARVEST_TTL_MINUTES
}

/**
 * 草稿里相对于已保存设置的「未保存改动」（不含 cookieHarvestEnabled）。
 * 开关是即时保存的：保存后 store 会刷新 settings 并重置草稿，
 * 用这份差值把用户其它还没保存的编辑合回来，避免被静默丢弃。
 */
function pendingEdits(draft: Settings, settings: Settings | null): Partial<Settings> {
  if (!settings) return {}
  const out: Partial<Settings> = {}
  const target = out as Record<string, unknown>
  for (const key of Object.keys(draft) as (keyof Settings)[]) {
    if (key === 'cookieHarvestEnabled') continue
    if (JSON.stringify(draft[key]) !== JSON.stringify(settings[key])) target[key] = draft[key]
  }
  return out
}

export default function SettingsPage() {
  const toast = useToast()
  const { settings, loading, error, saving, refresh, save } = useSettingsStore()
  const { system, refreshSystem } = useAppData()
  const { theme, setTheme } = useTheme()

  const [draft, setDraft] = useState<Settings | null>(null)
  const [speedInput, setSpeedInput] = useState('0')
  const [testing, setTesting] = useState<TestTool | null>(null)
  const [testResult, setTestResult] = useState<{ tool: TestTool; ok: boolean; message: string } | null>(
    null,
  )

  // yt-dlp cookies 状态（独立于 /api/settings，单独拉取）
  const cookiesFileRef = useRef<HTMLInputElement>(null)
  const [cookiesStatus, setCookiesStatus] = useState<CookiesStatus | null>(null)
  const [cookiesLoading, setCookiesLoading] = useState(true)
  const [cookiesUploading, setCookiesUploading] = useState(false)
  const [cookiesDeleting, setCookiesDeleting] = useState(false)

  // 自动获取访客 cookies（GET/POST /api/webvideo/cookies/harvest）
  const [harvestStatus, setHarvestStatus] = useState<CookieHarvestStatus | null>(null)
  const [harvestRefreshing, setHarvestRefreshing] = useState<string | null>(null)
  const [harvestSaving, setHarvestSaving] = useState(false)
  /** 即时保存开关时暂存用户其它未保存的编辑（详见 pendingEdits） */
  const pendingDraftRef = useRef<Partial<Settings> | null>(null)

  const refreshCookies = useCallback(async () => {
    setCookiesLoading(true)
    // 两个接口互不影响：一个失败另一个照样更新界面
    const [cookiesRes, harvestRes] = await Promise.allSettled([
      api.getWebvideoCookies(),
      api.getCookieHarvest(),
    ])
    if (cookiesRes.status === 'fulfilled') {
      setCookiesStatus(cookiesRes.value)
      // 专用接口失败时，用 /cookies 里附带的 harvest 兜底
      if (harvestRes.status !== 'fulfilled') setHarvestStatus(cookiesRes.value.harvest)
    } else {
      setCookiesStatus(null)
    }
    if (harvestRes.status === 'fulfilled') setHarvestStatus(harvestRes.value)
    setCookiesLoading(false)
  }, [])

  useEffect(() => {
    void refreshCookies()
  }, [refreshCookies])

  useEffect(() => {
    if (settings) {
      // 即时保存开关会刷新 settings：把用户其它未保存的编辑合回来，避免被覆盖
      const pending = pendingDraftRef.current
      pendingDraftRef.current = null
      setDraft(pending ? { ...settings, ...pending } : settings)
      setSpeedInput(toSpeedInput(settings.maxSpeedBps))
    }
  }, [settings])

  const dirty = useMemo(() => {
    if (!draft || !settings) return false
    return JSON.stringify(draft) !== JSON.stringify(settings)
  }, [draft, settings])

  const patch = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current))
  }

  const handleSave = async () => {
    if (!draft) return
    try {
      const payload: Partial<Settings> = { ...draft }
      // 掩码密码不参与更新，避免误把 '******' 写回后端
      if (payload.encryptPassword === '******') delete payload.encryptPassword
      await save(payload)
      toast.success('设置已保存', '部分修改需要重启服务才能完全生效')
      void refreshSystem()
    } catch (err) {
      toast.error('保存失败', humanizeError((err as { code?: string }).code ?? '', (err as Error).message))
    }
  }

  const handleTest = async (tool: TestTool) => {
    setTesting(tool)
    setTestResult(null)
    try {
      const res = await api.testConnection(tool)
      setTestResult({ tool, ok: res.ok, message: res.message })
      if (res.ok) toast.success('连通性正常', `${tool}：${res.message}`)
      else toast.error('连通性异常', `${tool}：${res.message}`)
    } catch (err) {
      const message = humanizeError((err as { code?: string }).code ?? '', (err as Error).message)
      setTestResult({ tool, ok: false, message })
      toast.error('测试失败', message)
    } finally {
      setTesting(null)
    }
  }

  const handleCookiesUpload = async (file: File) => {
    setCookiesUploading(true)
    try {
      const res = await api.uploadWebvideoCookies(file)
      setCookiesStatus(res)
      // 上传成功后把生效路径写回草稿，保存设置后即可持久化
      if (res.cookiesFile) patch('webvideoCookiesFile', res.cookiesFile)
      // 结构有问题时用警告 toast 直接把第一条问题说清楚（页面下方也会逐条列出）
      if (res.warnings?.length) {
        toast.warning('cookies 已上传，但结构有问题', res.warnings[0])
      } else {
        toast.success('cookies 上传成功', file.name)
      }
    } catch (err) {
      toast.error(
        'cookies 上传失败',
        humanizeError((err as { code?: string }).code ?? '', (err as Error).message),
      )
    } finally {
      setCookiesUploading(false)
      if (cookiesFileRef.current) cookiesFileRef.current.value = ''
    }
  }

  const handleCookiesDelete = async () => {
    if (!window.confirm('确定要删除服务器上的 cookies.txt 吗？删除后会员/登录视频将无法下载。')) {
      return
    }
    setCookiesDeleting(true)
    try {
      const res = await api.deleteWebvideoCookies()
      setCookiesStatus(res)
      toast.success('cookies 已删除', res.cookiesFile)
    } catch (err) {
      toast.error(
        'cookies 删除失败',
        humanizeError((err as { code?: string }).code ?? '', (err as Error).message),
      )
    } finally {
      setCookiesDeleting(false)
    }
  }

  /** 开关「启用自动获取」：改 cookieHarvestEnabled 并立即保存（只需提交这一个字段） */
  const handleHarvestToggle = async (checked: boolean) => {
    if (!draft) return
    const before = draft
    const applyLocal = (next: boolean) => {
      patch('cookieHarvestEnabled', next)
      setHarvestStatus((current) =>
        current ? { ...current, enabled: next, available: next && !!current.chromium } : current,
      )
    }
    applyLocal(checked)
    setHarvestSaving(true)
    pendingDraftRef.current = pendingEdits(before, settings)
    try {
      await save({ cookieHarvestEnabled: checked })
      toast.success(
        checked ? '已开启自动获取访客 cookies' : '已关闭自动获取访客 cookies',
        checked
          ? '抖音这类站点会由服务器上的无头浏览器自动获取并定期续期'
          : '抖音这类站点将需要你手工上传 cookies.txt',
      )
    } catch (err) {
      // 保存失败：把开关和草稿回滚，别让界面显示不存在的状态
      pendingDraftRef.current = null
      applyLocal(!checked)
      setDraft(before)
      toast.error(
        '保存失败',
        humanizeError((err as { code?: string }).code ?? '', (err as Error).message),
      )
    } finally {
      setHarvestSaving(false)
    }
  }

  /** 「立即刷新」：抓一次该站点的访客 cookies，成功后用返回的 status 覆盖界面 */
  const handleHarvestRefresh = async (site: CookieHarvestSite) => {
    setHarvestRefreshing(site.id)
    try {
      const res = await api.refreshCookieHarvest(site.id)
      setHarvestStatus(res.status)
      toast.success(
        `${site.name} 访客 cookies 已更新`,
        res.meta ? `本次获取 ${res.meta.cookieCount} 条` : undefined,
      )
    } catch (err) {
      // 原样展示后端 error.message（例如「服务器上没有 chromium，请先安装…」）
      toast.error(
        `${site.name} 自动获取失败`,
        humanizeError((err as { code?: string }).code ?? '', (err as Error).message),
      )
    } finally {
      setHarvestRefreshing(null)
    }
  }

  if (loading && !settings) return <LoadingBlock text="正在加载设置…" />
  if (error && !settings) return <ErrorState message={`加载设置失败：${error}`} onRetry={() => void refresh()} />
  if (!draft) return null

  const diskUsedRatio =
    system && system.disk.totalBytes > 0 ? system.disk.usedBytes / system.disk.totalBytes : 0

  // 关键 cookie 缺失情况（只有文件存在时才判断）
  const missingKeys = cookiesStatus?.exists ? missingCookieKeys(cookiesStatus.stats.keys) : []

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">设置</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            下载 / 网络 / 外观 / 系统状态 · 保存调用 PUT /api/settings
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty ? <Badge tone="warning">有未保存的修改</Badge> : <Badge tone="success">已同步</Badge>}
          <Button variant="outline" size="sm" disabled={!dirty} onClick={() => setDraft(settings)}>
            <Undo2 className="h-3.5 w-3.5" />
            还原
          </Button>
          <Button size="sm" loading={saving} disabled={!dirty} onClick={() => void handleSave()}>
            <Save className="h-3.5 w-3.5" />
            保存设置
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 下载设置 */}
        <Card>
          <CardHeader
            title={
              <span className="inline-flex items-center gap-2">
                <Settings2 className="h-4 w-4" /> 下载设置
              </span>
            }
            subtitle="质量 / 格式 / 并发 / 保存目录"
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select
              label="默认下载质量"
              value={draft.defaultQuality}
              options={QUALITY_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              onChange={(event) => patch('defaultQuality', event.target.value)}
            />
            <Select
              label="默认文件格式"
              value={draft.defaultFormat}
              options={FORMAT_OPTIONS}
              onChange={(event) => patch('defaultFormat', event.target.value)}
            />
            <Select
              label="最大并发任务"
              hint="0=不限（推荐）：只要磁盘还有可用空间就一直放行；装不下的先跳过，让后面装得下的先跑，等有空间再轮到它"
              value={String(draft.maxConcurrent)}
              options={CONCURRENCY_OPTIONS.map((value) => ({
                value: String(value),
                label: value === 0 ? '不限（按磁盘空间）' : `${value} 个任务`,
              }))}
              onChange={(event) => patch('maxConcurrent', Number(event.target.value))}
            />
            <Field label="默认保存目录" hint="修改后需要重启服务才能完全生效">
              <Input
                value={draft.downloadRoot}
                onChange={(event) => patch('downloadRoot', event.target.value)}
                placeholder="/ttdownload"
              />
            </Field>
            <Field label="预留磁盘空间（GB）" hint="这是「加密 / 归档 / 发布」时的文件操作周转空间：加密完成后才会删掉源文件，所以这块必须一直留着 —— 空间被下载吃满时，加密/归档会直接失败。⚠️ 不要随意调小。口径：「可用于下载」= 操作系统实际可用 − 这个预留">
              <Input
                type="number"
                min={0}
                step={1}
                value={String(Math.round(draft.reserveFreeBytes / 1024 ** 3))}
                onChange={(event) =>
                  patch('reserveFreeBytes', Math.max(0, Number(event.target.value)) * 1024 ** 3)
                }
              />
            </Field>
            <Field
              label="模块并发（BT / 直链 / 在线视频）"
              hint="0=不限（推荐）。一般不用管这项 —— 真正决定下多少的是磁盘空间"
            >
              <div className="grid grid-cols-3 gap-2">
                <Input
                  type="number"
                  min={0}
                  max={99}
                  value={String(draft.moduleConcurrency.transmission)}
                  onChange={(event) =>
                    patch('moduleConcurrency', {
                      ...draft.moduleConcurrency,
                      transmission: Number(event.target.value),
                    })
                  }
                  aria-label="transmission 并发"
                />
                <Input
                  type="number"
                  min={0}
                  max={99}
                  value={String(draft.moduleConcurrency.aria2)}
                  onChange={(event) =>
                    patch('moduleConcurrency', {
                      ...draft.moduleConcurrency,
                      aria2: Number(event.target.value),
                    })
                  }
                  aria-label="aria2 并发"
                />
                <Input
                  type="number"
                  min={0}
                  max={99}
                  value={String(draft.moduleConcurrency.webvideo)}
                  onChange={(event) =>
                    patch('moduleConcurrency', {
                      ...draft.moduleConcurrency,
                      webvideo: Number(event.target.value),
                    })
                  }
                  aria-label="webvideo 并发"
                />
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                三个数是 <b>BT / 直链 / 在线视频</b>，<b>0 表示不限</b>。默认全是 0：
                程序会把等待队列里装得下的任务一直放行，装不下的先跳过（让后面小的先跑，不浪费空间），
                空间回血后再轮到它 —— 顺序仍然是先进先出。不需要你在这里限制个数。
              </p>
            </Field>
          </div>

          <div className="mt-4 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
            <Switch
              checked={draft.autoDeleteAfterReport}
              onChange={(checked) => patch('autoDeleteAfterReport', checked)}
              label="安卓上报后自动删除文件"
              description="消费者下载完成后立即删除，及时释放磁盘空间"
            />
            <Field label="加密密码" hint="显示为掩码，仅在你输入新值时才修改">
              <Input
                type="password"
                value={draft.encryptPassword}
                onChange={(event) => patch('encryptPassword', event.target.value)}
                placeholder="******"
              />
            </Field>
          </div>
        </Card>

        {/* 网络设置 */}
        <Card>
          <CardHeader
            title={
              <span className="inline-flex items-center gap-2">
                <Wifi className="h-4 w-4" /> 网络设置
              </span>
            }
            subtitle="限速 / 超时 / 自动重试"
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="最大下载速度（MB/s）" hint="0 表示不限速">
              <Input
                type="number"
                min={0}
                step={0.1}
                value={speedInput}
                onChange={(event) => {
                  setSpeedInput(event.target.value)
                  const mbps = Number(event.target.value)
                  patch('maxSpeedBps', Number.isFinite(mbps) ? Math.round(mbps * 1024 * 1024) : 0)
                }}
              />
            </Field>
            <Field label="当前限速值">
              <div className="flex h-10 items-center rounded-xl bg-slate-50 px-3.5 text-sm text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                {draft.maxSpeedBps > 0 ? `${formatBytes(draft.maxSpeedBps)}/s` : '不限速'}
              </div>
            </Field>
            <Field label="请求超时（秒）">
              <Input
                type="number"
                min={5}
                max={600}
                value={String(draft.requestTimeoutSec)}
                onChange={(event) => patch('requestTimeoutSec', Number(event.target.value))}
              />
            </Field>
            <Field label="自动重试次数">
              <Input
                type="number"
                min={0}
                max={10}
                value={String(draft.autoRetry)}
                onChange={(event) => patch('autoRetry', Number(event.target.value))}
              />
            </Field>
          </div>

          <div className="mt-4 space-y-4 border-t border-slate-100 pt-4 dark:border-slate-800">
            <div>
              <p className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                <Gauge className="h-3.5 w-3.5" /> aria2 RPC
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Input
                  value={draft.aria2Rpc.host}
                  onChange={(event) =>
                    patch('aria2Rpc', { ...draft.aria2Rpc, host: event.target.value })
                  }
                  placeholder="127.0.0.1"
                  aria-label="aria2 主机"
                />
                <Input
                  type="number"
                  value={String(draft.aria2Rpc.port)}
                  onChange={(event) =>
                    patch('aria2Rpc', { ...draft.aria2Rpc, port: Number(event.target.value) })
                  }
                  aria-label="aria2 端口"
                />
                <Input
                  type="password"
                  value={draft.aria2Rpc.secret}
                  onChange={(event) =>
                    patch('aria2Rpc', { ...draft.aria2Rpc, secret: event.target.value })
                  }
                  placeholder="secret"
                  aria-label="aria2 secret"
                />
              </div>
            </div>

            <div>
              <p className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                <Plug className="h-3.5 w-3.5" /> transmission RPC
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                <Input
                  value={draft.transmissionRpc.host}
                  onChange={(event) =>
                    patch('transmissionRpc', { ...draft.transmissionRpc, host: event.target.value })
                  }
                  placeholder="127.0.0.1"
                  aria-label="transmission 主机"
                />
                <Input
                  type="number"
                  value={String(draft.transmissionRpc.port)}
                  onChange={(event) =>
                    patch('transmissionRpc', {
                      ...draft.transmissionRpc,
                      port: Number(event.target.value),
                    })
                  }
                  aria-label="transmission 端口"
                />
                <Input
                  value={draft.transmissionRpc.user}
                  onChange={(event) =>
                    patch('transmissionRpc', { ...draft.transmissionRpc, user: event.target.value })
                  }
                  placeholder="user"
                  aria-label="transmission 用户"
                />
                <Input
                  type="password"
                  value={draft.transmissionRpc.password}
                  onChange={(event) =>
                    patch('transmissionRpc', {
                      ...draft.transmissionRpc,
                      password: event.target.value,
                    })
                  }
                  placeholder="password"
                  aria-label="transmission 密码"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="yt-dlp 路径">
                <Input
                  value={draft.ytdlpPath}
                  onChange={(event) => patch('ytdlpPath', event.target.value)}
                  placeholder="yt-dlp"
                />
              </Field>
              <Field label="ffmpeg 路径">
                <Input
                  value={draft.ffmpegPath}
                  onChange={(event) => patch('ffmpegPath', event.target.value)}
                  placeholder="ffmpeg"
                />
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {TEST_TOOLS.map((tool) => (
                <Button
                  key={tool.value}
                  size="sm"
                  variant="outline"
                  loading={testing === tool.value}
                  onClick={() => void handleTest(tool.value)}
                >
                  <Plug className="h-3.5 w-3.5" />
                  测试 {tool.label}
                </Button>
              ))}
            </div>

            {testResult ? (
              <p
                className={`flex items-start gap-2 rounded-xl px-3 py-2 text-xs ${
                  testResult.ok
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                    : 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
                }`}
              >
                {testResult.ok ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                ) : (
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                )}
                <span>
                  {testResult.tool}：{testResult.message}
                </span>
              </p>
            ) : null}
          </div>
        </Card>

        {/* 公开视频（yt-dlp）cookies / 额外参数 */}
        <Card>
          <CardHeader
            title={
              <span className="inline-flex items-center gap-2">
                <Cookie className="h-4 w-4" /> 公开视频（yt-dlp）
              </span>
            }
            subtitle="会员专享 / 需登录 / 年龄限制的视频：用 cookies 让它能下载"
          />
          <div className="space-y-4">
            <Field
              label="cookies 文件路径"
              hint="留空则使用服务器默认路径；上传 cookies.txt 后会自动填入这里"
            >
              <Input
                value={draft.webvideoCookiesFile}
                onChange={(event) => patch('webvideoCookiesFile', event.target.value)}
                placeholder={cookiesStatus?.defaultPath ?? '/ttdownload/state/cookies.txt'}
              />
            </Field>

            <Select
              label="从浏览器读取 cookies"
              hint="仅当服务器机器上存在该浏览器的用户配置文件时才可用"
              value={draft.webvideoCookiesFromBrowser}
              options={COOKIES_BROWSER_OPTIONS}
              onChange={(event) => patch('webvideoCookiesFromBrowser', event.target.value)}
            />

            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={cookiesFileRef}
                type="file"
                accept=".txt,text/plain"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void handleCookiesUpload(file)
                }}
              />
              <Button
                variant="outline"
                size="sm"
                loading={cookiesUploading}
                onClick={() => cookiesFileRef.current?.click()}
                icon={<UploadCloud className="h-3.5 w-3.5" />}
              >
                {cookiesUploading ? '上传中…' : '上传 cookies.txt'}
              </Button>
              {!cookiesLoading && cookiesStatus?.exists ? (
                <Button
                  variant="outline"
                  size="sm"
                  loading={cookiesDeleting}
                  onClick={() => void handleCookiesDelete()}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除
                </Button>
              ) : null}
            </div>

            {cookiesLoading ? (
              <p className="text-xs text-slate-400 dark:text-slate-500">正在读取 cookies 状态…</p>
            ) : cookiesStatus ? (
              <div className="space-y-2.5 rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-800/60">
                <p className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <Badge tone={cookiesStatus.exists ? 'success' : 'warning'} dot>
                    {cookiesStatus.exists ? '已配置' : '未配置'}
                  </Badge>
                  {cookiesStatus.valid ? (
                    <Badge tone="success">结构正常</Badge>
                  ) : cookiesStatus.exists ? (
                    <Badge tone="danger">有问题</Badge>
                  ) : null}
                  <span>
                    文件大小 {(cookiesStatus.sizeBytes / 1024).toFixed(1)} KB · 最后更新{' '}
                    {cookiesStatus.updatedAt
                      ? new Date(cookiesStatus.updatedAt).toLocaleString()
                      : '—'}
                    {cookiesStatus.fromBrowser ? ` · 来自浏览器 ${cookiesStatus.fromBrowser}` : ''}
                  </span>
                </p>

                {cookiesStatus.exists ? (
                  <ul className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <li>cookie 条数：{cookiesStatus.stats.total}</li>
                    <li>域名分布：{formatDomainSpread(cookiesStatus.stats.byDomain)}</li>
                    <li
                      className={
                        cookiesStatus.stats.expiredCount > 0
                          ? 'text-amber-600 dark:text-amber-400'
                          : undefined
                      }
                    >
                      已过期条数：{cookiesStatus.stats.expiredCount}
                    </li>
                    <li>{missingKeys.length ? `缺少：${missingKeys.join('、')}` : '关键字段齐全'}</li>
                  </ul>
                ) : null}

                {cookiesStatus.warnings.length ? (
                  <ul className="space-y-1.5 border-t border-slate-200 pt-2.5 dark:border-slate-700">
                    {cookiesStatus.warnings.map((warning) => (
                      <li
                        key={warning}
                        className="flex items-start gap-1.5 text-xs leading-relaxed text-red-600 dark:text-red-400"
                      >
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{warning}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {cookiesStatus.notes.length ? (
                  <ul className="space-y-1 border-t border-slate-200 pt-2.5 dark:border-slate-700">
                    {cookiesStatus.notes.map((note) => (
                      <li
                        key={note}
                        className="flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-400 dark:text-slate-500"
                      >
                        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{note}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                无法获取 cookies 状态，请确认后端服务已启动。
              </p>
            )}

            {/* 这份 cookies.txt 到底覆盖了哪些站点（答案：cookies 按站点隔离） */}
            {cookiesStatus?.sites?.length ? (
              <div className="space-y-2 rounded-xl border border-slate-200 px-3 py-2.5 dark:border-slate-700">
                <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                  当前 cookies.txt 覆盖的站点
                </p>
                <ul className="space-y-1.5">
                  {cookiesStatus.sites.map((site) => (
                    <li
                      key={site.domain}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400"
                    >
                      <Badge tone={site.auto ? 'brand' : 'neutral'}>{site.domain}</Badge>
                      <span className="shrink-0">{site.count} 条</span>
                      <span className="text-slate-400 dark:text-slate-500">{site.note}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
                  cookies 按站点隔离：为 Google / YouTube 导出的 cookies 不会让抖音生效，反之亦然。
                </p>
              </div>
            ) : null}

            {/* 自动获取访客 cookies（不用人工导出） */}
            <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-700">
              <div className="flex items-start gap-2">
                <Globe className="mt-0.5 h-4 w-4 shrink-0 text-brand-600 dark:text-brand-300" />
                <div className="min-w-0">
                  <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    自动获取访客 cookies（不用人工导出）
                  </h4>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                    抖音 / TikTok 这类站点要的是
                    <strong className="font-medium text-slate-600 dark:text-slate-300">
                      浏览器自动生成的访客 cookies
                    </strong>
                    （不需要登录），而且几小时就过期——人工导出跟不上，所以由服务器上的无头浏览器自动获取并定期续期。只有
                    <strong className="font-medium text-slate-600 dark:text-slate-300">
                      会员专享 / 年龄限制 / 私有视频
                    </strong>
                    才需要你手工导出一次登录 cookies。
                  </p>
                </div>
              </div>

              <Switch
                checked={harvestStatus?.enabled ?? draft.cookieHarvestEnabled}
                disabled={harvestSaving}
                onChange={(checked) => void handleHarvestToggle(checked)}
                label="启用自动获取"
                description="关闭后，抖音这类站点只能靠你手工上传的 cookies.txt"
              />

              {cookiesLoading && !harvestStatus ? (
                <p className="text-xs text-slate-400 dark:text-slate-500">正在读取自动获取状态…</p>
              ) : harvestStatus ? (
                <div className="space-y-3">
                  {harvestStatus.chromium ? (
                    <p className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <Badge tone="success" dot>
                        浏览器可用
                      </Badge>
                      <code className="break-all rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        {harvestStatus.chromium}
                      </code>
                    </p>
                  ) : !harvestStatus.sites.some((site) => site.auto && site.needsBrowser) ? (
                    <p className="flex items-start gap-1.5 rounded-xl bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        服务器上没有 chromium，但当前启用的站点（抖音/TikTok）都是走纯 HTTP 接口拿 cookies 的，
                        <b>不影响使用</b>；只有将来接入需要跑页面 JS 挑战的站点时才需要安装：
                        <code className="mx-1 break-all rounded bg-slate-200 px-1 py-0.5 text-[11px] dark:bg-slate-700">
                          sudo apt install -y chromium
                        </code>
                      </span>
                    </p>
                  ) : (
                    <p className="flex items-start gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        服务器上没有 chromium，无法自动获取：
                        <code className="mx-1 break-all rounded bg-amber-100/70 px-1 py-0.5 dark:bg-amber-900/40">
                          sudo apt install -y chromium
                        </code>
                        （Debian/Ubuntu/树莓派），或到「修复脚本」页执行{' '}
                        <code className="break-all rounded bg-amber-100/70 px-1 py-0.5 dark:bg-amber-900/40">
                          deploy/scripts/fix-cookies-browser.sh
                        </code>
                      </span>
                    </p>
                  )}

                  {harvestStatus.hint ? (
                    <p className="flex items-start gap-1.5 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{harvestStatus.hint}</span>
                    </p>
                  ) : null}

                  {!harvestStatus.enabled ? (
                    <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                      自动获取已关闭：抖音这类站点将需要你手工上传 cookies.txt
                    </p>
                  ) : null}

                  {harvestStatus.sites.length ? (
                    <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                      {harvestStatus.sites.map((site) => {
                        const stale = harvestStale(site)
                        return (
                          <li
                            key={site.id}
                            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="flex flex-wrap items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                                <span className="font-medium">{site.name}</span>
                                <span className="text-[11px] text-slate-400 dark:text-slate-500">
                                  {site.id}
                                </span>
                                {site.auto ? (
                                  <Badge tone="brand">自动</Badge>
                                ) : (
                                  <Badge tone="neutral">未启用</Badge>
                                )}
                              </p>
                              <p
                                className={
                                  stale
                                    ? 'mt-0.5 text-[11px] text-amber-600 dark:text-amber-400'
                                    : 'mt-0.5 text-[11px] text-slate-400 dark:text-slate-500'
                                }
                              >
                                {site.hasCookies
                                  ? `已获取 ${site.cookieCount} 条 · ${
                                      site.ageMinutes === null
                                        ? '—'
                                        : humanizeAge(site.ageMinutes)
                                    }`
                                  : '尚未获取'}
                                {stale ? ' · 可能已过期，下载时会自动重新获取' : ''}
                              </p>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              loading={harvestRefreshing === site.id}
                              onClick={() => void handleHarvestRefresh(site)}
                              icon={<RefreshCw className="h-3.5 w-3.5" />}
                            >
                              {harvestRefreshing === site.id ? '获取中…' : '立即刷新'}
                            </Button>
                          </li>
                        )
                      })}
                    </ul>
                  ) : null}
                </div>
              ) : (
                <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                  无法获取自动抓取状态，请确认后端服务已启动。
                </p>
              )}
            </div>

            <Field
              label="额外参数"
              hint="这些参数会追加到 yt-dlp 命令末尾，可用于代理 / 网络等场景"
            >
              <Input
                value={draft.webvideoExtraArgs}
                onChange={(event) => patch('webvideoExtraArgs', event.target.value)}
                placeholder="--proxy socks5://127.0.0.1:1080"
              />
            </Field>

            <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              用浏览器登录该网站后，用 “Get cookies.txt LOCALLY” 之类扩展导出 cookies.txt，然后在这里上传。
              以上设置在点击页面右上角「保存设置」后生效。
            </p>
          </div>
        </Card>

        {/* BT：只下视频 + 打包阈值 */}
        <Card>
          <CardHeader
            title={
              <span className="inline-flex items-center gap-2">
                <Filter className="h-4 w-4" /> BT 下载规则
              </span>
            }
            subtitle="扔给 transmission 之后不做任何多余操作：只勾选视频，剩下交给它下（不下图片/广告图/文本等非视频）"
          />
          <div className="space-y-4">
            <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
              规则只有一条：<b>扩展名是视频的才下</b>（mp4 / avi / wmv / mkv / flv / webm / mov / ts / m2ts / rmvb …，
              大小写不敏感）。<b>不做任何"广告识别"</b> —— 那套判断会把正片误判成广告。
              种子里若一个视频都没有，任务会被直接跳过。
            </p>
            <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
              <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                多个视频时的挑法：<b>独树一帜，下最大；相差无几，一起下</b>
              </p>
              <div className="mt-2 grid grid-cols-3 gap-3">
                <Field label="相差多少倍算异类" hint="比如设 5：最大的比第二名大 5 倍以上就只下最大的。默认 5">
                  <Input
                    type="number"
                    min={2}
                    max={100}
                    step={1}
                    value={String(draft.btSelect.bigRatio)}
                    onChange={(event) => patch('btSelect', { ...draft.btSelect, bigRatio: Number(event.target.value) })}
                  />
                </Field>
                <Field label="“伪大”的上限（MB）" hint="最大的不到这个大小、而后面有一堆小文件时，改下那堆小的（那大的通常是片头/预告）。默认 200MB">
                  <Input
                    type="number"
                    min={0}
                    step={10}
                    value={String(Math.round(draft.btSelect.smallCeilingBytes / 1024 ** 2))}
                    onChange={(event) =>
                      patch('btSelect', {
                        ...draft.btSelect,
                        smallCeilingBytes: Math.max(0, Number(event.target.value)) * 1024 ** 2,
                      })
                    }
                  />
                </Field>
                <Field label="“一堆小的”至少几个" hint="要触发上面那条，小文件至少要有这么多个。默认 3">
                  <Input
                    type="number"
                    min={2}
                    max={50}
                    value={String(draft.btSelect.manySmallCount)}
                    onChange={(event) => patch('btSelect', { ...draft.btSelect, manySmallCount: Number(event.target.value) })}
                  />
                </Field>
              </div>
              <p className="mt-1.5 text-[11px] leading-4 text-slate-400">
                例：[2G, 200M, 150M] → 只下 2G；[1G, 2G, 100M, 160M] → 下 1G 和 2G；
                [190M, 30M, 25M, 20M, 15M] → 下那四个小的。
              </p>
            </div>
            <Field
              label="小文件打包阈值（MB）"
              hint="小于它的多个视频会等全部下完后合成一个 zip；大于等于它的一个一个单独走（各自一个成品）。默认 300MB"
            >
              <Input
                type="number"
                min={0}
                step={50}
                value={String(Math.round(draft.btSelect.smallFileMaxBytes / 1024 ** 2))}
                onChange={(event) =>
                  patch('btSelect', {
                    ...draft.btSelect,
                    smallFileMaxBytes: Math.max(0, Number(event.target.value)) * 1024 ** 2,
                  })
                }
              />
            </Field>
          </div>
        </Card>

        {/* BT 超时策略（12 小时 + 6 小时宽限） */}
        <Card>
          <CardHeader
            title={
              <span className="inline-flex items-center gap-2">
                <Trash2 className="h-4 w-4" /> BT 超时清理
              </span>
            }
            subtitle="交给 transmission 后 12 小时内完全不干涉（有的资源过一会儿才上线）；到点还没下完才按下面的规则清理"
          />
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <Field label="多少小时后检查" hint="从交给 transmission 那一刻算起，默认 12 小时">
                <Input
                  type="number"
                  min={1}
                  max={168}
                  value={String(draft.btPolicy.checkAfterHours)}
                  onChange={(event) => patch('btPolicy', { ...draft.btPolicy, checkAfterHours: Number(event.target.value) })}
                />
              </Field>
              <Field label="进度低于多少%就清理" hint="到点时进度 ≤ 这个值 → 直接删任务 + 删残留，默认 60%">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={String(draft.btPolicy.minProgressPercent)}
                  onChange={(event) => patch('btPolicy', { ...draft.btPolicy, minProgressPercent: Number(event.target.value) })}
                />
              </Field>
              <Field label="宽限小时数" hint="进度高于上面那个值时再给这么多小时，到点还没完也清理，默认 6 小时">
                <Input
                  type="number"
                  min={1}
                  max={168}
                  value={String(draft.btPolicy.graceHours)}
                  onChange={(event) => patch('btPolicy', { ...draft.btPolicy, graceHours: Number(event.target.value) })}
                />
              </Field>
            </div>
            <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
              已经下完（100%）的不归这里管 —— 那是「扫货」的事：程序每 2 分钟扫一遍
              <code className="mx-1 rounded bg-slate-100 px-1 dark:bg-slate-800">/var/lib/transmission/downloads</code>
              和
              <code className="mx-1 rounded bg-slate-100 px-1 dark:bg-slate-800">/var/lib/transmission/incomplete</code>
              ，发现下好的视频就自动改名 → 加密 → 进待下载列表，然后把文件夹和 transmission 任务一起清掉。
            </p>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={
              <span className="inline-flex items-center gap-2">
                <Palette className="h-4 w-4" /> 外观
              </span>
            }
            subtitle="Light / Dark / System（保存在本地浏览器）"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {THEME_OPTIONS.map((option) => {
              const Icon = option.icon
              const active = theme === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setTheme(option.value)
                    patch('theme', option.value)
                  }}
                  className={`flex flex-col items-start gap-1.5 rounded-2xl border p-3.5 text-left transition-colors ${
                    active
                      ? 'border-brand-500 bg-brand-50/70 dark:bg-brand-500/10'
                      : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <Icon
                    className={`h-4 w-4 ${active ? 'text-brand-600 dark:text-brand-300' : 'text-slate-400'}`}
                  />
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                    {option.label}
                  </span>
                  <span className="text-[11px] text-slate-400">{option.description}</span>
                </button>
              )
            })}
          </div>
          <p className="mt-3 text-[11px] text-slate-400">
            主题会立即生效并写入浏览器 localStorage；设置页的 theme 字段也会同步保存到后端。
          </p>
        </Card>

        {/* 系统状态 */}
        <Card>
          <CardHeader
            title={
              <span className="inline-flex items-center gap-2">
                <Database className="h-4 w-4" /> 系统状态
              </span>
            }
            subtitle="GET /api/system"
            action={
              <Button variant="outline" size="sm" onClick={() => void refreshSystem()}>
                <RefreshCw className="h-3.5 w-3.5" />
                刷新
              </Button>
            }
          />

          {!system ? (
            <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
              无法获取系统状态，请确认后端服务已启动（默认 http://localhost:8080）。
            </p>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
                  <p className="text-slate-400">当前版本</p>
                  <p className="mt-1 font-mono text-sm text-slate-800 dark:text-slate-100">
                    {system.version}
                  </p>
                </div>
                <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
                  <p className="text-slate-400">Node</p>
                  <p className="mt-1 font-mono text-sm text-slate-800 dark:text-slate-100">
                    {system.node}
                  </p>
                </div>
                <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
                  <p className="text-slate-400">数据库</p>
                  <p className="mt-1 flex items-center gap-1.5 text-sm">
                    <Badge tone={system.db.ok ? 'success' : 'danger'}>
                      {system.db.ok ? '正常' : '异常'}
                    </Badge>
                    <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                      {formatBytes(system.db.sizeBytes, '0 B')}
                    </span>
                  </p>
                </div>
                <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
                  <p className="text-slate-400">外部工具</p>
                  <p className="mt-1 text-sm text-slate-800 dark:text-slate-100">
                    {Object.values(system.tools).filter((tool) => tool.ok).length} /{' '}
                    {Object.keys(system.tools).length} 可用
                  </p>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                  <span className="inline-flex items-center gap-1">
                    <HardDrive className="h-3.5 w-3.5" />
                    磁盘空间（整盘）
                  </span>
                  <span className="tabular-nums">
                    可用于下载 {formatBytes(system.disk.usableBytes, '未知')} · 系统可用{' '}
                    {formatBytes(system.disk.freeBytes, '未知')} / 共{' '}
                    {formatBytes(system.disk.totalBytes, '未知')}
                  </span>
                </div>
                <ProgressBar
                  className="mt-2"
                  value={diskUsedRatio * 100}
                  tone={diskUsedRatio > 0.9 ? 'danger' : diskUsedRatio > 0.75 ? 'warning' : 'brand'}
                />
                <p className="mt-1.5 text-[11px] text-slate-400">
                  路径 {system.disk.path} · 已用 {formatBytes(system.disk.usedBytes, '—')} · 预留{' '}
                  {formatBytes(system.disk.reserveBytes, '0 B')}
                </p>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">下载目录</p>
                <ul className="space-y-1.5 text-[11px]">
                  {Object.entries(system.dirs).map(([key, value]) => (
                    <li key={key} className="flex items-center justify-between gap-3">
                      <span className="text-slate-500 dark:text-slate-400">{key}</span>
                      <span className="truncate font-mono text-slate-700 dark:text-slate-200" title={value}>
                        {value}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">外部工具可用性</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(system.tools).map(([name, tool]) => (
                    <Badge key={name} tone={tool.ok ? 'success' : 'danger'} dot>
                      {name}
                      {tool.ok ? (tool.version ? ` v${tool.version}` : '') : ' 不可用'}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
