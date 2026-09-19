import { useEffect, useState } from 'react'
import { HardDrive, Usb as UsbIcon, TriangleAlert } from 'lucide-react'
import { api } from '../../lib/api'
import type { UsbStatus } from '../../types'
import { formatBytes } from '../../lib/format'

const EMPTY: UsbStatus = { present: false, mounted: false }

export function UsbCard() {
  const [usb, setUsb] = useState<UsbStatus>(EMPTY)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try {
      const r = await api.usb()
      setUsb(r.usb ?? EMPTY)
    } catch {
      /* 网络波动忽略，下一轮再试 */
    }
  }

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 5000)
    return () => clearInterval(t)
  }, [])

  const act = async (fn: () => Promise<{ usb: UsbStatus }>) => {
    setBusy(true)
    try {
      const r = await fn()
      setUsb(r.usb ?? EMPTY)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3.5 dark:border-slate-800 dark:bg-slate-800/40">
      <div className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
        <UsbIcon className="h-3.5 w-3.5" />
        外部存储（U 盘 / 移动硬盘）
      </div>

      {usb.mounted ? (
        <>
          <p className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
            <HardDrive className="h-3.5 w-3.5" />
            已挂载 {usb.device}
          </p>
          <p className="mt-1 text-[11px] leading-4 text-slate-400">
            {usb.label ? `${usb.label} · ` : ''}
            {usb.fstype ? `${usb.fstype} · ` : ''}
            剩余 {usb.freeBytes != null ? formatBytes(usb.freeBytes, '—') : '—'}
            <br />
            归档成品会自动剪切到 {usb.mountpoint}/ttdownload/
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(api.usbEject)}
            className="mt-2 w-full rounded-lg bg-amber-500/10 px-2 py-1.5 text-xs font-medium text-amber-600 transition hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-400"
          >
            {busy ? '弹出中…' : '弹出（sync + umount）'}
          </button>
        </>
      ) : usb.present ? (
        <>
          <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
            <TriangleAlert className="h-3.5 w-3.5" />
            已插入但未挂载
          </p>
          {usb.lastError ? (
            <p className="mt-1 text-[11px] leading-4 text-slate-400">{usb.lastError}</p>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(api.usbMount)}
            className="mt-2 w-full rounded-lg bg-brand-500/10 px-2 py-1.5 text-xs font-medium text-brand-600 transition hover:bg-brand-500/20 disabled:opacity-50 dark:text-brand-400"
          >
            {busy ? '挂载中…' : '立即挂载'}
          </button>
        </>
      ) : (
        <p className="mt-2 text-[11px] leading-4 text-slate-400">未检测到外部存储（每 5 秒自动检测）</p>
      )}
    </div>
  )
}
