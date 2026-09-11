import { useEffect, useState } from 'react'
import { Film, ImageOff } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface ThumbnailProps {
  src?: string | null
  alt?: string
  className?: string
  /** 图片区域比例（默认 16:9 视频封面） */
  aspect?: 'video' | 'square'
  fallbackIcon?: 'video' | 'none'
}

const ASPECT = {
  video: 'aspect-video',
  square: 'aspect-square',
}

/**
 * 缩略图：加载失败 / 无地址时展示占位，避免破图影响布局。
 * 对跨域图片使用 referrerPolicy=no-referrer，减少平台防盗链导致的失败。
 */
export function Thumbnail({ src, alt = '', className, aspect = 'video', fallbackIcon = 'video' }: ThumbnailProps) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [src])

  const showPlaceholder = !src || failed

  return (
    <div
      className={cn(
        'relative shrink-0 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-800',
        ASPECT[aspect],
        className,
      )}
    >
      {showPlaceholder ? (
        <div className="flex h-full w-full items-center justify-center text-slate-400 dark:text-slate-500">
          {fallbackIcon === 'video' ? <Film className="h-5 w-5" /> : <ImageOff className="h-5 w-5" />}
        </div>
      ) : (
        <img
          src={src ?? ''}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      )}
    </div>
  )
}
