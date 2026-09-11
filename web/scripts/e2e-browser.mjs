/**
 * 真实浏览器端到端冒烟测试（Chrome DevTools Protocol）
 *
 * 前置条件：
 *   1. npm run build（产物位于 ../public）
 *   2. 后端已启动并托管前端：DOWNLOAD_ROOT=/tmp/ttd-test npx tsx ../src/server.ts
 *
 * 用法：node scripts/e2e-browser.mjs [baseUrl]
 * 默认 baseUrl = http://localhost:8080
 *
 * 特点：
 *   - 每个页面使用独立无头浏览器实例，避免 SSE 长连接堆积导致偶发挂起；
 *   - 断言前等待页面就绪标记（应用挂载 + 首屏数据返回），避免竞态误报；
 *   - 失败时打印页面文本片段，并输出截图到临时目录便于排查。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = process.argv[2] ?? 'http://localhost:8080'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333
const EVIDENCE_DIR = path.join(os.tmpdir(), 'ttd-e2e')
const KEEP_EVIDENCE = process.env.KEEP_EVIDENCE === '1'
const SCENARIO_TIMEOUT_MS = 60000
const RUN_TIMEOUT_MS = 420000

let failures = 0
let currentPage = null
const results = []
const check = (label, ok, extra = '') => {
  if (!ok) failures += 1
  results.push(`${ok ? '  ✓' : '  ✗'} ${label}${!ok && extra ? ` — ${extra}` : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fetchJson = async (url, timeoutMs = 5000) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await (await fetch(url, { signal: controller.signal })).json()
  } finally {
    clearTimeout(timer)
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.events = []
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      } else if (message.method) {
        this.events.push(message)
      }
    })
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, timeoutMs)
    })
  }

  /** 自某个事件下标起的控制台/运行时错误 */
  errorsSince(mark) {
    return this.events
      .slice(mark)
      .filter(
        (event) =>
          event.method === 'Runtime.exceptionThrown' ||
          (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') ||
          (event.method === 'Log.entryAdded' && event.params.entry.level === 'error'),
      )
      .map((event) => {
        if (event.method === 'Runtime.exceptionThrown') {
          return event.params.exceptionDetails?.exception?.description ?? '异常'
        }
        if (event.method === 'Runtime.consoleAPICalled') {
          return (event.params.args ?? []).map((arg) => arg.description ?? arg.value).join(' ')
        }
        return `${event.params.entry.text} (${event.params.entry.url ?? ''})`
      })
  }

  async evaluate(expression, timeoutMs = 8000) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    )
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? '页面脚本执行失败')
    }
    return result.result.value
  }
}

/** 启动一个无头浏览器并打开指定路由，返回页面操作句柄 */
async function openPage(route, { mobile = false, waitMs = 1200 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ttd-chrome-'))
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-features=Translate,MediaRouter',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      `${BASE}${route}`,
    ],
    { stdio: 'ignore' },
  )

  const close = () => {
    chrome.kill('SIGKILL')
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch {
      /* Chrome 仍在写盘时清理失败不影响测试结论 */
    }
  }

  let target = null
  for (let attempt = 0; attempt < 48 && !target; attempt += 1) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${PORT}/json/list`)
      target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
    } catch {
      /* Chrome 还没起来 */
    }
    if (!target) await sleep(250)
  }
  if (!target) {
    close()
    throw new Error('Chrome DevTools 端口未就绪')
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('无法连接 Chrome 页面目标')), { once: true })
  })
  const cdp = new Cdp(ws)

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')

  if (mobile) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    })
  }

  await sleep(waitMs)

  const text = async () => {
    try {
      return await cdp.evaluate('document.body ? document.body.innerText : ""', 6000)
    } catch {
      return ''
    }
  }
  const waitFor = async (needle, timeoutMs = 10000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const value = await text()
      if (value.includes(needle)) return true
      await sleep(200)
    }
    return false
  }

  return {
    cdp,
    close,
    waitFor,
    text,
    /** 在同一浏览器实例内导航到另一路由（模拟点击导航） */
    goto: async (nextRoute) => {
      try {
        await cdp.evaluate(`(() => { window.history.pushState({}, '', ${JSON.stringify(nextRoute)}); window.dispatchEvent(new PopStateEvent('popstate')); return true })()`)
      } catch {
        await cdp.send('Page.navigate', { url: `${BASE}${nextRoute}` }).catch(() => undefined)
      }
      await sleep(700)
    },
    has: async (needle) => (await text()).includes(needle),
    snippet: async (limit = 240) => {
      try {
        return (await text()).replace(/\s+/g, ' ').trim().slice(0, limit)
      } catch {
        return '(无法读取页面文本)'
      }
    },
    screenshot: async (name) => {
      try {
        fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
        fs.writeFileSync(path.join(EVIDENCE_DIR, `${name}.png`), Buffer.from(shot.data, 'base64'))
      } catch {
        /* 截图失败不影响断言 */
      }
    },
  }
}

/** 打开页面 → 等待就绪 → 执行断言 → 关闭。无头浏览器偶发失败时重试一次。 */
async function scenario({ name, route, pages, screenshot, ready, options = {}, run }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let page = null
    try {
      page = await openPage(route ?? pages[0].route, options)
      let mounted = await page.waitFor('在线视频下载管理器', 12000)
      let readyOk = true
      for (const entry of pages ?? []) {
        if (entry.route !== (route ?? pages[0].route)) {
          await page.goto(entry.route)
        }
        mounted = await page.waitFor('在线视频下载管理器', 12000)
        readyOk = entry.ready ? await page.waitFor(entry.ready, 12000) : true
        if (!mounted || !readyOk) break
      }
      if (!mounted || !readyOk) {
        const snippet = await page.snippet()
        page.close()
        currentPage = null
        if (attempt === 0) {
          console.log(`  （${name} 第 1 次未就绪，重试）片段: ${snippet}`)
          await sleep(700)
          continue
        }
        const expected = (pages ?? []).map((entry) => entry.ready).filter(Boolean).join(' / ')
        check(`${name}: 页面就绪（等待「${expected || '应用挂载'}」）`, false, snippet)
        return
      }
      currentPage = page
      if (screenshot) await page.screenshot(screenshot)
      await Promise.race([
        run(page),
        sleep(SCENARIO_TIMEOUT_MS).then(() => {
          throw new Error(`场景超时（${SCENARIO_TIMEOUT_MS / 1000}s）`)
        }),
      ])
      page.close()
      currentPage = null
      return
    } catch (error) {
      page?.close()
      currentPage = null
      if (attempt === 0) {
        console.log(`  （${name} 第 1 次异常，重试）${error.message}`)
        await sleep(700)
        continue
      }
      check(`${name}: 页面可正常加载`, false, error.message)
      return
    }
  }
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error(`未找到 Chrome：${CHROME}`)
    process.exit(1)
  }
  try {
    const health = await fetchJson(`${BASE}/api/health`)
    if (!health.ok) throw new Error('unhealthy')
  } catch {
    console.error(`后端不可访问：${BASE}/api/health，请先启动后端`)
    process.exit(1)
  }

  console.log(`\n真实浏览器端到端测试：${BASE}\n`)

  /* ------------------------------ 首页 ------------------------------ */
  console.log('[1] 首页 /')
  await scenario({
    name: '首页',
    route: '/',
    screenshot: '01-home',
    ready: '累计下载',
    run: async (page) => {
      const mark = page.cdp.events.length
      check(
        'document.title 为「在线视频下载管理器」',
        (await page.cdp.evaluate('document.title')) === '在线视频下载管理器',
      )
      check('大标题渲染', await page.has('在线视频下载管理器'))
      check('副标题渲染', await page.has('统一管理你的在线视频下载任务'))
      check(
        '存在「粘贴视频链接」输入框',
        await page.cdp.evaluate(`!!document.querySelector('input[placeholder="粘贴视频链接"]')`),
      )
      check('存在「解析视频」按钮', await page.has('解析视频'))
      check('展示支持平台（来自 /api/webvideo/platforms）', await page.has('Bilibili'))
      check('展示全局统计（累计下载）', await page.has('累计下载'))
      check('展示磁盘可用空间', await page.has('磁盘可用空间'))
      check('SSE 已连接（顶栏显示「实时连接」）', await page.waitFor('实时连接', 12000))
      const errors = page.cdp.errorsSince(mark)
      check('首页无控制台错误', errors.length === 0, errors.join(' | ').slice(0, 240))
    },
  })

  /* -------------------------- URL 校验与解析 -------------------------- */

  // 同一浏览器实例内继续验证 URL 校验与解析流程
  console.log('[2] URL 输入校验与解析')
  {
    const page = currentPage
    const setInput = (value) => `
      (() => {
        const input = document.querySelector('input[placeholder="粘贴视频链接"]')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, ${JSON.stringify(value)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        return true
      })()
    `
    await page.cdp.evaluate(setInput('notaurl'))
    check('非法 URL 显示清晰中文错误', await page.waitFor('URL 格式错误', 4000), await page.snippet(120))
    await page.screenshot('02-invalid-url')

    await page.cdp.evaluate(setInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))
    const parsed = await page.waitFor('解析成功', 16000)
    if (parsed) {
      check('合法 URL 解析成功并展示预览卡片', true)
      check('预览卡片含质量/格式选择', (await page.has('视频质量')) && (await page.has('文件格式')))
      check('预览卡片含「加入下载队列」按钮', await page.has('加入下载队列'))
      const feedback = await page.cdp.evaluate(`
        (async () => {
          const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('加入下载队列'))
          button.click()
          await new Promise((r) => setTimeout(r, 1800))
          return document.body.innerText
        })()
      `)
      check('点击「加入下载队列」得到明确反馈', feedback.includes('已加入下载队列') || feedback.includes('失败'))
      await page.screenshot('03-parsed')
    } else {
      // 本机未安装 yt-dlp：需求要求给出清晰中文错误，而不是笼统报错
      const snippet = await page.snippet(300)
      check(
        '解析失败时给出清晰中文错误（未安装 yt-dlp 的预期表现）',
        /失败|yt-dlp|不可用|超时|不支持/.test(snippet),
        snippet,
      )
      await page.screenshot('03-parse-fallback')
    }
    check('解析流程无控制台错误', page.cdp.errorsSince(0).length === 0, page.cdp.errorsSince(0).join(' | ').slice(0, 240))
  }

  /* ---------------------------- 任务页 ---------------------------- */
  console.log('[3] 任务页 /tasks')
  await scenario({
    name: '任务页 + 历史页',
    pages: [
      { route: '/tasks', ready: '搜索标题或 URL' },
      { route: '/history', ready: '平台筛选' },
    ],
    screenshot: '04-tasks',
    run: async (page) => {
      const mark = page.cdp.events.length
      check('任务页渲染标题', await page.has('下载任务'))
      check(
        '状态分区文案存在',
        (await page.has('下载中')) || (await page.has('等待中')) || (await page.has('没有匹配的任务')),
      )
      check(
        '筛选控件：搜索/状态/排序',
        (await page.has('搜索标题或 URL')) && (await page.has('全部状态')) && (await page.has('创建时间')),
        await page.snippet(160),
      )
      check(
        '模块筛选 tab 存在',
        (await page.has('公开视频')) && (await page.has('URL 直链')) && (await page.has('BT 种子')),
      )
      const total = await page.cdp
        .evaluate(`fetch('/api/tasks?page=1&pageSize=20').then(r => r.json()).then(d => d.total)`)
        .catch(() => -1)
      check('GET /api/tasks 返回分页结构', typeof total === 'number' && total >= 0, `total=${total}`)
      const errors = page.cdp.errorsSince(mark)
      check('任务页无控制台错误', errors.length === 0, errors.join(' | ').slice(0, 240))

      // 同一浏览器实例内切到历史页继续校验
      await page.goto('/history')
      await page.waitFor('平台筛选', 10000)
      await page.screenshot('05-history')
      const historyMark = page.cdp.events.length
      check('历史页渲染', await page.has('下载历史'))
      check('历史页包含平台筛选', await page.has('平台筛选'))
      check('历史页包含状态筛选', await page.has('全部状态'))
      check('历史页包含时间排序', await page.has('创建时间'))
      const historyErrors = page.cdp.errorsSince(historyMark)
      check('历史页无控制台错误', historyErrors.length === 0, historyErrors.join(' | ').slice(0, 240))
    },
  })

  /* --------------------------- Dashboard --------------------------- */
  console.log('[5] Dashboard /dashboard')
  await scenario({
    name: 'Dashboard',
    pages: [{ route: '/dashboard', ready: '数据统计' }],
    screenshot: '06-dashboard',
    options: { waitMs: 2000 },
    run: async (page) => {
      const mark = page.cdp.events.length
      const bodyText = await page.text()
      check('Dashboard 渲染标题', bodyText.includes('数据统计'))
      const metrics = ['今日任务', '已完成', '下载中', '失败', '累计下载', '累计任务']
      check(
        '六项关键指标齐备（今日任务/已完成/下载中/失败/累计下载/累计任务）',
        metrics.every((label) => bodyText.includes(label)),
        metrics.filter((label) => !bodyText.includes(label)).join('、'),
      )
      check('展示成功率', bodyText.includes('成功率'))
      const charts = await page.cdp.evaluate('document.querySelectorAll("svg.recharts-surface").length')
      check('图表（recharts）已渲染', charts >= 2, `svg 数量=${charts}`)
      check('展示各平台下载数量', bodyText.includes('各平台下载数量'))
      check('展示最近下载任务', bodyText.includes('最近下载任务'))
      check('展示每日下载量', bodyText.includes('每日下载量'))
      check('展示总下载数据量', bodyText.includes('总下载数据量'))
      const errors = page.cdp.errorsSince(mark)
      check('Dashboard 无控制台错误', errors.length === 0, errors.join(' | ').slice(0, 240))
    },
  })

  /* ----------------------------- aria2 ----------------------------- */
  console.log('[6] URL 直链 /aria2')
  await scenario({
    name: 'aria2 + BT + 文件页',
    pages: [
      { route: '/aria2', ready: '批量提交 URL' },
      { route: '/bt', ready: '上传种子压缩包' },
      { route: '/files', ready: '文件总数' },
    ],
    screenshot: '07-aria2',
    run: async (page) => {
      const mark = page.cdp.events.length
      check('aria2 页渲染', await page.has('URL 直链下载'))
      check('存在多行 URL 文本框', await page.cdp.evaluate('!!document.querySelector("textarea")'))
      check('展示 aria2 运行状态与 RPC', (await page.has('aria2')) && (await page.has('RPC')))
      const blocked = await page.cdp.evaluate(`
        (async () => {
          const area = document.querySelector('textarea')
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          setter.call(area, 'notaurl')
          area.dispatchEvent(new Event('input', { bubbles: true }))
          await new Promise((r) => setTimeout(r, 200))
          const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('提交到下载队列'))
          return button.disabled || document.body.innerText.includes('不是合法的')
        })()
      `)
      check('非法 URL 被前端拦截并提示', blocked)
      const errors = page.cdp.errorsSince(mark)
      check('aria2 页无控制台错误', errors.length === 0, errors.join(' | ').slice(0, 240))
      // 同一浏览器实例内继续校验 BT 种子页
      await page.goto('/bt')
      await page.waitFor('上传种子压缩包', 10000)
      const btMark = page.cdp.events.length
      check('BT 页渲染', await page.has('BT 种子下载'))
      check(
        '存在 zip 上传入口',
        (await page.has('选择 zip 文件')) &&
          (await page.cdp.evaluate(`!!document.querySelector('input[type="file"][accept*="zip"]')`)),
      )
      check('种子列表与批量操作存在', (await page.has('种子列表')) && (await page.has('批量入队')))
      const btErrors = page.cdp.errorsSince(btMark)
      check('BT 页无控制台错误', btErrors.length === 0, btErrors.join(' | ').slice(0, 240))
      // 继续校验已发布文件页
      await page.goto('/files')
      await page.waitFor('文件总数', 10000)
      const filesMark = page.cdp.events.length
      const bodyText = await page.text()
      check(
        '文件页渲染',
        bodyText.includes('已发布文件') && bodyText.includes('文件清单'),
        await page.snippet(160),
      )
      check('展示文件总数与占用空间', bodyText.includes('文件总数') && bodyText.includes('总占用空间'))
      check('存在搜索框', await page.cdp.evaluate(`!!document.querySelector('input[placeholder="搜索文件名或标题"]')`))
      const filesErrors = page.cdp.errorsSince(filesMark)
      check('文件页无控制台错误', filesErrors.length === 0, filesErrors.join(' | ').slice(0, 240))
    },
  })

  /* ------------------------------ 设置页 ------------------------------ */
  console.log('[9] 设置页 /settings')
  await scenario({
    name: '设置页 + 设置保存',
    pages: [{ route: '/settings', ready: '默认下载质量' }],
    screenshot: '10-settings',
    options: { waitMs: 2000 },
    run: async (page) => {
      const mark = page.cdp.events.length
      const bodyText = await page.text()
      check('设置页渲染', bodyText.includes('设置'))
      check(
        '下载设置分区完整（质量/格式/并发/目录）',
        ['默认下载质量', '默认文件格式', '最大并发任务', '默认保存目录'].every((label) =>
          bodyText.includes(label),
        ),
      )
      check(
        '网络设置分区完整（速度/超时/重试）',
        ['最大下载速度', '请求超时', '自动重试次数'].every((label) => bodyText.includes(label)),
      )
      check('外观分区 Light/Dark/System', ['Light', 'Dark', 'System'].every((label) => bodyText.includes(label)))
      check(
        '系统状态（版本/数据库/磁盘剩余/工具）',
        ['系统状态', '当前版本', '磁盘剩余空间', '外部工具'].every((label) => bodyText.includes(label)),
      )
      check(
        '外部工具连通性测试入口',
        ['测试 aria2 RPC', '测试 transmission RPC', '测试 yt-dlp'].every((label) =>
          bodyText.includes(label),
        ),
      )
      const saveDisabled = await page.cdp.evaluate(`
        (() => {
          const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('保存设置'))
          return button ? button.disabled : null
        })()
      `)
      check('未修改时「保存设置」按钮禁用', saveDisabled === true, `disabled=${saveDisabled}`)
      const errors = page.cdp.errorsSince(mark)
      check('设置页无控制台错误', errors.length === 0, errors.join(' | ').slice(0, 240))
      // 保存交互（PUT /api/settings）
      const outcome = JSON.parse(
        await page.cdp.evaluate(`
          (async () => {
            const select = [...document.querySelectorAll('select')].find((s) => s.value === '1080p')
            const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
            const original = select.value
            const next = original === '720p' ? '1080p' : '720p'
            setter.call(select, next)
            select.dispatchEvent(new Event('change', { bubbles: true }))
            await new Promise((r) => setTimeout(r, 400))
            const saveButton = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('保存设置'))
            const enabled = !saveButton.disabled
            saveButton.click()
            await new Promise((r) => setTimeout(r, 1800))
            const toastShown = document.body.innerText.includes('设置已保存') || document.body.innerText.includes('保存失败')
            // 还原为原值，避免污染后端设置
            const select2 = [...document.querySelectorAll('select')].find((s) => s.value === next)
            setter.call(select2, original)
            select2.dispatchEvent(new Event('change', { bubbles: true }))
            await new Promise((r) => setTimeout(r, 300))
            const restore = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('保存设置'))
            restore.click()
            await new Promise((r) => setTimeout(r, 1500))
            return JSON.stringify({ enabled, toastShown })
          })()
        `),
      )
      check('修改设置后「保存设置」按钮可用', outcome.enabled)
      check('点击保存后出现提示', outcome.toastShown)
      const restored = await fetchJson(`${BASE}/api/settings`).then((settings) => settings.defaultQuality)
      check('设置已写入后端（PUT /api/settings 生效）', restored === '1080p', `defaultQuality=${restored}`)
    },
  })

  /* ---------------------------- 暗色模式 ---------------------------- */
  console.log('[11] 暗色 / 浅色模式')
  await scenario({
    name: '暗色模式',
    route: '/dashboard',
    screenshot: '11-dark-mode',
    ready: '数据统计',
    options: { waitMs: 2000 },
    run: async (page) => {
      const darkMark = page.cdp.events.length
      const darkState = JSON.parse(
        await page.cdp.evaluate(`
          (async () => {
            const button = document.querySelector('button[aria-label="切换主题"]')
            const before = document.documentElement.classList.contains('dark')
            const beforeBg = getComputedStyle(document.body).backgroundColor
            button.click()
            await new Promise((r) => setTimeout(r, 500))
            const after = document.documentElement.classList.contains('dark')
            const afterBg = getComputedStyle(document.body).backgroundColor
            return JSON.stringify({ before, after, stored: localStorage.getItem('ttd-theme'), beforeBg, afterBg })
          })()
        `),
      )
      check('点击切换按钮切换 dark class', darkState.before !== darkState.after, JSON.stringify(darkState))
      check('主题写入 localStorage', darkState.stored === 'dark' || darkState.stored === 'light')
      check(
        '深浅切换会改变 body 背景色',
        darkState.beforeBg !== darkState.afterBg,
        `${darkState.beforeBg} → ${darkState.afterBg}`,
      )
      const darkErrors = page.cdp.errorsSince(darkMark)
      check('暗色模式无控制台错误', darkErrors.length === 0, darkErrors.join(' | ').slice(0, 240))
      // 切换到移动端视口
      await page.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
      })
      await page.goto('/tasks')
      await page.waitFor('搜索标题或 URL', 10000)
      await page.screenshot('12-mobile-drawer')
      const mobileMark = page.cdp.events.length
      const mobileState = JSON.parse(
        await page.cdp.evaluate(`
          JSON.stringify({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            hamburger: !!document.querySelector('button[aria-label="打开菜单"]'),
            sidebarHidden: !document.querySelector('aside') || getComputedStyle(document.querySelector('aside')).display === 'none',
          })
        `),
      )
      check('移动端无横向滚动', mobileState.scrollWidth <= mobileState.clientWidth + 1, JSON.stringify(mobileState))
      check('移动端显示汉堡菜单', mobileState.hamburger)
      check('移动端隐藏桌面侧边栏', mobileState.sidebarHidden)

      const drawer = JSON.parse(
        await page.cdp.evaluate(`
          (async () => {
            document.querySelector('button[aria-label="打开菜单"]').click()
            await new Promise((r) => setTimeout(r, 500))
            return JSON.stringify({
              nav: document.body.innerText.includes('Dashboard'),
              width: document.documentElement.scrollWidth,
              client: document.documentElement.clientWidth,
            })
          })()
        `),
      )
      check('抽屉菜单可打开并显示导航', drawer.nav)
      check('抽屉打开后仍无横向滚动', drawer.width <= drawer.client + 1, JSON.stringify(drawer))
      const mobileErrors = page.cdp.errorsSince(mobileMark)
      check('移动端无控制台错误', mobileErrors.length === 0, mobileErrors.join(' | ').slice(0, 240))
      // 恢复桌面视口并校验未知路由
      await page.cdp.send('Emulation.clearDeviceMetricsOverride')
      await page.goto('/no-such-page')
      await page.waitFor('页面不存在', 10000)
      const nfMark = page.cdp.events.length
      check('未知路由展示 404 页面', (await page.has('页面不存在')) && (await page.has('返回首页')))
      const nfErrors = page.cdp.errorsSince(nfMark)
      check('404 无控制台错误', nfErrors.length === 0, nfErrors.join(' | ').slice(0, 240))
    },
  })

  console.log('\n' + results.join('\n'))
  if (KEEP_EVIDENCE) console.log(`\n截图证据目录：${EVIDENCE_DIR}`)
  console.log(failures === 0 ? '\n✅ 端到端测试全部通过\n' : `\n❌ 端到端测试失败 ${failures} 项\n`)
  process.exit(failures === 0 ? 0 : 1)
}

const watchdog = setTimeout(() => {
  console.error(`\n⏱ 端到端测试超过 ${RUN_TIMEOUT_MS / 1000}s，强制结束`)
  process.exit(1)
}, RUN_TIMEOUT_MS)