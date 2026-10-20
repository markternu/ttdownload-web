import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../../lib/api'
import { humanizeError } from '../../lib/format'
import { useToast } from '../../context/ToastContext'
import { Badge, Button, Modal, Switch, Textarea } from '../ui'
import type { NovelRankBoard, NovelSourceMeta, NovelSourcesStore } from '../../types'

const SOURCE_TEMPLATE = `{
  "kind": "html",
  "id": "my-source",
  "name": "我的书源",
  "enabled": true,
  "baseUrl": "https://www.example.com",
  "encoding": "utf-8",
  "searchUrl": "https://www.example.com/search?kw={q}",
  "searchListSel": ".result",
  "searchTitleSel": ".title a",
  "searchAuthorSel": ".author",
  "searchUrlSel": ".title a",
  "bookTitleSel": "h1",
  "bookAuthorSel": ".author",
  "catalogListSel": ".catalog a",
  "catalogTitleSel": ".",
  "catalogUrlSel": ".",
  "chapterContentSel": ".content",
  "removeSel": [".ad", "script", "style"]
}`

const BOARD_TEMPLATE = `{
  "key": "platform-xxx-hot",
  "category": "platform",
  "label": "某某平台 · 热门",
  "sourceId": "my-source",
  "url": "https://www.example.com/rank/hot",
  "listSel": ".rank-list li",
  "titleSel": ".name",
  "authorSel": ".author",
  "urlSel": "a"
}`

/**
 * 「书源管理」弹窗：查看 / 启停 / 删除书源与榜单，新增用 JSON 粘贴（格式见 docs/BOOK-SOURCE.md）。
 * 保存走 PUT /api/novel/sources，服务端会逐条校验，拼错会明确指出哪条。
 */
export function SourceManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast()
  const [store, setStore] = useState<NovelSourcesStore | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [newSourceJson, setNewSourceJson] = useState('')
  const [newBoardJson, setNewBoardJson] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setStore(await api.novelSources())
    } catch (e) {
      toast.error('读取书源失败', (e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const persist = async (next: NovelSourcesStore): Promise<boolean> => {
    setBusy(true)
    try {
      const saved = await api.novelSaveSources({ sources: next.sources, rankBoards: next.rankBoards })
      setStore(saved)
      return true
    } catch (e) {
      toast.error('保存失败', humanizeError((e as { code?: string }).code ?? '', (e as Error).message))
      return false
    } finally {
      setBusy(false)
    }
  }

  if (!store) return null

  const sources = store.sources ?? []
  const boards = store.rankBoards ?? []

  const toggleSource = async (id: string, enabled: boolean) => {
    await persist({ sources: sources.map((s) => (s.id === id ? { ...s, enabled } : s)), rankBoards: boards })
  }

  const removeSource = async (id: string) => {
    if (!window.confirm(`删除书源「${id}」？`)) return
    await persist({ sources: sources.filter((s) => s.id !== id), rankBoards: boards })
  }

  const removeBoard = async (key: string) => {
    if (!window.confirm(`删除榜单「${key}」？`)) return
    await persist({ sources, rankBoards: boards.filter((b) => b.key !== key) })
  }

  const addSource = async () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(newSourceJson)
    } catch (e) {
      toast.error('JSON 格式错误', (e as Error).message)
      return
    }
    const next = { sources: [...sources, parsed as NovelSourceMeta], rankBoards: boards }
    if (await persist(next)) setNewSourceJson('')
  }

  const addBoard = async () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(newBoardJson)
    } catch (e) {
      toast.error('JSON 格式错误', (e as Error).message)
      return
    }
    const next = { sources, rankBoards: [...boards, parsed as NovelRankBoard] }
    if (await persist(next)) setNewBoardJson('')
  }

  return (
    <Modal open={open} title="书源管理" description="启用/停用/删除书源与榜单；新增用 JSON 粘贴（格式见 docs/BOOK-SOURCE.md，改完保存即生效，无需重启）" onClose={onClose} size="lg">
      <div className="space-y-5 text-sm">
        {/* 书源列表 */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="font-medium text-slate-700 dark:text-slate-200">书源（{sources.length}）</h4>
            <Button variant="ghost" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={loading} onClick={() => void load()}>刷新</Button>
          </div>
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {sources.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-slate-800 dark:text-slate-100">{s.name}</span>
                  <span className="ml-2 font-mono text-xs text-slate-400">{s.id}</span>
                  <Badge tone={s.kind === 'gutendex' ? 'success' : 'info'}>{s.kind === 'gutendex' ? '公版' : '网页'}</Badge>
                </div>
                <Switch checked={s.enabled !== false} onChange={(v) => void toggleSource(s.id, v)} disabled={busy} />
                <button type="button" title="删除" className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => void removeSource(s.id)}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-2">
            <p className="mb-1 text-xs text-slate-500">新增网页书源（粘贴 JSON；必填字段见注释）</p>
            <Textarea rows={6} value={newSourceJson} onChange={(e) => setNewSourceJson(e.target.value)} placeholder={SOURCE_TEMPLATE} className="font-mono text-xs" />
            <div className="mt-1 flex items-center gap-2">
              <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} disabled={busy || !newSourceJson.trim()} onClick={() => void addSource()}>新增书源</Button>
              <Button size="sm" variant="ghost" onClick={() => setNewSourceJson(SOURCE_TEMPLATE)}>填模板</Button>
            </div>
          </div>
        </div>

        {/* 榜单列表 */}
        <div>
          <h4 className="mb-2 font-medium text-slate-700 dark:text-slate-200">榜单（{boards.length}）</h4>
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {boards.length === 0 ? <li className="px-3 py-3 text-xs text-slate-400">还没有榜单</li> : boards.map((b) => (
              <li key={b.key} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-slate-800 dark:text-slate-100">{b.label}</span>
                  <Badge tone={b.category === 'platform' ? 'brand' : 'warning'}>{b.category === 'platform' ? '平台榜' : '类型榜'}</Badge>
                  <span className="ml-2 font-mono text-xs text-slate-400">{b.sourceId}</span>
                </div>
                <button type="button" title="删除" className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => void removeBoard(b.key)}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-2">
            <p className="mb-1 text-xs text-slate-500">新增榜单（粘贴 JSON）</p>
            <Textarea rows={5} value={newBoardJson} onChange={(e) => setNewBoardJson(e.target.value)} placeholder={BOARD_TEMPLATE} className="font-mono text-xs" />
            <div className="mt-1 flex items-center gap-2">
              <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} disabled={busy || !newBoardJson.trim()} onClick={() => void addBoard()}>新增榜单</Button>
              <Button size="sm" variant="ghost" onClick={() => setNewBoardJson(BOARD_TEMPLATE)}>填模板</Button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
