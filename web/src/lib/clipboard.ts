/**
 * 复制文本到剪贴板。
 *
 * ⚠️ 必须带兜底：本项目的网页通常是用 **http://局域网IP:8080** 打开的，
 *    而 `navigator.clipboard` **只在安全上下文（https / localhost）下存在** ——
 *    在 http 局域网访问时它是 undefined，直接调用会抛错、按钮"点了没反应"。
 *    所以退化到 textarea + `document.execCommand('copy')`（老办法，但 http 下能用）。
 */
export async function copyText(text: string): Promise<void> {
  if (!text) throw new Error('没有可复制的内容')

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  // 放在视口外，避免复制时页面跳动（iOS 上还会自动缩放）
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  area.setSelectionRange(0, area.value.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } finally {
    document.body.removeChild(area)
  }
  if (!ok) throw new Error('当前浏览器不允许自动复制')
}
