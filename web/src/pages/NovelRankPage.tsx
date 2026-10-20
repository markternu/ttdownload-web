import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { BookOpen, ChevronRight, ListOrdered, Sparkles } from 'lucide-react'
import { Button, Card, CardHeader, EmptyState, Spinner } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { api } from '../lib/api'
import type { NovelRankBoard, NovelRankItem } from '../types'

/**
 * 「小说榜单」页：平台榜（起点/晋江/番茄/七猫…）与类型榜（科幻/玄幻/修仙/穿越…），
 * 每个榜单一个专属子页（/novel-rank?key=xxx），点书跳去「小说」页打开。
 */
export default function NovelRankPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const key = params.get('key')

  const [boards, setBoards] = useState<{ platform: NovelRankBoard[]; genre: NovelRankBoard[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<NovelRankItem[]>([])
  const [boardTitle, setBoardTitle] = useState('')
  const [loadingBoard, setLoadingBoard] = useState(false)

  useEffect(() => {
    void api.novelBoards().then(setBoards).catch((e) => toast.error('加载榜单失败', (e as Error).message)).finally(() => setLoading(false))
  }, [toast])

  const openBoard = useCallback(async (boardKey: string) => {
    const b = [...(boards?.platform ?? []), ...(boards?.genre ?? [])].find((x) => x.key === boardKey)
    setBoardTitle(b?.label ?? boardKey)
    setLoadingBoard(true)
    setItems([])
    try {
      setItems((await api.novelBoard(boardKey)).items ?? [])
    } catch (e) {
      toast.error('榜单加载失败', (e as Error).message)
    } finally {
      setLoadingBoard(false)
    }
  }, [boards, toast])

  useEffect(() => {
    if (key && boards) void openBoard(key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, boards])

  const goBook = (item: NovelRankItem, board: NovelRankBoard) => {
    navigate(`/novel?source=${encodeURIComponent(board.sourceId)}&url=${encodeURIComponent(item.url)}`)
  }

  const currentBoard = [...(boards?.platform ?? []), ...(boards?.genre ?? [])].find((x) => x.key === key)

  // 榜单详情页
  if (key) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader
            title={<span className="flex items-center gap-2"><ListOrdered className="h-5 w-5" /> {boardTitle || '榜单'}</span>}
            action={<Button variant="outline" size="sm" onClick={() => navigate('/novel-ranks')}>返回榜单</Button>}
          />
          {loadingBoard ? (
            <div className="flex items-center justify-center py-12 text-slate-500"><Spinner /></div>
          ) : items.length === 0 ? (
            <EmptyState title="暂无榜单数据" description="这个榜单还没配置真实数据源，或该源暂时抓不到。" />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {items.map((it, i) => (
                <li key={`${it.url}-${i}`}>
                  <button type="button" className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => currentBoard && goBook(it, currentBoard)}>
                    <span className="w-6 shrink-0 text-center text-xs tabular-nums text-slate-400">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 dark:text-slate-100">{it.title}</span>
                    <span className="shrink-0 text-xs text-slate-400">{it.author}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    )
  }

  // 榜单总览页
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><Sparkles className="h-5 w-5" /> 小说榜单</span>}
          subtitle="平台榜与类型榜，点进去看各平台 / 各类型最热书，再点书去下载"
        />
        {loading ? (
          <div className="flex items-center justify-center py-12 text-slate-500"><Spinner /></div>
        ) : (
          <div className="space-y-5">
            <BoardGroup title="平台榜" icon={<BookOpen className="h-4 w-4" />} boards={boards?.platform ?? []} onOpen={openBoard} />
            <BoardGroup title="类型榜" icon={<ListOrdered className="h-4 w-4" />} boards={boards?.genre ?? []} onOpen={openBoard} />
            {(!boards || (!boards.platform.length && !boards.genre.length)) ? (
              <EmptyState title="还没有榜单" description="在服务器 state/book-sources.json 里配置榜单 URL 后即可显示。" />
            ) : null}
          </div>
        )}
      </Card>
    </div>
  )
}

function BoardGroup({ title, icon, boards, onOpen }: { title: string; icon: React.ReactNode; boards: NovelRankBoard[]; onOpen: (key: string) => void }) {
  if (!boards.length) return null
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">{icon}{title}</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {boards.map((b) => (
          <button
            key={b.key}
            type="button"
            className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-3 text-left text-sm font-medium text-slate-700 transition hover:border-brand-300 hover:bg-brand-50/50 dark:border-slate-700 dark:text-slate-200 dark:hover:border-brand-600"
            onClick={() => onOpen(b.key)}
          >
            <span className="truncate">{b.label}</span>
            <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
          </button>
        ))}
      </div>
    </div>
  )
}
