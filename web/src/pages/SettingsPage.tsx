import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2,
  Cookie,
  Database,
  Gauge,
  HardDrive,
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
  XCircle,
} from 'lucide-react'
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
import type { CookiesStatus, Settings, TestTool, ThemeMode } from '../types'

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

  const refreshCookies = useCallback(async () => {
    setCookiesLoading(true)
    try {
      const data = await api.getWebvideoCookies()
      setCookiesStatus(data)
    } catch {
      setCookiesStatus(null)
    } finally {
      setCookiesLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshCookies()
  }, [refreshCookies])

  useEffect(() => {
    if (settings) {
      setDraft(settings)
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
      toast.success('cookies 上传成功', file.name)
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

  if (loading && !settings) return <LoadingBlock text="正在加载设置…" />
  if (error && !settings) return <ErrorState message={`加载设置失败：${error}`} onRetry={() => void refresh()} />
  if (!draft) return null

  const diskUsedRatio =
    system && system.disk.totalBytes > 0 ? system.disk.usedBytes / system.disk.totalBytes : 0

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
              hint="超出并发的任务进入等待队列"
              value={String(draft.maxConcurrent)}
              options={CONCURRENCY_OPTIONS.map((value) => ({
                value: String(value),
                label: `${value} 个任务`,
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
            <Field label="预留磁盘空间（GB）" hint="空间门控阈值，低于该值不再放行新任务">
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
            <Field label="模块并发（transmission / aria2 / webvideo）">
              <div className="grid grid-cols-3 gap-2">
                <Input
                  type="number"
                  min={1}
                  max={10}
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
                  min={1}
                  max={10}
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
                  min={1}
                  max={10}
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
              <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                <Badge tone={cookiesStatus.exists ? 'success' : 'warning'} dot>
                  {cookiesStatus.exists ? '已配置' : '未配置'}
                </Badge>
                <span className="ml-2">
                  文件大小 {(cookiesStatus.sizeBytes / 1024).toFixed(1)} KB · 最后更新{' '}
                  {cookiesStatus.updatedAt
                    ? new Date(cookiesStatus.updatedAt).toLocaleString()
                    : '—'}
                  {cookiesStatus.fromBrowser ? ` · 来自浏览器 ${cookiesStatus.fromBrowser}` : ''}
                </span>
              </p>
            ) : (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                无法获取 cookies 状态，请确认后端服务已启动。
              </p>
            )}

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

        {/* BT 出清（长时间无资源/停滞/极慢） */}
        <Card>
          <CardHeader
            title={
              <span className="inline-flex items-center gap-2">
                <Trash2 className="h-4 w-4" /> BT 出清
              </span>
            }
            subtitle="长时间无资源 / 中途停滞 / 极慢的 BT 任务自动清理，并删除 transmission incomplete 目录"
          />
          <div className="space-y-4">
            <Switch
              checked={draft.btEvict.enabled}
              onChange={(checked) => patch('btEvict', { ...draft.btEvict, enabled: checked })}
              label="启用 BT 出清机制"
              description="关闭后不会自动清理任何 BT 任务"
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="尝试时间门槛（小时）" hint="给每颗种子的下载尝试时间；不足该时长一律不做出清判断（防误删）">
                <Input
                  type="number"
                  min={1}
                  max={720}
                  value={String(draft.btEvict.minAgeHours)}
                  onChange={(event) => patch('btEvict', { ...draft.btEvict, minAgeHours: Number(event.target.value) })}
                />
              </Field>
              <Field label="停滞判定（分钟）" hint="速率为 0 且进度停滞超过该时长 -> 判定无资源">
                <Input
                  type="number"
                  min={5}
                  max={1440}
                  value={String(draft.btEvict.stallMinutes)}
                  onChange={(event) => patch('btEvict', { ...draft.btEvict, stallMinutes: Number(event.target.value) })}
                />
              </Field>
              <Field label="检查周期（分钟）">
                <Input
                  type="number"
                  min={1}
                  max={1440}
                  value={String(draft.btEvict.checkIntervalMin)}
                  onChange={(event) => patch('btEvict', { ...draft.btEvict, checkIntervalMin: Number(event.target.value) })}
                />
              </Field>
              <Field label="极慢：速率低于（KB/s）" hint="有速率但低于该值且预计剩余时间过长 -> 判定极慢">
                <Input
                  type="number"
                  min={1}
                  max={10240}
                  value={String(draft.btEvict.slowKbps)}
                  onChange={(event) => patch('btEvict', { ...draft.btEvict, slowKbps: Number(event.target.value) })}
                />
              </Field>
              <Field label="极慢：预计剩余超过（小时）">
                <Input
                  type="number"
                  min={1}
                  max={8760}
                  value={String(draft.btEvict.slowEtaHours)}
                  onChange={(event) => patch('btEvict', { ...draft.btEvict, slowEtaHours: Number(event.target.value) })}
                />
              </Field>
              <Field label="视为可播放的进度（%）" hint="进度达到该值且是视频时，按“未下完但可播放”处理：移交归档而不是删除">
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={String(draft.btEvict.salvagePercent)}
                  onChange={(event) => patch('btEvict', { ...draft.btEvict, salvagePercent: Number(event.target.value) })}
                />
              </Field>
            </div>
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              出清只针对“已经获得 {draft.btEvict.minAgeHours} 小时实际下载尝试时间”的任务；因磁盘空间不足被自动暂停的时间不计入尝试时间。
              每次出清后都会广播“空间已腾挪”，等待队列会立即重新评估并放行后续任务。
            </p>
          </div>
        </Card>

        {/* 外观 */}
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
                    磁盘剩余空间
                  </span>
                  <span className="tabular-nums">
                    {formatBytes(system.disk.freeBytes, '未知')} 可用 / 共{' '}
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
