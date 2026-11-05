import { useEffect, useRef, useState } from 'react'
import { Modal, Spinner } from '../ui'
import { api } from '../../lib/api'

/**
 * 在线播放器：点「播放」后，后端把加密归档解密 →（zip 解压）→（非 mp4 重封装成
 * mp4 + faststart），这里轮询进度，准备好后用 <video> 直接放（支持拖进度条）。
 *
 * 首次播放要解密+解压+重封装，大文件会慢；之后再点同一个文件会复用已有的准备结果。
 */

const STATE_TEXT: Record<string, string> = {
  decrypting: '正在解密归档…',
  extracting: '正在解压…',
  remuxing: '正在重封装成 mp4（不重新编码，仅换封装）…',
  ready: '可以播放了',
  failed: '准备失败',
}

export interface PlayableFile {
  id: number
  name: string
  title: string
}

export function VideoPlayerModal({ file, onClose }: { file: PlayableFile | null; onClose: () => void }) {
  const [jobId, setJobId] = useState<string | null>(null)
  const [state, setState] = useState('decrypting')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  // 打开时开始准备
  useEffect(() => {
    if (!file) return
    let cancelled = false
    setJobId(null)
    setState('decrypting')
    setProgress(0)
    setError(null)
    void api
      .filePlay(file.id)
      .then((r) => {
        if (cancelled) return
        setJobId(r.id)
        setState(r.state)
        setProgress(r.progress)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [file])

  // 轮询准备进度
  useEffect(() => {
    if (!file || !jobId) return
    const stop = () => {
      if (timer.current) window.clearInterval(timer.current)
      timer.current = null
    }
    const tick = async () => {
      try {
        const r = await api.filePlayStatus(jobId)
        setState(r.state)
        setProgress(r.progress)
        setError(r.error)
        if (r.state === 'ready' || r.state === 'failed') stop()
      } catch {
        /* 单次失败不算失败，下次再试 */
      }
    }
    void tick()
    timer.current = window.setInterval(() => void tick(), 1500)
    return stop
  }, [file, jobId])

  if (!file) return null
  const ready = state === 'ready' && !!jobId
  const failed = state === 'failed' || (!!error && !jobId)

  return (
    <Modal
      open={!!file}
      title={`播放：${file.title || file.name}`}
      description="服务器会先把加密归档解密，如果是 zip 就解压，不是 mp4 就用 ffmpeg 重封装（moov 移到文件头，才能边下边播）"
      onClose={onClose}
      size="lg"
    >
      {failed ? (
        <div className="rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          <p className="font-medium">无法播放</p>
          <p className="mt-1 break-all text-xs">{error || '未知错误'}</p>
          <p className="mt-2 text-xs text-red-600/80 dark:text-red-300/70">
            提示：如果服务器缺少 ffmpeg，请到「设置 → 系统」确认 ffmpeg 已安装；zip 里没有视频或文件损坏时也会失败。
          </p>
        </div>
      ) : ready ? (
        <video
          controls
          autoPlay
          playsInline
          className="w-full rounded-xl bg-black"
          src={api.filePlayStreamUrl(jobId)}
        >
          你的浏览器不支持视频播放。
        </video>
      ) : (
        <div className="flex flex-col items-center gap-3 py-12">
          <Spinner />
          <p className="text-sm text-slate-700 dark:text-slate-200">
            {STATE_TEXT[state] ?? '准备中…'}
            <span className="ml-2 tabular-nums text-slate-400">{progress}%</span>
          </p>
          <div className="h-1.5 w-56 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${Math.max(3, progress)}%` }} />
          </div>
          <p className="max-w-md text-center text-xs text-slate-400">
            首次播放要先解密（zip 还要解压、非 mp4 还要重封装），大文件会慢一点，准备好后会自动开始播放。
          </p>
        </div>
      )}
    </Modal>
  )
}
