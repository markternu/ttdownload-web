import { useSyncExternalStore } from 'react'
import { api } from './api'
import { humanizeError } from './format'
import { validateUrl } from '../components/video/UrlInput'
import type { ParseResult } from '../types'

/**
 * 首页「解析视频」的状态仓库 —— 放在组件外面，**不随页面切换而丢失**。
 *
 * 修的就是这个 bug：以前 url / result / parsing 都是 HomePage 的 useState，
 * 用户点了「解析视频」→ 等得久 → 切到「任务」页看看 → 再切回首页：
 * 组件被卸载重挂，状态全没了，解析请求的结果也丢了（回来是个空首页）。
 *
 * 现在：
 *   · 请求本身跑在组件之外，切页不会中断；
 *   · 结果、输入框内容、是否解析中 都保存在仓库里，切回来原样还在（"解析中…"也还在转）；
 *   · 同时写一份到 sessionStorage，浏览器刷新/前进后退也不会丢（关标签页才清）。
 */

export interface ParseState {
  /** 输入框里的地址 */
  url: string
  parsing: boolean
  result: ParseResult | null
  error: string | null
  /** 上次解析开始时间（用于显示"已等待 N 秒"） */
  startedAt: number | null
  /** 解析成功/失败的时间 */
  finishedAt: number | null
}

const EMPTY: ParseState = {
  url: '',
  parsing: false,
  result: null,
  error: null,
  startedAt: null,
  finishedAt: null,
}

const STORAGE_KEY = 'ttdl.parse'

function readStorage(): ParseState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as Partial<ParseState>
    // 刷新页面后不会再有请求在跑，parsing 必须归零，否则会一直显示"解析中"
    return { ...EMPTY, ...parsed, parsing: false }
  } catch {
    return EMPTY
  }
}

let state: ParseState = typeof sessionStorage === 'undefined' ? EMPTY : readStorage()
const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) fn()
}

function writeStorage(): void {
  try {
    // parsing 不落盘：刷新后不该显示"解析中"
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, parsing: false }))
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

function setState(patch: Partial<ParseState>): void {
  state = { ...state, ...patch }
  writeStorage()
  emit()
}

/** 只有内容真的变了才通知（useSyncExternalStore 要求 getSnapshot 稳定） */
function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function getSnapshot(): ParseState {
  return state
}

export function useParseState(): ParseState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** 读取当前快照（非 React 环境/事件里用） */
export function parseSnapshot(): ParseState {
  return state
}

export function setParseUrl(url: string): void {
  setState({ url })
}

export function resetParse(): void {
  setState({ url: '', result: null, error: null, parsing: false, startedAt: null, finishedAt: null })
}

/**
 * 发起解析。请求在仓库里跑，**切走页面也不会中断**；
 * 回来后如果还在跑，首页会继续显示"解析中"，完成后自动出结果。
 */
export async function startParse(target?: string): Promise<ParseResult | null> {
  const raw = (target ?? state.url).trim()
  const check = validateUrl(raw)
  if (!check.ok) {
    setState({ error: check.message, result: null, parsing: false })
    throw Object.assign(new Error(check.message), { code: 'INVALID_URL' })
  }

  setState({
    url: check.url,
    parsing: true,
    error: null,
    result: null,
    startedAt: Date.now(),
    finishedAt: null,
  })

  try {
    const data = await api.webvideoParse(check.url)
    // 只有"当前这次请求"的结果才写回去（期间用户又解析了别的地址就忽略旧结果）
    if (state.url === check.url && state.parsing) {
      setState({ result: data, parsing: false, error: null, finishedAt: Date.now() })
    }
    return data
  } catch (err) {
    const e = err as { code?: string; name?: string; message?: string }
    // 页面刷新/切换导致的请求中断：这不是"后端挂了"，别写进状态里吓人。
    // 地址保留着，用户再点一次「解析视频」即可（SPA 内切页不会中断，只有整页刷新才会）。
    const aborted =
      e.name === 'AbortError' ||
      /failed to fetch|load failed|networkerror|network error|aborted/i.test(String(e.message ?? ''))
    const message = aborted
      ? '解析被中断（页面刷新或网络中断），地址已保留，请再点一次「解析视频」'
      : humanizeError(e.code ?? '', String(e.message ?? ''))
    if (state.url === check.url) {
      setState({ error: message, result: null, parsing: false, finishedAt: Date.now() })
    }
    throw err
  }
}
