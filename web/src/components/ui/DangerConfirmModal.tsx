import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, ShieldAlert } from 'lucide-react'
import { Button, Modal } from './index'

/**
 * 「危险操作」三步确认弹窗（全站共用）。
 *
 * 为什么要有它：批量删除这类操作**不可撤销**，一次误点就是数据没了。
 * 固定三步：
 *   ① 确认范围 —— 把要删的东西逐条列出来，让人有机会发现"选多了"
 *   ② 确认影响 —— 由调用方给出"会发生什么 / 不会发生什么"（措辞必须**如实**）
 *   ③ 输入确认 —— 必须手打确认词（默认「删除」）才启用最终按钮
 *
 * 两个使用场景：文件列表（已发布/待下载）、BT 已入队种子列表。
 * 调用方负责真正执行；本组件只保证"确认到位"。
 */
export interface DangerConfirmItem {
  id: number | string
  /** 主标题（一般是文件名） */
  name: string
  /** 右侧的补充信息（一般是大小） */
  hint?: string
}

export interface DangerConfirmModalProps {
  open: boolean
  title: string
  description?: ReactNode
  items: DangerConfirmItem[]
  /** 步骤①的红框警告文案 */
  rangeWarning: ReactNode
  /** 步骤②在指示器里的名字，如「选择方式」/「确认影响」 */
  step2Label: string
  /** 步骤②的内容（会发生什么 / 不会发生什么） */
  step2Content: ReactNode
  /** 步骤③的最终说明 */
  finalSummary: ReactNode
  /** 最终按钮文案（会显示在按钮上） */
  executeLabel: string
  /** 步骤③要求手打的字，默认「删除」 */
  confirmWord?: string
  busy?: boolean
  onClose: () => void
  onConfirm: () => void
}

export function DangerConfirmModal({
  open,
  title,
  description,
  items,
  rangeWarning,
  step2Label,
  step2Content,
  finalSummary,
  executeLabel,
  confirmWord = '删除',
  busy = false,
  onClose,
  onConfirm,
}: DangerConfirmModalProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [typed, setTyped] = useState('')

  // 每次重新打开都归零：不能沿用上一次的步骤/确认词
  useEffect(() => {
    if (open) {
      setStep(1)
      setTyped('')
    }
  }, [open])

  const close = (): void => {
    if (busy) return
    onClose()
  }

  const canExecute = typed.trim() === confirmWord

  const stepLabels: { n: 1 | 2 | 3; label: string }[] = [
    { n: 1, label: '确认范围' },
    { n: 2, label: step2Label },
    { n: 3, label: '输入确认' },
  ]

  return (
    <Modal
      open={open}
      title={title}
      description={description}
      onClose={close}
      size="md"
      footer={
        step === 1 ? (
          <>
            <Button variant="outline" onClick={close} disabled={busy}>
              取消
            </Button>
            <Button variant="secondary" onClick={() => setStep(2)}>
              继续（第 2/3 步）
            </Button>
          </>
        ) : step === 2 ? (
          <>
            <Button variant="outline" onClick={() => setStep(1)} disabled={busy}>
              上一步
            </Button>
            <Button variant="secondary" onClick={() => setStep(3)}>
              继续（第 3/3 步）
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => setStep(2)} disabled={busy}>
              上一步
            </Button>
            <Button variant="danger" loading={busy} disabled={!canExecute} onClick={onConfirm}>
              {executeLabel}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
        <div className="flex items-center gap-2 text-[11px] font-medium">
          {stepLabels.map((s) => (
            <span
              key={s.n}
              className={
                'rounded-full px-2 py-0.5 ' +
                (step === s.n
                  ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300'
                  : step > s.n
                    ? 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-200'
                    : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500')
              }
            >
              {s.n}. {s.label}
            </span>
          ))}
        </div>

        {step === 1 ? (
          <>
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
              <span>{rangeWarning}</span>
            </div>
            <div className="max-h-52 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800">
              <ul className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
                {items.slice(0, 30).map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0 truncate text-slate-700 dark:text-slate-200" title={item.name}>
                      {item.name}
                    </span>
                    {item.hint ? (
                      <span className="shrink-0 tabular-nums text-slate-400">{item.hint}</span>
                    ) : null}
                  </li>
                ))}
                {items.length > 30 ? (
                  <li className="px-3 py-2 text-slate-400">…等共 {items.length} 个</li>
                ) : null}
              </ul>
            </div>
          </>
        ) : null}

        {step === 2 ? <>{step2Content}</> : null}

        {step === 3 ? (
          <>
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">
              <ShieldAlert className="mt-px h-4 w-4 shrink-0" />
              <span>{finalSummary}</span>
            </div>
            <label className="block space-y-1.5">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                请输入「{confirmWord}」两个字以启用删除按钮：
              </span>
              <input
                type="text"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder={confirmWord}
                autoComplete="off"
                className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
          </>
        ) : null}
      </div>
    </Modal>
  )
}
