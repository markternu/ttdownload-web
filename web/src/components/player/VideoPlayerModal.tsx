import { useEffect, useRef, useState } from 'react'
import { ListVideo, Loader2, Play, SkipForward } from 'lucide-react'
import { Badge, Button, Modal, Spinner } from '../ui'
import { api } from '../../lib/api'
import { formatBytes } from '../../lib/format'
import type { PlayItemInfo, PlayJobInfo } from '../../types'

/**
 * 在线播放器（带播放列表）：
 *   点「播放」→ 后端解密归档 →（zip 解压）→ 得到**一组**可播放视频；
 *   这里列出全部视频，用户自己选播哪个；不是 mp4+faststart 的首播会先重封装。
 *   支持「下一个」和播完自动跳下一个。
 */

const JOB_TEXT: Record<string, string> = {
  decrypting: '正在解密归档…',
  extracting: '正在解压（zip 里可能有很多集）…',
  ready: '播放列表已就绪',
  failed: '准备失败',
}

const ITEM_TEXT: Record<PlayItemInfo['state'], string> = {
  pending: '待准备',
  remuxing: '转换中…',
  ready: '可播放',
  failed: '转换失败',
}

export interface PlayableFile {
  id: number
  name: string
  title: string
}

export function VideoPlayerModal({ file, onClose }: { file: PlayableFile | null; onClose: () => void }) {
  const [job, setJob] = useState<PlayJobInfo | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 已经点过"准备"的 index，避免每个轮询周期重复发请求 */
  const requested = useRef<Set<number>>(new Set())
  const pollRef = useRef<number | null>(null)

  // 打开时开始准备（解密 + 解压出播放列表）
  useEffect(() => {
    if (!file) return
    let cancelled = false
    setJob(null)
    setSelected(null)
    setError(null)
    requested.current.clear()
    void api
      .filePlay(file.id)
      .then((j) => {
        if (!cancelled) setJob(j)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [file])

  // 轮询任务状态（解密/解压阶段 + 播放列表里各项的转换状态）
  useEffect(() => {
    if (!job) return
    const jobId = job.id
    const stop = () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
      pollRef.current = null
    }
    if (job.state === 'failed') {
      stop()
      return
    }
    if (!pollRef.current) {
      pollRef.current = window.setInterval(() => {
        void api
          .filePlayStatus(jobId)
          .then((j) => setJob(j))
          .catch(() => {
            /* 单次失败不算失败 */
          })
      }, 1200)
    }
    return stop
  }, [job?.id, job?.state])

  // 播放列表就绪后默认选第一个
  useEffect(() => {
    if (job?.state === 'ready' && job.items.length > 0 && selected === null) {
      setSelected(job.items[0].index)
    }
  }, [job, selected])

  // 选中的视频还没准备好 → 让后端开始转（幂等，只发一次）
  useEffect(() => {
    if (!job || job.state !== 'ready' || selected === null) return
    const item = job.items.find((it) => it.index === selected)
    if (!item || item.state !== 'pending' || requested.current.has(selected)) return
    requested.current.add(selected)
    void api.filePlayPrepareItem(job.id, selected).catch(() => {
      requested.current.delete(selected)
    })
  }, [job, selected])

  // 关闭时停掉轮询
  useEffect(
    () => () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
      pollRef.current = null
    },
    [],
  )

  if (!file) return null

  const failed = job?.state === 'failed' || (!!error && !job)
  const selectedItem = job?.items.find((it) => it.index === selected) ?? null
  const currentIdx = job && selected !== null ? job.items.findIndex((it) => it.index === selected) : -1
  const hasNext = !!job && currentIdx >= 0 && currentIdx + 1 < job.items.length

  const playNext = () => {
    if (!job || currentIdx < 0) return
    const next = job.items[currentIdx + 1]
    if (next) setSelected(next.index)
  }

  return (
    <Modal
      open={!!file}
      title={`播放：${file.name}`}
      description="服务器先解密归档（zip 会解压出全部视频），不是 mp4 的会先转封装；下面的播放列表可以自己选播哪个"
      onClose={onClose}
      size="lg"
    >
      {failed ? (
        <div className="rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          <p className="font-medium">无法播放</p>
          <p className="mt-1 break-all text-xs">{job?.error || error || '未知错误'}</p>
          <p className="mt-2 text-xs text-red-600/80 dark:text-red-300/70">
            提示：如果服务器缺少 ffmpeg，请到「设置 → 系统」确认已安装；zip 里没有视频或文件损坏时也会失败。
          </p>
        </div>
      ) : !job || job.state === 'decrypting' || job.state === 'extracting' ? (
        <div className="flex flex-col items-center gap-3 py-12">
          <Spinner />
          <p className="text-sm text-slate-700 dark:text-slate-200">
            {JOB_TEXT[job?.state ?? 'decrypting'] ?? '准备中…'}
            <span className="ml-2 tabular-nums text-slate-400">{job?.progress ?? 0}%</span>
          </p>
          <div className="h-1.5 w-56 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${Math.max(3, job?.progress ?? 0)}%` }} />
          </div>
          <p className="max-w-md text-center text-xs text-slate-400">首次播放要先解密（zip 还要解压），大文件会慢一点。</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
          {/* 播放区 */}
          <div className="min-w-0">
            {selectedItem?.state === 'ready' ? (
              <video
                key={`${job.id}-${selectedItem.index}`}
                controls
                autoPlay
                playsInline
                className="w-full rounded-xl bg-black"
                src={api.filePlayStreamUrl(job.id, selectedItem.index)}
                onEnded={() => {
                  if (hasNext) playNext()
                }}
              >
                你的浏览器不支持视频播放。
              </video>
            ) : selectedItem?.state === 'failed' ? (
              <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-xl bg-red-50 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-300">
                <p>这个视频转换失败</p>
                <p className="max-w-md break-all text-center text-xs">{selectedItem.error}</p>
              </div>
            ) : (
              <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-xl bg-slate-900/90 text-slate-200">
                <Loader2 className="h-6 w-6 animate-spin" />
                <p className="text-sm">
                  {selectedItem ? (selectedItem.state === 'remuxing' ? '正在转换成 mp4（不重新编码，仅换封装）…' : '排队准备中…') : '选一个视频开始播放'}
                </p>
                <p className="text-xs text-slate-400">大文件转换要等一会儿，转好会自动播放</p>
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {job.items.length > 1 ? `共 ${job.items.length} 个视频` : '单个视频'}
                {' · '}
                总大小 {formatBytes(job.sizeBytes)}
                {selectedItem ? ` · 当前：${selectedItem.name}` : ''}
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={!hasNext} onClick={playNext}>
                  <SkipForward className="h-3.5 w-3.5" />
                  下一个
                </Button>
              </div>
            </div>
          </div>

          {/* 播放列表 */}
          <div className="min-w-0">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
              <ListVideo className="h-3.5 w-3.5" /> 播放列表（点选播放）
            </p>
            <ul className="max-h-[420px] space-y-1 overflow-auto rounded-xl border border-slate-200 p-2 dark:border-slate-800">
              {job.items.map((it) => {
                const active = it.index === selected
                return (
                  <li key={it.index}>
                    <button
                      type="button"
                      onClick={() => setSelected(it.index)}
                      className={`w-full rounded-lg px-2 py-2 text-left transition ${
                        active
                          ? 'bg-brand-50 dark:bg-brand-950/40'
                          : 'hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <Play className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-brand-600 dark:text-brand-300' : 'text-slate-400'}`} />
                        <span className="min-w-0 flex-1 truncate text-xs text-slate-700 dark:text-slate-200">{it.name}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-1 pl-5">
                        <span className="text-[11px] text-slate-400">{formatBytes(it.sizeBytes)}</span>
                        <Badge
                          tone={it.state === 'ready' ? 'success' : it.state === 'failed' ? 'danger' : it.state === 'remuxing' ? 'warning' : 'neutral'}
                        >
                          {ITEM_TEXT[it.state] ?? it.state}
                        </Badge>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  )
}
