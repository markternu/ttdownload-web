import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, HardDrive, RefreshCw, ScanSearch, Trash2 } from 'lucide-react'
import { Badge, Button, Card, CardHeader, EmptyState, Spinner } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { api } from '../lib/api'
import { formatBytes } from '../lib/format'
import { cn } from '../lib/cn'
import type { JunkReport } from '../types'

/**
 * 「扫描与清理垃圾」—— 树莓派长期运行 + 断电重启，会留下各种临时/半成品文件。
 * 用户不想 ssh 上去一个个找，所以这里一键扫描 + 一键清理。
 *
 * 安全设计（后端 src/services/junkScan.ts 里还有一份铁律）：
 *   · 只扫**临时/半成品**（.aria2 控制文件、yt-dlp 分片、解密/加密临时、打包暂存）；
 *   · 正在下载/解析/归档/加密的任务引用的文件一律跳过；
 *   · 「疑似孤儿成品」只报告、不放进一键清理（可能是崩溃时没入账的合法成品）。
 */
export default function JunkPage() {
  const toast = useToast()
  const [report, setReport] = useState<JunkReport | null>(null)
  const [scanning, setScanning] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const scan = useCallback(async () => {
    setScanning(true)
    try {
      const r = await api.junkScan()
      setReport(r)
      // 默认勾选所有"可一键清理"且没被跳过的类别（用户不想一个个点）
      setSelected(new Set(r.categories.filter((c) => c.autoClean && !c.skipped).map((c) => c.key)))
    } catch (e) {
      toast.error('扫描失败', (e as Error).message)
    } finally {
      setScanning(false)
    }
  }, [toast])

  useEffect(() => {
    void scan()
  }, [scan])

  const toggle = (key: string) => {
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectedBytes = useMemo(() => {
    if (!report) return 0
    return report.categories
      .filter((c) => selected.has(c.key))
      .reduce((n, c) => n + c.totalBytes, 0)
  }, [report, selected])

  const clean = async () => {
    const keys = [...selected]
    if (!keys.length) return
    const names = report!.categories.filter((c) => selected.has(c.key)).map((c) => c.label)
    const go = window.confirm(
      [
        `将清理这些类别的垃圾：${names.join('、')}`,
        '',
        `预计释放 ${formatBytes(selectedBytes)}。`,
        '',
        '· 只会删"临时/半成品"，不会碰正在下载或已经归档好的成品；',
        '· 每个文件删除前都会再校验路径，不在白名单目录里的一律跳过。',
        '',
        '确定清理吗？',
      ].join('\n'),
    )
    if (!go) return
    setCleaning(true)
    try {
      const r = await api.junkClean(keys)
      toast.success(`已清理 ${r.deleted} 项`, `释放 ${formatBytes(r.freedBytes)}${r.errors.length ? `；${r.errors.length} 项跳过` : ''}`)
      await scan()
    } catch (e) {
      toast.error('清理失败', (e as Error).message)
    } finally {
      setCleaning(false)
    }
  }

  const cleanableCats = report?.categories ?? []

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><HardDrive className="h-5 w-5" /> 扫描与清理垃圾</span>}
          subtitle="断电重启会留下各种临时/半成品文件，这里帮你找出来并一键清理（不碰正在下载和已归档的成品）"
          action={
            <Button variant="outline" size="sm" icon={<RefreshCw className="h-4 w-4" />} loading={scanning} onClick={() => void scan()}>
              重新扫描
            </Button>
          }
        />

        {!report ? (
          <div className="flex items-center justify-center py-16 text-slate-500">
            {scanning ? <Spinner /> : <ScanSearch className="h-5 w-5" />}
            <span className="ml-2">{scanning ? '正在扫描…' : ''}</span>
          </div>
        ) : (
          <>
            {/* 可一键清理的垃圾总览 */}
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 px-4 py-3 dark:bg-slate-800/50">
              <ScanSearch className="h-5 w-5 text-brand-600 dark:text-brand-400" />
              <div className="text-sm">
                可清理的垃圾：
                <strong className="tabular-nums text-slate-800 dark:text-slate-100">{report.junkCount}</strong> 项 ·
                <strong className="tabular-nums text-brand-600 dark:text-brand-400"> {formatBytes(report.junkBytes)}</strong>
              </div>
              {report.junkCount > 0 ? (
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Trash2 className="h-4 w-4" />}
                    loading={cleaning}
                    disabled={!selected.size}
                    onClick={() => void clean()}
                  >
                    一键清理已选（{formatBytes(selectedBytes)}）
                  </Button>
                </div>
              ) : null}
            </div>

            {/* 各分类 */}
            {cleanableCats.length === 0 ? (
              <EmptyState title="没扫到垃圾" description="干干净净，或者扫描还没完成。" />
            ) : (
              <div className="space-y-3">
                {cleanableCats.map((cat) => {
                  const checkable = cat.autoClean && !cat.skipped
                  const checked = selected.has(cat.key)
                  return (
                    <label
                      key={cat.key}
                      className={cn(
                        'block rounded-xl border p-3 transition-colors',
                        checked && checkable
                          ? 'border-brand-300 bg-brand-50/60 dark:border-brand-700 dark:bg-brand-950/30'
                          : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
                      )}
                    >
                      <div className="flex items-start gap-3">
                        {checkable ? (
                          <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4 cursor-pointer rounded border-slate-300 accent-brand-600 dark:border-slate-600"
                            checked={checked}
                            onChange={() => toggle(cat.key)}
                          />
                        ) : (
                          <span className="mt-0.5 text-slate-300 dark:text-slate-600">•</span>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{cat.label}</span>
                            {!cat.autoClean ? <Badge tone="warning">只报告，不自动删</Badge> : null}
                            {cat.skipped ? <Badge tone="neutral">本次跳过</Badge> : null}
                            <span className="text-xs text-slate-400">{cat.items.length} 项 · {formatBytes(cat.totalBytes)}</span>
                          </div>
                          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{cat.description}</p>
                          {cat.items.length > 0 ? (
                            <ul className="mt-2 space-y-1 border-t border-slate-100 pt-2 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
                              {cat.items.slice(0, 8).map((it) => (
                                <li key={it.path} className="truncate" title={it.path}>
                                  <span className="font-mono">{it.name}</span>
                                  <span className="ml-2 tabular-nums">{formatBytes(it.sizeBytes)}</span>
                                  <span className="ml-2 text-slate-400">· {it.reason}</span>
                                </li>
                              ))}
                              {cat.items.length > 8 ? <li className="text-slate-400">…还有 {cat.items.length - 8} 项</li> : null}
                            </ul>
                          ) : null}
                        </div>
                      </div>
                    </label>
                  )
                })}
              </div>
            )}

            {/* 目录占用（看清那几十 G 去哪了） */}
            <div className="mt-5">
              <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                <HardDrive className="h-4 w-4" /> 各目录占用
              </h4>
              <div className="space-y-1.5">
                {report.breakdown.map((b) => (
                  <div key={b.dir} className="flex items-center gap-2 text-xs">
                    <span className="w-64 truncate text-slate-500 dark:text-slate-400" title={b.dir}>
                      {b.label}
                    </span>
                    <span className="tabular-nums text-slate-700 dark:text-slate-200">{formatBytes(b.bytes)}</span>
                    {!b.exists ? <Badge tone="neutral">目录不存在</Badge> : null}
                  </div>
                ))}
              </div>
              <p className="mt-2 flex items-start gap-1.5 text-[11px] text-slate-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                「BT 完成/未完成」目录归 transmission 管，这里只报告占用、不清理（transmission 自己会续传/做种）。
              </p>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
