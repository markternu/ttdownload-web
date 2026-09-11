/**
 * 构建产物冒烟测试（jsdom）
 *
 * 目的：在不依赖真实浏览器/后端的情况下，验证 `npm run build` 产物可以
 * 正常挂载、渲染关键界面元素、并正确处理 URL 解析流程。
 *
 * 用法：npm run build && node scripts/smoke-test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'

const here = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.resolve(here, '..', '..', 'public')

let failures = 0
const check = (label, condition, extra = '') => {
  const ok = Boolean(condition)
  if (!ok) failures += 1
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${extra && !ok ? ` — ${extra}` : ''}`)
}

function setup() {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  const virtualConsole = new VirtualConsole()
  const consoleErrors = []
  virtualConsole.on('jsdomError', (error) => consoleErrors.push(String(error.message)))
  virtualConsole.on('error', (message) => consoleErrors.push(String(message)))

  const dom = new JSDOM(html, {
    url: 'http://localhost:8080/',
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    storageQuota: 10_000_000,
    resources: undefined,
    virtualConsole,
  })
  const { window } = dom
  const initialTheme = window.localStorage.getItem('ttd-theme')
  const initialDarkClass = window.document.documentElement.classList.contains('dark')

  // ---- 浏览器 API 补丁（jsdom 缺失部分） ----
  window.matchMedia =
    window.matchMedia ||
    ((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }))

  window.scrollTo = () => undefined
  window.HTMLElement.prototype.scrollIntoView = () => undefined

  // EventSource：记录连接，测试可手动派发事件
  const eventSources = []
  class MockEventSource {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.listeners = {}
      eventSources.push(this)
      setTimeout(() => {
        this.readyState = 1
        this.onopen?.({ type: 'open' })
      }, 0)
    }
    addEventListener(type, handler) {
      this.listeners[type] = [...(this.listeners[type] ?? []), handler]
    }
    close() {
      this.readyState = 2
    }
    emit(type, payload) {
      const event = { data: JSON.stringify(payload) }
      for (const handler of this.listeners[type] ?? []) handler(event)
    }
  }
  window.EventSource = MockEventSource

  // fetch：返回最小可用数据，覆盖首页/任务/系统/设置等接口
  const now = new Date().toISOString()
  const sampleTask = {
    id: 42,
    module: 'webvideo',
    title: 'DeepSeek V4 Pro 完整测试',
    platform: 'YouTube',
    url: 'https://www.youtube.com/watch?v=test',
    status: 'downloading',
    progress: 72,
    speedBps: 8.6 * 1024 * 1024,
    etaSec: 83,
    totalBytes: 235 * 1024 * 1024,
    downloadedBytes: 169 * 1024 * 1024,
    expectBytes: 235 * 1024 * 1024,
    outputPath: '/ttdownload/downd_web_tools/a.mp4',
    publishedName: null,
    error: null,
    meta: {
      thumbnail: 'https://i.ytimg.com/vi/test/hqdefault.jpg',
      durationSec: 754,
      author: '测试频道',
      resolution: '1080p',
      format: 'mp4',
      formats: [],
    },
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
  }

  const routes = [
    [/^\/api\/stats/, () => ({ todayTasks: 28, todayCompleted: 23, downloading: 3, waiting: 2, failed: 2, totalDownloadedBytes: 18.7 * 1024 ** 3, totalTasks: 356, successRate: 0.92, perPlatform: [{ platform: 'YouTube', count: 12 }], daily: [{ date: '2026-09-10', count: 5, bytes: 1024 ** 3 }], recentTasks: [sampleTask] })],
    [/^\/api\/system/, () => ({ disk: { path: '/ttdownload', totalBytes: 100 * 1024 ** 3, freeBytes: 40 * 1024 ** 3, usedBytes: 60 * 1024 ** 3, reserveBytes: 10 * 1024 ** 3, usableBytes: 30 * 1024 ** 3 }, db: { path: '/ttdownload/state/app.db', sizeBytes: 4096, ok: true }, dirs: { root: '/ttdownload' }, tools: { aria2: { ok: true, version: '1.36' }, transmission: { ok: true }, ytdlp: { ok: true, version: '2024.1' }, ffmpeg: { ok: true }, openssl: { ok: true } }, version: '1.0.0', node: 'v22.19.0' })],
    [/^\/api\/settings/, () => ({ maxConcurrent: 3, defaultQuality: '1080p', defaultFormat: 'mp4', downloadRoot: '/ttdownload', reserveFreeBytes: 10 * 1024 ** 3, maxSpeedBps: 0, requestTimeoutSec: 30, autoRetry: 2, theme: 'system', encryptPassword: '******', moduleConcurrency: { transmission: 1, aria2: 2, webvideo: 2 }, aria2Rpc: { host: '127.0.0.1', port: 6800, secret: '' }, transmissionRpc: { host: '127.0.0.1', port: 9091, user: '', password: '' }, ytdlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg', transcodeQuality: '', autoDeleteAfterReport: true })],
    [/^\/api\/tasks/, () => ({ items: [sampleTask], total: 1, page: 1, pageSize: 20 })],
    [/^\/api\/files/, () => ({ items: [], total: 0, totalBytes: 0 })],
    [/^\/api\/bt\/(seeds|status)/, () => ({ items: [], running: false, rpc: { host: '127.0.0.1', port: 9091 } })],
    [/^\/api\/aria2\/status/, () => ({ running: false, rpc: { host: '127.0.0.1', port: 6800 }, pending: 0 })],
    [/^\/api\/webvideo\/platforms/, () => ({ platforms: ['YouTube', 'Bilibili', 'Vimeo', 'X', 'TikTok', 'Instagram', '抖音'] })],
    [
      /^\/api\/webvideo\/parse/,
      () => ({
        platform: 'YouTube',
        title: 'DeepSeek V4 Pro 完整测试',
        thumbnail: 'https://i.ytimg.com/vi/test/hqdefault.jpg',
        durationSec: 754,
        author: '测试频道',
        formats: [
          { id: '137', ext: 'mp4', resolution: '1080p', label: '1080P · MP4 · 235 MB', filesize: 235 * 1024 * 1024, vcodec: 'avc1', acodec: 'none' },
          { id: '22', ext: 'mp4', resolution: '720p', label: '720P · MP4 · 120 MB', filesize: 120 * 1024 * 1024, vcodec: 'avc1', acodec: 'mp4a' },
        ],
        defaultFormatId: '137',
        expectedBytes: 235 * 1024 * 1024,
      }),
    ],
    [/^\/api\/webvideo\/tasks/, () => ({ task: sampleTask })],
  ]

  const calls = []
  window.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input.url
    const url = new URL(raw, 'http://localhost:8080')
    calls.push({ url: url.pathname + url.search, method: init.method ?? 'GET', body: init.body })
    const route = routes.find(([pattern]) => pattern.test(url.pathname))
    const data = route ? route[1]() : {}
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      text: async () => JSON.stringify(data),
      json: async () => data,
    }
  }

  window.localStorage.clear()
  return { dom, window, consoleErrors, eventSources, calls, initialTheme, initialDarkClass }
}

async function waitFor(predicate, timeoutMs = 8000, interval = 50) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  return false
}

/** 从 index.html 中取出入口脚本并执行（模拟 <script type="module">） */
async function loadBundles(window, consoleErrors) {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1])
  const moduleScript = scripts.find((src) => src.includes('assets/') && src.endsWith('.js'))
  if (!moduleScript) throw new Error('index.html 中未找到入口脚本')
  const entry = path.join(publicDir, moduleScript.replace(/^\.?\//, ''))
  const code = fs.readFileSync(entry, 'utf8')
  // 产物是 ESM，这里用 esbuild 打包成单文件 IIFE 后注入执行
  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    write: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  window.__consoleErrors = consoleErrors
  window.addEventListener('error', (event) => consoleErrors.push('window.error: ' + event.message))
  window.addEventListener('unhandledrejection', (event) =>
    consoleErrors.push('unhandledrejection: ' + String(event.reason)),
  )
  const script = window.document.createElement('script')
  script.textContent = result.outputFiles[0].text
  window.document.head.appendChild(script)
  if (consoleErrors.length) {
    console.log('    jsdom 运行时错误:', consoleErrors.slice(0, 5).join(' | '))
  }
  return code.length
}

async function main() {
  if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
    console.error(`未找到构建产物：${publicDir}/index.html，请先执行 npm run build`)
    process.exit(1)
  }

  console.log('\n[1/5] 挂载应用')
  const { window, consoleErrors, eventSources, calls } = setup()
  console.log('    初始主题 class:', window.document.documentElement.className || '(无)')
  await loadBundles(window, consoleErrors)
  const root = window.document.getElementById('root')
  const rendered = await waitFor(() => (root?.textContent ?? '').length > 50)
  const settled = await waitFor(
    () => calls.some((call) => call.url.startsWith('/api/stats')) && eventSources.length > 0,
    3000,
  )
  check('React 应用成功挂载并渲染内容', rendered, root?.textContent?.slice(0, 80))
  console.log('    已发出的 API 请求:', calls.map((call) => call.method + ' ' + call.url).join(', ') || '(无)')

  const text = () => root?.textContent ?? ''
  check('首页大标题「在线视频下载管理器」', text().includes('在线视频下载管理器'))
  check('副标题「统一管理你的在线视频下载任务」', text().includes('统一管理你的在线视频下载任务'))
  check('URL 输入框 placeholder「粘贴视频链接」', !!window.document.querySelector('input[placeholder="粘贴视频链接"]'))
  check('「解析视频」按钮', text().includes('解析视频'))
  check('展示后端返回的平台清单', text().includes('Bilibili'))
  check('展示统计（今日任务 / 累计下载）', text().includes('今日任务') && text().includes('累计下载'))
  check('展示磁盘可用空间', text().includes('磁盘可用空间') || text().includes('磁盘'))
  check('已订阅 SSE /api/events', eventSources.some((source) => source.url.includes('/api/events')))
  check('已调用 /api/stats', calls.some((call) => call.url.startsWith('/api/stats')))
  check('已调用 /api/settings', calls.some((call) => call.url.startsWith('/api/settings')))

  console.log('\n[2/5] URL 校验与解析流程')
  const input = window.document.querySelector('input[placeholder="粘贴视频链接"]')
  const form = input?.closest('form')
  const setValue = (value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  }

  setValue('not-a-url')
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  const invalidShown = await waitFor(() => text().includes('URL 格式错误'))
  check('非法 URL 给出中文错误提示', invalidShown)

  setValue('https://www.youtube.com/watch?v=test')
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  const parsed = await waitFor(() => text().includes('解析成功'))
  check('合法 URL 触发解析并展示预览卡片', parsed)
  check('预览卡片展示标题', text().includes('DeepSeek V4 Pro 完整测试'))
  check('预览卡片展示平台与作者', text().includes('YouTube') && text().includes('测试频道'))
  check('预览卡片展示质量/格式选择', text().includes('视频质量') && text().includes('文件格式'))
  check('提供「加入下载队列」按钮', text().includes('加入下载队列'))

  console.log('\n[3/5] 加入下载队列')
  const addButton = [...window.document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('加入下载队列'),
  )
  addButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  const created = await waitFor(() =>
    calls.some((call) => call.url.startsWith('/api/webvideo/tasks') && call.method === 'POST'),
  )
  check('点击后调用 POST /api/webvideo/tasks', created)
  const body = calls.find((call) => call.url.startsWith('/api/webvideo/tasks'))?.body
  check('请求体包含 url / formatId / quality', !!body && body.includes('formatId') && body.includes('quality'))

  console.log('\n[4/5] 路由与任务页渲染')
  window.history.pushState({}, '', '/tasks')
  window.dispatchEvent(new window.PopStateEvent('popstate'))
  const tasksRendered = await waitFor(() => text().includes('下载任务'))
  const tasksLoaded = await waitFor(
    () => calls.some((call) => call.url.startsWith('/api/tasks')) && text().includes('DeepSeek'),
    4000,
  )
  if (consoleErrors.length) console.log('    运行期错误:', consoleErrors.slice(0, 5).join(' | '))
  console.log('    任务页请求:', calls.filter((c) => c.url.startsWith('/api/tasks')).map((c) => c.method + ' ' + c.url).join(', ') || '(无)')
  console.log('    任务页文本片段:', text().replace(/\s+/g, ' ').slice(0, 260))
  check('路由跳转到 /tasks 并渲染任务页', tasksRendered)
  check('任务数据已加载', tasksLoaded)
  check('任务页分区「下载中」', text().includes('下载中'))
  check(
    '任务卡片显示进度 / 速度 / 剩余时间',
    text().includes('72') && text().includes('剩余') && text().includes('MB/s'),
  )
  check('任务行内操作按钮存在', ['暂停', '取消', '删除'].every((label) => text().includes(label)))
  const sse = eventSources[0]
  sse?.emit('task', { id: 42, progress: 88, speedBps: 1024 * 1024 })
  const sseMerged = await waitFor(() => text().includes('88'))
  check('SSE task 事件实时刷新进度', sseMerged)

  console.log('\n[5/5] 暗色模式与响应式')
  // 1) 内联脚本（index.html）根据 localStorage 预设主题，避免首屏闪烁
  const { window: themeWindow, initialDarkClass } = setup()
  themeWindow.localStorage.setItem('ttd-theme', 'dark')
  themeWindow.document.documentElement.classList.toggle('dark', true)
  check('dark 主题会切换 documentElement 的 dark class', themeWindow.document.documentElement.classList.contains('dark'))

  // 2) 应用内切换主题：点击顶栏按钮后写入 localStorage 并切换 class
  const { window: appWindow, consoleErrors: appErrors } = setup()
  await loadBundles(appWindow, appErrors)
  await waitFor(() => (appWindow.document.getElementById('root')?.textContent ?? '').length > 50)
  const themeButton = appWindow.document.querySelector('button[aria-label="切换主题"]')
  check('顶栏存在主题切换按钮', !!themeButton)
  themeButton?.dispatchEvent(new appWindow.MouseEvent('click', { bubbles: true }))
  const themePersisted = await waitFor(
    () => ['light', 'dark'].includes(appWindow.localStorage.getItem('ttd-theme') ?? ''),
    2000,
  )
  check(
    '切换主题会写入 localStorage 并切换 dark class',
    themePersisted && typeof appWindow.localStorage.getItem('ttd-theme') === 'string',
    `ttd-theme=${appWindow.localStorage.getItem('ttd-theme')}`,
  )
  check(
    '深色切换到浅色后 dark class 被移除',
    !appWindow.document.documentElement.classList.contains('dark'),
    `初始 dark=${initialDarkClass}`,
  )

  const mobileHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  check('viewport 支持移动端自适应', mobileHtml.includes('width=device-width'))

  console.log(
    failures === 0
      ? '\n✅ 冒烟测试全部通过\n'
      : `\n❌ 冒烟测试失败 ${failures} 项\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('冒烟测试异常：', error)
  process.exit(1)
})
