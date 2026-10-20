import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowLeft, BookOpen, Download, FileText, Search } from 'lucide-react'
import { Badge, Button, Card, CardHeader, EmptyState, Input, Spinner } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { api } from '../lib/api'
import type { NovelBook, NovelChapter, NovelSearchItem } from '../types'

/**
 * 「小说」页：按书名搜索 → 选书看目录 → 读章节 → 下载整本 txt。
 * 也支持从榜单页跳进来（?source=xxx&url=xxx 直接打开书）。
 */
export default function NovelPage() {
  const toast = useToast()
  const [params] = useSearchParams()

  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)
  const [items, setItems] = useState<NovelSearchItem[]>([])
  const [errors, setErrors] = useState<{ source: string; message: string }[]>([])

  const [book, setBook] = useState<NovelBook | null>(null)
  const [bookSource, setBookSource] = useState('')
  const [bookUrl, setBookUrl] = useState('')
  const [loadingBook, setLoadingBook] = useState(false)
  const [chapter, setChapter] = useState<{ title: string; content: string } | null>(null)
  const [readingUrl, setReadingUrl] = useState('')
  const [reading, setReading] = useState(false)
  const [downloading, setDownloading] = useState(false)

  const openBook = useCallback(async (sourceId: string, url: string) => {
    setLoadingBook(true)
    setBook(null)
    setChapter(null)
    setBookSource(sourceId)
    setBookUrl(url)
    try {
      const b = await api.novelBook(sourceId, url)
      setBook(b)
    } catch (e) {
      toast.error('打开书籍失败', (e as Error).message)
    } finally {
      setLoadingBook(false)
    }
  }, [toast])

  // 榜单跳转：?source=&url= 直接打开书
  useEffect(() => {
    const source = params.get('source')
    const url = params.get('url')
    if (source && url) void openBook(source, url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  const doSearch = async () => {
    if (!q.trim()) return
    setSearching(true)
    setBook(null)
    setItems([])
    setErrors([])
    try {
      const r = await api.novelSearch(q.trim())
      setItems(r.items ?? [])
      setErrors(r.errors ?? [])
      if (!r.items?.length) toast.info('没搜到', errors.length ? '部分书源不可用，可换关键词再试' : '换个关键词试试')
    } catch (e) {
      toast.error('搜索失败', (e as Error).message)
    } finally {
      setSearching(false)
    }
  }

  const readChapter = async (ch: NovelChapter) => {
    setReading(true)
    setReadingUrl(ch.url)
    setChapter(null)
    try {
      setChapter(await api.novelChapter(bookSource, ch.url))
    } catch (e) {
      toast.error('章节读取失败', (e as Error).message)
    } finally {
      setReading(false)
    }
  }

  const download = () => {
    if (!bookSource || !bookUrl) return
    setDownloading(true)
    const a = document.createElement('a')
    a.href = api.novelDownloadUrl(bookSource, bookUrl)
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => setDownloading(false), 1500)
    toast.info('开始下载', '服务器抓取整本后会以 .txt 下载（章节多时稍等）')
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><BookOpen className="h-5 w-5" /> 小说资源</span>}
          subtitle="输入书名搜索，选书后可看目录、读章节、下载整本 txt（书源可自行增删）"
        />
        <div className="flex gap-2">
          <Input
            value={q}
            placeholder="输入小说名，例如：星辰大海"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void doSearch()}
          />
          <Button icon={<Search className="h-4 w-4" />} loading={searching} onClick={() => void doSearch()}>
            搜索
          </Button>
        </div>
        {errors.length > 0 ? (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            {errors.length} 个书源不可用（{errors.map((e) => e.source).join('、')}），已用其余源返回结果
          </p>
        ) : null}
      </Card>

      {loadingBook ? (
        <div className="flex items-center justify-center py-16 text-slate-500"><Spinner /><span className="ml-2">正在读取书籍…</span></div>
      ) : book ? (
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50">{book.title}</h3>
              <p className="mt-0.5 text-sm text-slate-500">作者：{book.author}</p>
              {book.intro ? <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{book.intro}</p> : null}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" size="sm" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => { setBook(null); setItems([]); }}>
                返回搜索
              </Button>
              <Button size="sm" icon={<Download className="h-4 w-4" />} loading={downloading} onClick={download}>
                下载 txt
              </Button>
            </div>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {/* 目录 */}
            <div className="max-h-[70vh] overflow-auto rounded-xl border border-slate-200 p-2 dark:border-slate-800">
              <p className="px-2 py-1 text-xs font-medium text-slate-500">目录（{book.chapters.length} 章）</p>
              {book.chapters.length === 0 ? (
                <p className="px-2 py-3 text-xs text-slate-400">该书源没有目录（可能是公版书整本下载，直接点「下载 txt」）</p>
              ) : (
                <ul className="space-y-0.5">
                  {book.chapters.map((ch) => (
                    <li key={ch.url}>
                      <button
                        type="button"
                        className={`w-full truncate rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 ${readingUrl === ch.url ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300' : 'text-slate-700 dark:text-slate-200'}`}
                        onClick={() => void readChapter(ch)}
                      >
                        {ch.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 正文 */}
            <div className="max-h-[70vh] overflow-auto rounded-xl border border-slate-200 p-4 dark:border-slate-800">
              {reading ? (
                <div className="flex items-center justify-center py-10 text-slate-500"><Spinner /></div>
              ) : chapter ? (
                <div className="text-sm leading-relaxed text-slate-700 dark:text-slate-200">
                  {chapter.title ? <h4 className="mb-3 text-base font-semibold">{chapter.title}</h4> : null}
                  <div className="whitespace-pre-wrap">{chapter.content}</div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-slate-400">
                  <span className="flex items-center gap-2"><FileText className="h-4 w-4" /> 点左侧目录读章节</span>
                </div>
              )}
            </div>
          </div>
        </Card>
      ) : items.length ? (
        <Card padded={false}>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((it, i) => (
              <li key={`${it.sourceId}-${it.url}-${i}`}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  onClick={() => void openBook(it.sourceId, it.url)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{it.title}</p>
                    <p className="mt-0.5 truncate text-xs text-slate-400">{it.author} · {it.sourceName}</p>
                    {it.intro ? <p className="mt-1 line-clamp-1 text-xs text-slate-400">{it.intro}</p> : null}
                  </div>
                  <Badge tone="neutral">{it.sourceName}</Badge>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <EmptyState title="搜索小说" description="在上方输入书名，例如「星辰大海」，会从所有启用的书源里聚合搜索结果。" />
      )}
    </div>
  )
}
