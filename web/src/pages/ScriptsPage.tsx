import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  FileCode2,
  FileWarning,
  Info,
  KeyRound,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  Upload,
  Wrench,
} from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Input,
  Select,
  Skeleton,
  Switch,
  Textarea,
} from '../components/ui'
import type { BadgeTone } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { STORAGE_KEYS } from '../lib/constants'
import { formatBytes, formatDateTime, humanizeError } from '../lib/format'
import type { ScriptDetail, ScriptItem, ScriptRun, ScriptsOverview } from '../types'

/** 单文件上限，与服务端保持一致（multer limits.fileSize） */
const MAX_SCRIPT_BYTES = 1024 * 1024
/** 运行中脚本的详情轮询间隔（毫秒） */
const POLL_MS = 2000
/** 详情默认拉取的日志行数 */
const DEFAULT_LOG_LINES = 300

const LOG_LINE_OPTIONS = [
  { value: '100', label: '最近 100 行' },
  { value: '300', label: '最近 300 行' },
  { value: '800', label: '最近 800 行' },
  { value: '2000', label: '最近 2000 行' },
]

/** 使用说明（三步） */
const STEPS = [
  '把我给你的 .sh 文件保存到本地（发在聊天里的脚本内容也行），先自己看一眼内容；',
  '在本页「维护令牌与开关」里填入令牌（.env 的 MAINTENANCE_TOKEN 或 ANDROID_TOKEN），再把「脚本执行」开关打开；',
  '上传、核对预览内容、点「上传并执行」；跑完点该脚本的「下载日志」，把日志发给我。',
]

const RESTART_HINT =
  '如果脚本里会重启服务（systemctl restart ttdownload-web），本页面可能短暂打不开；脚本在独立单元里继续执行，等 10 秒刷新页面即可看到结果。'

/* ------------------------- 本地 SHA256（用于上传前核对） ------------------------- */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

/**
 * 纯 JS 的 SHA-256（十六进制小写）。
 * 不用 crypto.subtle：树莓派一般通过 http://内网IP 访问，非安全上下文里 subtle 不可用。
 * 这里只用于「上传前把前 8 位显示给你核对」，真正入库的哈希由服务端计算。
 */
function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const bitLength = bytes.length * 8
  const padded = new Uint8Array((bytes.length + 9 + 63) & ~63)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 4, bitLength >>> 0)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000))

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let a = hash[0]
    let b = hash[1]
    let c = hash[2]
    let d = hash[3]
    let e = hash[4]
    let f = hash[5]
    let g = hash[6]
    let h = hash[7]

    for (let i = 0; i < 64; i += 1) {
      const bigS1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + bigS1 + ch + SHA256_K[i] + w[i]) >>> 0
      const bigS0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (bigS0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    hash[0] = (hash[0] + a) >>> 0
    hash[1] = (hash[1] + b) >>> 0
    hash[2] = (hash[2] + c) >>> 0
    hash[3] = (hash[3] + d) >>> 0
    hash[4] = (hash[4] + e) >>> 0
    hash[5] = (hash[5] + f) >>> 0
    hash[6] = (hash[6] + g) >>> 0
    hash[7] = (hash[7] + h) >>> 0
  }

  return Array.from(hash)
    .map((value) => value.toString(16).padStart(8, '0'))
    .join('')
}

/* --------------------------------- 展示辅助 --------------------------------- */

interface RunStatus {
  label: string
  tone: BadgeTone
  dot: boolean
  pulse?: boolean
}

/** 状态 Badge：运行中 / 成功 / 失败 / 超时 / 未运行 */
function runStatus(item: ScriptItem): RunStatus {
  if (item.running) return { label: '运行中', tone: 'info', dot: true, pulse: true }
  const run = item.lastRun
  if (!run) return { label: '未运行', tone: 'neutral', dot: false }
  if (run.timedOut) return { label: '超时', tone: 'warning', dot: false }
  if (run.exitCode === 0) return { label: '成功 exitCode=0', tone: 'success', dot: false }
  return {
    label: `失败 exitCode=${run.exitCode === null ? '未知' : run.exitCode}`,
    tone: 'danger',
    dot: false,
  }
}

/** 执行耗时（结束时间 - 开始时间） */
function runDurationText(run: ScriptRun): string {
  if (!run.finishedAt) return '执行中…'
  const start = new Date(run.startedAt).getTime()
  const end = new Date(run.finishedAt).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—'
  const seconds = (end - start) / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${Math.round(seconds - minutes * 60)} 秒`
}

/** 打开的脚本：本地选中/粘贴后即可预览，不必先上传 */
interface ScriptDraft {
  name: string
  content: string
  sizeBytes: number
  sha256: string
}

function isTokenError(err: unknown): boolean {
  return (err as { code?: string }).code === 'SCRIPT_TOKEN'
}

function errorMessage(err: unknown): string {
  return humanizeError((err as { code?: string }).code ?? '', (err as Error).message)
}

export default function ScriptsPage() {
  const toast = useToast()

  const [overview, setOverview] = useState<ScriptsOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 维护令牌（默认记住在本机）
  const [token, setToken] = useState('')
  const [rememberToken, setRememberToken] = useState(true)
  const tokenRef = useRef<HTMLInputElement>(null)
  const [toggleBusy, setToggleBusy] = useState(false)

  // 上传表单
  const [mode, setMode] = useState<'file' | 'paste'>('file')
  const [file, setFile] = useState<File | null>(null)
  const [fileDraft, setFileDraft] = useState<ScriptDraft | null>(null)
  const [pasteName, setPasteName] = useState('fix.sh')
  const [pasteContent, setPasteContent] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 详情 / 输出
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ScriptDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [logLines, setLogLines] = useState(String(DEFAULT_LOG_LINES))
  const [busyId, setBusyId] = useState<string | null>(null)

  const detailRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const stickToBottom = useRef(true)
  const wasRunning = useRef(false)

  const focusToken = useCallback(() => {
    tokenRef.current?.focus()
    tokenRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  /** 写操作统一错误提示：展示后端 message，令牌错误额外聚焦令牌输入框 */
  const writeError = useCallback(
    (title: string, err: unknown) => {
      toast.error(title, errorMessage(err))
      if (isTokenError(err)) focusToken()
    },
    [focusToken, toast],
  )

  /* ------------------------------- 令牌持久化 ------------------------------- */

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.maintToken)
      if (saved) {
        setToken(saved)
        setRememberToken(true)
      }
    } catch {
      /* localStorage 不可用（隐私模式等）时仅保存在内存里 */
    }
  }, [])

  const persistToken = useCallback((value: string, remember: boolean) => {
    try {
      if (remember) localStorage.setItem(STORAGE_KEYS.maintToken, value)
      else localStorage.removeItem(STORAGE_KEYS.maintToken)
    } catch {
      /* 忽略写入失败，令牌仍在内存里可用 */
    }
  }, [])

  const handleTokenChange = (value: string) => {
    setToken(value)
    persistToken(value, rememberToken)
  }

  const handleRememberChange = (remember: boolean) => {
    setRememberToken(remember)
    persistToken(token, remember)
  }

  /* --------------------------------- 数据加载 --------------------------------- */

  const loadOverview = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true)
      try {
        const res = await api.scriptsOverview()
        setOverview(res)
        setError(null)
      } catch (err) {
        const message = errorMessage(err)
        setError(message)
        if (!silent) toast.error('修复脚本信息读取失败', message)
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [toast],
  )

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  const loadDetail = useCallback(
    async (id: string, silent = false) => {
      if (!silent) setDetailLoading(true)
      try {
        const parsed = Number.parseInt(logLines, 10)
        const res = await api.scriptDetail(id, Number.isFinite(parsed) ? parsed : DEFAULT_LOG_LINES)
        setDetail(res)
        setDetailError(null)
      } catch (err) {
        const message = errorMessage(err)
        setDetailError(message)
        if (!silent) toast.error('脚本详情读取失败', message)
      } finally {
        if (!silent) setDetailLoading(false)
      }
    },
    [logLines, toast],
  )

  // 展开某个脚本时按需拉取详情；切换 / 收起时不保留旧数据
  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      setDetailError(null)
      return
    }
    void loadDetail(selectedId)
  }, [selectedId, loadDetail])

  // 运行中每 2 秒轮询一次；跑完后停止轮询并刷新列表
  useEffect(() => {
    if (!selectedId || detail?.item.running !== true) return
    const timer = window.setInterval(() => {
      void loadDetail(selectedId, true)
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [selectedId, detail?.item.running, loadDetail])

  useEffect(() => {
    const running = detail?.item.running === true
    if (running) {
      wasRunning.current = true
      return
    }
    if (wasRunning.current) {
      wasRunning.current = false
      void loadOverview(true)
    }
  }, [detail?.item.running, loadOverview])

  const openDetail = useCallback((id: string) => {
    setSelectedId(id)
    stickToBottom.current = true
  }, [])

  /** 详情渲染出来后滚到该脚本的输出视图 */
  useEffect(() => {
    if (!selectedId || detail?.item.id !== selectedId) return
    detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [selectedId, detail?.item.id])

  /** 日志自动滚到底部（用户手动往上翻时不打断） */
  useEffect(() => {
    const element = logRef.current
    if (!element || !stickToBottom.current) return
    element.scrollTop = element.scrollHeight
  }, [detail?.log, detail?.item.running, selectedId])

  /* ---------------------------------- 动作 ---------------------------------- */

  const handleToggle = async (next: boolean) => {
    if (next) {
      const ok = window.confirm(
        [
          '确定开启「脚本执行」吗？',
          '',
          '开启后，任何能打开本页面的人都可以上传脚本，并以服务身份（root）在这台树莓派上执行它，风险极高。',
          '请只在需要修复环境问题时开启，修完立刻回来关闭。',
          '',
          '继续开启？',
        ].join('\n'),
      )
      if (!ok) return
    }
    setToggleBusy(true)
    try {
      const res = await api.scriptsToggle(next, token)
      setOverview(res)
      toast.success(
        next ? '已开启脚本执行' : '已关闭脚本执行',
        next ? '用完请记得回来关闭这个开关' : '现在无法上传或执行任何脚本',
      )
    } catch (err) {
      writeError(next ? '开启脚本执行失败' : '关闭脚本执行失败', err)
    } finally {
      setToggleBusy(false)
    }
  }

  const acceptFile = useCallback(
    async (picked: File) => {
      if (picked.size > MAX_SCRIPT_BYTES) {
        toast.error('脚本太大', `最大 1 MB，当前 ${formatBytes(picked.size, '—')}`)
        return
      }
      let content = ''
      try {
        content = await picked.text()
      } catch {
        toast.error('读取脚本失败', '浏览器无法读取该文件，请重新选择')
        return
      }
      if (!content.trim()) {
        toast.error('脚本内容为空', '请确认选择的是修复脚本文件')
        return
      }
      setFile(picked)
      setFileDraft({
        name: picked.name,
        content,
        sizeBytes: picked.size,
        sha256: sha256Hex(content),
      })
      setConfirmed(false)
      toast.info('已读取脚本，请核对下方内容', `${picked.name} · ${formatBytes(picked.size, '—')}`)
    },
    [toast],
  )

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0]
    if (picked) void acceptFile(picked)
    // 允许连续选择同一个文件
    event.target.value = ''
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragOver(false)
    if (!overview?.enabled) {
      toast.warning('脚本执行未开启', '请先打开上面的「脚本执行」开关')
      return
    }
    const picked = event.dataTransfer?.files?.[0]
    if (picked) void acceptFile(picked)
  }

  const pasteBytes = useMemo(
    () => (pasteContent.trim() ? new TextEncoder().encode(pasteContent).length : 0),
    [pasteContent],
  )
  const pasteSha = useMemo(
    () => (pasteContent.trim() ? sha256Hex(pasteContent) : ''),
    [pasteContent],
  )

  const draft = useMemo<ScriptDraft | null>(() => {
    if (mode === 'file') return fileDraft
    if (!pasteContent.trim()) return null
    return {
      name: pasteName.trim() || 'fix.sh',
      content: pasteContent,
      sizeBytes: pasteBytes,
      sha256: pasteSha,
    }
  }, [mode, fileDraft, pasteContent, pasteBytes, pasteSha, pasteName])

  const clearDraft = () => {
    setFile(null)
    setFileDraft(null)
    setPasteContent('')
    setConfirmed(false)
  }

  const handleUpload = async (alsoRun: boolean) => {
    if (!overview?.enabled) {
      toast.warning('脚本执行未开启', '请先打开上面的「脚本执行」开关（需要维护令牌）')
      return
    }
    if (!draft) return
    if (draft.sizeBytes > MAX_SCRIPT_BYTES) {
      toast.error('脚本太大', `最大 1 MB，当前 ${formatBytes(draft.sizeBytes, '—')}`)
      return
    }
    if (alsoRun) {
      const ok = window.confirm(
        [
          `即将以服务身份（root）执行：${draft.name}`,
          '',
          '· 请确认上面的预览内容就是我要给你的脚本，一个字都不要多；',
          '· 脚本可能会重启服务（systemctl restart ttdownload-web），本页面可能短暂打不开；',
          '· 出问题可能需要你重新 SSH 上去处理。',
          '',
          '确定执行？',
        ].join('\n'),
      )
      if (!ok) return
    }

    setUploading(true)
    const fileToUpload = file
    let saved: { item: ScriptItem; overview: ScriptsOverview }
    try {
      saved =
        mode === 'file' && fileToUpload
          ? await api.scriptsUpload(fileToUpload, token)
          : await api.scriptsUploadText(draft.name, draft.content, token)
    } catch (err) {
      writeError('上传失败', err)
      setUploading(false)
      void loadOverview(true)
      return
    }

    setOverview(saved.overview)
    clearDraft()

    if (!alsoRun) {
      toast.success('已上传（未执行）', `${saved.item.name} · SHA256 ${saved.item.sha256.slice(0, 8)}`)
      openDetail(saved.item.id)
      setUploading(false)
      return
    }

    try {
      const res = await api.scriptRun(saved.item.id, token)
      setOverview((current) =>
        current
          ? {
              ...current,
              items: current.items.map((entry) => (entry.id === res.item.id ? res.item : entry)),
            }
          : current,
      )
      toast.success('已开始执行', `执行方式：${res.via}；脚本在独立单元里运行`)
      openDetail(res.item.id)
      void loadOverview(true)
    } catch (err) {
      writeError('执行失败', err)
      openDetail(saved.item.id)
      void loadOverview(true)
    } finally {
      setUploading(false)
    }
  }

  const handleRun = async (item: ScriptItem) => {
    const ok = window.confirm(
      [
        `即将以服务身份（root）执行：${item.name}`,
        '',
        '· 请确认这是我给你的脚本，并且你已经核对过内容；',
        '· 脚本可能会重启服务（systemctl restart ttdownload-web），本页面可能短暂打不开。',
        '',
        '确定执行？',
      ].join('\n'),
    )
    if (!ok) return
    setBusyId(item.id)
    try {
      const res = await api.scriptRun(item.id, token)
      setOverview((current) =>
        current
          ? {
              ...current,
              items: current.items.map((entry) => (entry.id === res.item.id ? res.item : entry)),
            }
          : current,
      )
      toast.success('已开始执行', `执行方式：${res.via}`)
      openDetail(res.item.id)
      void loadOverview(true)
    } catch (err) {
      writeError('执行失败', err)
      void loadOverview(true)
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (item: ScriptItem) => {
    const ok = window.confirm(
      [`确定删除脚本「${item.name}」吗？`, '', '脚本文件与执行日志都会被删除，无法恢复。'].join('\n'),
    )
    if (!ok) return
    setBusyId(item.id)
    try {
      const res = await api.scriptDelete(item.id, token)
      setOverview(res.overview)
      if (selectedId === item.id) setSelectedId(null)
      toast.success('已删除', item.name)
    } catch (err) {
      writeError('删除失败', err)
      void loadOverview(true)
    } finally {
      setBusyId(null)
    }
  }

  const openDownload = (url: string, title: string, description: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
    toast.success(title, description)
  }

  /* ---------------------------------- 渲染 ---------------------------------- */

  const items = overview?.items ?? []
  const itemsCount = items.length

  return (
    <div className="space-y-5">
      {/* 页头 */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-slate-50">
            <Wrench className="h-4 w-4" />
            修复脚本
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            系统环境问题（缺包 / 权限 / systemd 配置 / Node 版本等）时，上传我给你的修复脚本，一键执行
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          loading={loading}
          onClick={() => void loadOverview()}
          icon={<RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />}
        >
          刷新
        </Button>
      </div>

      {/* 1. 警告 + 用途 */}
      <Card className="border-red-300 bg-red-50/70 dark:border-red-500/50 dark:bg-red-500/10">
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2 text-red-700 dark:text-red-300">
              <ShieldAlert className="h-4 w-4" />
              高危操作：请只运行我给你的脚本
            </span>
          }
          action={<Badge tone="danger">上传即 root 执行</Badge>}
        />
        <p className="text-sm font-semibold leading-relaxed text-red-800 sm:text-base dark:text-red-200">
          这是「上传即以服务身份（root）执行」的通道，请只运行我（开发者）给你的脚本。
        </p>
        <ul className="mt-3 space-y-2 text-xs leading-relaxed text-slate-700 sm:text-sm dark:text-slate-200">
          <li className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
            <span>
              <span className="font-semibold">代码逻辑问题</span>
              {' → '}我 push 代码，你执行{' '}
              <code className="rounded bg-slate-900/5 px-1 py-0.5 font-mono text-[11px] dark:bg-white/10">
                sudo ./deploy.sh --update
              </code>
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span>
              <span className="font-semibold">系统环境问题（缺包 / 权限 / Node 版本等）</span>
              {' → '}用这个页面上传我给你的修复脚本
            </span>
          </li>
        </ul>
        {overview?.allowlistHint ? (
          <p className="mt-3 flex items-start gap-2 rounded-xl bg-white/70 px-3 py-2 text-xs leading-relaxed text-slate-600 dark:bg-slate-900/40 dark:text-slate-300">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{overview.allowlistHint}</span>
          </p>
        ) : null}
      </Card>

      {loading && !overview ? (
        <Card>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-3 h-10 w-full" />
          <Skeleton className="mt-3 h-24 w-full" />
          <Skeleton className="mt-3 h-4 w-64" />
        </Card>
      ) : error && !overview ? (
        <ErrorState
          message={`修复脚本信息读取失败：${error}`}
          onRetry={() => void loadOverview()}
        />
      ) : overview ? (
        <>
          {/* 2. 令牌与开关 */}
          <Card>
            <CardHeader
              title={
                <span className="inline-flex items-center gap-2">
                  <KeyRound className="h-4 w-4" />
                  维护令牌与开关
                </span>
              }
              subtitle="写操作（开启/上传/执行/删除）都要带令牌，令牌与 .env 里的 MAINTENANCE_TOKEN（或 ANDROID_TOKEN）一致"
              action={
                <Badge tone={overview.enabled ? 'danger' : 'neutral'} dot pulse={overview.enabled}>
                  {overview.enabled ? '脚本执行已开启' : '脚本执行已关闭'}
                </Badge>
              }
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Input
                  ref={tokenRef}
                  type="password"
                  label="维护令牌"
                  value={token}
                  autoComplete="off"
                  placeholder=".env 里的 MAINTENANCE_TOKEN 或 ANDROID_TOKEN"
                  hint="令牌错误时会提示「维护令牌不正确」，改动令牌后请重新操作一次"
                  onChange={(event) => handleTokenChange(event.target.value)}
                />
                <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={rememberToken}
                    onChange={(event) => handleRememberChange(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/40 dark:border-slate-600 dark:bg-slate-800"
                  />
                  记住在本机（存 localStorage，取消勾选则只保留在本次页面）
                </label>
              </div>

              <div className="space-y-3">
                {!overview.tokenRequired ? (
                  <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      服务端未配置维护令牌：本页任何能访问的人都能上传并执行脚本，建议在 .env 里设置
                      MAINTENANCE_TOKEN
                    </span>
                  </p>
                ) : (
                  <p className="flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
                    <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    <span>服务端已配置维护令牌：开启、上传、执行、删除都需要令牌。</span>
                  </p>
                )}
                <Switch
                  checked={overview.enabled}
                  disabled={toggleBusy}
                  onChange={(next) => void handleToggle(next)}
                  label="脚本执行"
                  description={
                    overview.enabled
                      ? '已开启：可通过本页执行任意脚本，用完请立刻关闭'
                      : '已关闭：无法上传或执行脚本（默认状态）'
                  }
                />
                <p className="flex items-center gap-1.5 text-[11px] text-slate-400 dark:text-slate-500">
                  <Clock className="h-3 w-3 shrink-0" />
                  单次执行超时：{overview.timeoutSec} 秒，超时会被强制终止
                </p>
              </div>
            </div>
          </Card>

          {/* 3. 上传并执行 */}
          <Card className="border-amber-200 dark:border-amber-500/40">
            <CardHeader
              title={
                <span className="inline-flex items-center gap-2">
                  <TerminalSquare className="h-4 w-4 text-amber-600 dark:text-amber-300" />
                  上传并执行
                </span>
              }
              subtitle="先上传，再核对预览内容，确认无误后才执行"
              action={
                overview.enabled ? (
                  <Badge tone="warning">已开启，注意风险</Badge>
                ) : (
                  <Badge tone="neutral">功能未开启</Badge>
                )
              }
            />

            {!overview.enabled ? (
              <p className="mb-4 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  脚本执行未开启：请先在上面的「脚本执行」开关把它打开（需要维护令牌），开启后本区才能上传和执行。
                </span>
              </p>
            ) : null}

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant={mode === 'file' ? 'primary' : 'outline'}
                size="sm"
                block
                className="sm:w-auto"
                onClick={() => setMode('file')}
                icon={<FileCode2 className="h-3.5 w-3.5" />}
              >
                上传脚本文件
              </Button>
              <Button
                variant={mode === 'paste' ? 'primary' : 'outline'}
                size="sm"
                block
                className="sm:w-auto"
                onClick={() => setMode('paste')}
                icon={<TerminalSquare className="h-3.5 w-3.5" />}
              >
                粘贴脚本内容
              </Button>
            </div>

            {mode === 'file' ? (
              <div
                onDragOver={(event) => {
                  event.preventDefault()
                  if (overview.enabled) setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                className={cn(
                  'mt-3 rounded-2xl border border-dashed px-4 py-6 text-center transition-colors',
                  dragOver
                    ? 'border-brand-400 bg-brand-50/70 dark:border-brand-500 dark:bg-brand-500/10'
                    : 'border-slate-300 bg-slate-50/60 dark:border-slate-700 dark:bg-slate-800/30',
                  !overview.enabled && 'opacity-60',
                )}
              >
                <Upload className="mx-auto h-6 w-6 text-slate-400" />
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                  把 .sh 文件拖到这里，或者
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".sh,.bash,text/x-shellscript,text/plain"
                  className="hidden"
                  onChange={handleFileInput}
                />
                <Button
                  variant="outline"
                  size="sm"
                  block
                  className="mt-2 sm:mx-auto sm:w-auto"
                  disabled={!overview.enabled}
                  onClick={() => fileInputRef.current?.click()}
                  icon={<FileCode2 className="h-3.5 w-3.5" />}
                >
                  选择 .sh 脚本
                </Button>
                <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
                  只接受文本 shell 脚本，最大 1 MB
                </p>
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                <Input
                  label="脚本文件名"
                  value={pasteName}
                  placeholder="fix.sh"
                  disabled={!overview.enabled}
                  onChange={(event) => setPasteName(event.target.value)}
                />
                <Textarea
                  label="脚本内容"
                  value={pasteContent}
                  disabled={!overview.enabled}
                  placeholder={'#!/bin/bash\nset -e\n\n# 修复脚本内容粘贴到这里'}
                  className="font-mono"
                  onChange={(event) => {
                    setPasteContent(event.target.value)
                    setConfirmed(false)
                  }}
                />
              </div>
            )}

            {draft ? (
              <div className="mt-4 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    脚本预览（只读，请逐行核对）
                  </p>
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                    <Badge tone="neutral">{draft.name}</Badge>
                    <span>{formatBytes(draft.sizeBytes, '—')}</span>
                    <span className="font-mono">SHA256 {draft.sha256.slice(0, 8)}</span>
                  </div>
                </div>
                <pre className="max-h-80 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-slate-700 sm:text-xs dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
                  {draft.content}
                </pre>
                <Switch
                  checked={confirmed}
                  onChange={setConfirmed}
                  label="我已阅读并确认脚本内容"
                  description="确认内容与开发者给你的脚本一致后，才启用「上传并执行」"
                />
              </div>
            ) : (
              <p className="mt-4 rounded-xl bg-slate-50 px-3 py-4 text-center text-xs text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
                还没有选择脚本：选好文件或粘贴内容后，这里会显示完整内容供你核对
              </p>
            )}

            <div className="mt-4 flex flex-col gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:flex-wrap dark:border-slate-800">
              <Button
                variant="danger"
                block
                className="sm:w-auto"
                disabled={!overview.enabled || !draft || !confirmed || uploading}
                loading={uploading}
                onClick={() => void handleUpload(true)}
                icon={<Play className="h-4 w-4" />}
              >
                上传并执行
              </Button>
              <Button
                variant="outline"
                block
                className="sm:w-auto"
                disabled={!overview.enabled || !draft || uploading}
                loading={uploading}
                onClick={() => void handleUpload(false)}
                icon={<Upload className="h-4 w-4" />}
              >
                仅上传不执行
              </Button>
            </div>
            <p className="mt-2 flex items-start gap-2 text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              <span>「上传并执行」会弹一次确认框；执行后页面可能短暂失联，属于正常现象。</span>
            </p>
          </Card>

          {/* 4. 脚本列表 + 输出 */}
          <Card>
            <CardHeader
              title="脚本列表与执行输出"
              subtitle={`共 ${itemsCount} 个脚本；运行中的脚本每 2 秒自动刷新输出`}
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  loading={loading}
                  onClick={() => void loadOverview()}
                  icon={<RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />}
                >
                  刷新
                </Button>
              }
            />

            <p className="mb-4 flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span>{RESTART_HINT}</span>
            </p>

            {itemsCount === 0 ? (
              <EmptyState
                icon={<FileWarning className="h-5 w-5" />}
                title="还没有上传过修复脚本"
                description="环境出问题时，把我给你的 .sh 文件上传到这里，核对预览后再执行。"
              />
            ) : (
              <ul className="space-y-3">
                {items.map((item) => {
                  const status = runStatus(item)
                  const expanded = selectedId === item.id
                  const activeDetail = detail && detail.item.id === item.id ? detail : null
                  const run = item.lastRun
                  return (
                    <li
                      key={item.id}
                      className={cn(
                        'rounded-2xl border p-3.5 transition-colors',
                        expanded
                          ? 'border-brand-300 bg-brand-50/40 dark:border-brand-500/50 dark:bg-brand-500/5'
                          : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
                      )}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p
                              className="truncate font-mono text-sm font-semibold text-slate-800 dark:text-slate-100"
                              title={item.name}
                            >
                              {item.name}
                            </p>
                            <Badge tone={status.tone} dot={status.dot} pulse={status.pulse}>
                              {status.label}
                            </Badge>
                          </div>
                          <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                            上传 {formatDateTime(item.uploadedAt)} · {formatBytes(item.sizeBytes, '—')} ·
                            已执行 {item.runCount} 次
                          </p>
                          <p className="mt-0.5 break-all font-mono text-[11px] text-slate-400 dark:text-slate-500">
                            SHA256 {item.sha256.slice(0, 8)}…
                          </p>
                          {run ? (
                            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                              最近执行 {formatDateTime(run.startedAt)} · 退出码{' '}
                              {run.exitCode === null ? '—' : run.exitCode} · 耗时{' '}
                              {runDurationText(run)} · 方式 {run.via}
                            </p>
                          ) : null}
                        </div>
                      </div>

                      <div className="mt-3 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center">
                        <Button
                          variant="outline"
                          size="sm"
                          block
                          className="sm:w-auto"
                          onClick={() => (expanded ? setSelectedId(null) : openDetail(item.id))}
                        >
                          {expanded ? '收起' : '查看'}
                        </Button>
                        <Button
                          variant={item.running ? 'secondary' : 'primary'}
                          size="sm"
                          block
                          className="sm:w-auto"
                          disabled={item.running || busyId === item.id}
                          loading={busyId === item.id}
                          onClick={() => void handleRun(item)}
                          icon={<Play className="h-3.5 w-3.5" />}
                        >
                          {item.running ? '运行中' : '执行'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          block
                          className="sm:w-auto"
                          onClick={() =>
                            openDownload(api.scriptFileUrl(item.id), '已开始下载脚本', item.name)
                          }
                          icon={<Download className="h-3.5 w-3.5" />}
                        >
                          下载脚本
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          block
                          className="sm:w-auto"
                          onClick={() =>
                            openDownload(
                              api.scriptLogUrl(item.id),
                              '已开始下载执行日志',
                              '把这个日志文件发给我即可',
                            )
                          }
                          icon={<Download className="h-3.5 w-3.5" />}
                        >
                          下载日志
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          block
                          className="sm:w-auto"
                          disabled={item.running || busyId === item.id}
                          onClick={() => void handleDelete(item)}
                          icon={<Trash2 className="h-3.5 w-3.5" />}
                        >
                          删除
                        </Button>
                      </div>

                      {expanded ? (
                        <div
                          ref={detailRef}
                          className="mt-4 space-y-4 border-t border-slate-200 pt-4 dark:border-slate-800"
                        >
                          {detailLoading && !activeDetail ? (
                            <div className="space-y-3">
                              <Skeleton className="h-4 w-48" />
                              <Skeleton className="h-24 w-full" />
                            </div>
                          ) : detailError && !activeDetail ? (
                            <ErrorState
                              message={`脚本详情读取失败：${detailError}`}
                              onRetry={() => void loadDetail(item.id)}
                            />
                          ) : activeDetail ? (
                            <>
                              <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                                <Badge tone={runStatus(activeDetail.item).tone}>
                                  {runStatus(activeDetail.item).label}
                                </Badge>
                                {activeDetail.item.lastRun ? (
                                  <>
                                    <span>
                                      退出码{' '}
                                      {activeDetail.item.lastRun.exitCode === null
                                        ? '—'
                                        : activeDetail.item.lastRun.exitCode}
                                    </span>
                                    <span>耗时 {runDurationText(activeDetail.item.lastRun)}</span>
                                    <span>方式 {activeDetail.item.lastRun.via}</span>
                                  </>
                                ) : (
                                  <span>还没有执行过</span>
                                )}
                                <span>超时上限 {activeDetail.timeoutSec} 秒</span>
                              </div>

                              {activeDetail.item.lastRun ? (
                                <p className="break-all font-mono text-[11px] text-slate-400 dark:text-slate-500">
                                  日志路径：{activeDetail.item.lastRun.logPath}
                                </p>
                              ) : null}

                              <div className="space-y-2">
                                <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                                  脚本内容（只读）
                                </p>
                                <pre className="max-h-80 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-slate-700 sm:text-xs dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
                                  {activeDetail.preview || '（空脚本）'}
                                </pre>
                              </div>

                              <div className="space-y-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                                    执行输出（共 {activeDetail.logLines} 行）
                                  </p>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <div className="w-36">
                                      <Select
                                        value={logLines}
                                        options={LOG_LINE_OPTIONS}
                                        onChange={(event) => setLogLines(event.target.value)}
                                      />
                                    </div>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      loading={detailLoading}
                                      onClick={() => void loadDetail(item.id)}
                                      icon={<RefreshCw className="h-3.5 w-3.5" />}
                                    >
                                      刷新输出
                                    </Button>
                                  </div>
                                </div>
                                {detailError ? (
                                  <p className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                    刷新失败：{detailError}（下方为上次结果）
                                  </p>
                                ) : null}
                                <pre
                                  ref={logRef}
                                  onScroll={(event) => {
                                    const element = event.currentTarget
                                    stickToBottom.current =
                                      element.scrollHeight - element.scrollTop - element.clientHeight <
                                      40
                                  }}
                                  className="max-h-[60vh] overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-slate-300 sm:text-xs"
                                >
                                  {activeDetail.log ? activeDetail.log : '（还没有执行输出）'}
                                </pre>
                                <p className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
                                  <Info className="mt-0.5 h-3 w-3 shrink-0" />
                                  <span>{RESTART_HINT}</span>
                                </p>
                              </div>
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        </>
      ) : null}

      {/* 5. 使用说明 */}
      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              怎么用（三步）
            </span>
          }
          subtitle="整个过程不需要 SSH，但请务必核对预览内容"
        />
        <ol className="space-y-2.5 text-sm text-slate-700 dark:text-slate-200">
          {STEPS.map((text, index) => (
            <li key={text} className="flex items-start gap-2.5">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 text-[11px] font-semibold text-white">
                {index + 1}
              </span>
              <span className="min-w-0 leading-relaxed">{text}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            用完记得把「脚本执行」开关关回去；不确定脚本干什么就先别执行，把预览内容发我确认。
          </span>
        </p>
      </Card>
    </div>
  )
}
