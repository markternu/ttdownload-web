import { useCallback, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, FormEvent } from 'react'
import { Clipboard, Link2, Loader2, Search, UploadCloud } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Button, Card } from '../ui'

export interface UrlInputProps {
  value: string
  onChange: (value: string) => void
  onParse: (url: string) => void
  loading?: boolean
  error?: string | null
  disabled?: boolean
}

const URL_PATTERN = /^https?:\/\/[^\s]+$/i

export type UrlValidation = { ok: true; url: string } | { ok: false; message: string }

/** 校验并归一化 URL，返回中文错误信息 */
export function validateUrl(raw: string): UrlValidation {
  const value = raw.trim()
  if (!value) return { ok: false, message: '请先粘贴视频链接' }
  if (!/^https?:\/\//i.test(value)) {
    return { ok: false, message: 'URL 格式错误：链接需要以 http:// 或 https:// 开头' }
  }
  if (!URL_PATTERN.test(value)) {
    return { ok: false, message: 'URL 格式错误：请检查链接中是否包含空格或非法字符' }
  }
  try {
    const parsed = new URL(value)
    if (!parsed.hostname.includes('.')) {
      return { ok: false, message: 'URL 格式错误：无法识别域名' }
    }
  } catch {
    return { ok: false, message: 'URL 格式错误：无法解析该链接' }
  }
  return { ok: true, url: value }
}

/** 首页醒目的 URL 输入区：支持拖拽、粘贴与回车解析 */
export function UrlInput({ value, onChange, onParse, loading = false, error, disabled = false }: UrlInputProps) {
  const [dragging, setDragging] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = useCallback(
    (raw: string) => {
      const result = validateUrl(raw)
      if (!result.ok) {
        setLocalError(result.message)
        inputRef.current?.focus()
        return
      }
      setLocalError(null)
      onParse(result.url)
    },
    [onParse],
  )

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    submit(value)
  }

  const extractUrl = (dataTransfer: DataTransfer | null): string | null => {
    if (!dataTransfer) return null
    const text = dataTransfer.getData('text/uri-list') || dataTransfer.getData('text/plain')
    if (!text) return null
    const first = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'))
    return first ?? null
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    if (disabled || loading) return
    const dropped = extractUrl(event.dataTransfer)
    if (!dropped) {
      setLocalError('未检测到有效的链接，请拖入文本形式的视频 URL')
      return
    }
    onChange(dropped)
    submit(dropped)
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (disabled || loading) return
    setDragging(true)
  }

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return
      const first = text.trim().split(/\s+/)[0]
      onChange(first)
      setLocalError(null)
    } catch {
      setLocalError('浏览器拒绝了剪贴板访问，请使用 Ctrl / ⌘ + V 粘贴')
    }
  }

  const handleInputPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text')
    const url = text.match(/https?:\/\/\S+/i)?.[0]
    if (url) {
      event.preventDefault()
      onChange(url)
      setLocalError(null)
    }
  }

  const shownError = localError ?? error ?? null

  return (
    <Card className="p-4 sm:p-6">
      <form onSubmit={handleSubmit}>
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={() => setDragging(false)}
          className={cn(
            'rounded-2xl border-2 border-dashed p-3 transition-colors sm:p-4',
            dragging
              ? 'border-brand-500 bg-brand-50/70 dark:bg-brand-500/10'
              : 'border-slate-200 dark:border-slate-700',
          )}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Link2 className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
              <input
                ref={inputRef}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={value}
                disabled={disabled}
                onChange={(event) => {
                  onChange(event.target.value)
                  setLocalError(null)
                }}
                onPaste={handleInputPaste}
                placeholder="粘贴视频链接"
                aria-label="视频链接"
                className={cn(
                  'h-14 w-full rounded-2xl border border-slate-200 bg-white pl-12 pr-28 text-base text-slate-900',
                  'placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/15',
                  'dark:border-slate-700 dark:bg-slate-900 dark:text-slate-50',
                  shownError && 'border-red-400 focus:border-red-500 focus:ring-red-500/15',
                )}
              />
              <button
                type="button"
                onClick={() => void handlePaste()}
                className="absolute right-3 top-1/2 hidden -translate-y-1/2 items-center gap-1.5 rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-200 sm:inline-flex dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                <Clipboard className="h-3.5 w-3.5" />
                粘贴
              </button>
            </div>

            <Button
              type="submit"
              size="lg"
              className="h-14 shrink-0 px-6 text-base"
              disabled={loading || disabled}
              icon={loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Search className="h-5 w-5" />}
            >
              {loading ? '解析中…' : '解析视频'}
            </Button>
          </div>

          <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-slate-400">
            <UploadCloud className="h-3.5 w-3.5" />
            支持将链接直接拖拽到此处，或按回车快速解析
          </p>
        </div>
      </form>

      {shownError ? (
        <p
          role="alert"
          className="mt-3 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300"
        >
          {shownError}
        </p>
      ) : null}
    </Card>
  )
}
