/**
 * 回放资源内联器：把快照事件引用的页面静态资源（<img src>、样式 _cssText 中的
 * url(...)）在录制侧转成 data URI，使回放不再依赖被录站点的资源可连性。
 *
 * 动机（线上实测）：内网 / dev 环境（http://192.168.x.x）或带防盗链 / 需登录态的
 * 资源，在 HTTPS 控制台的回放 iframe 中必然加载失败（Mixed Content 被升级后不可达、
 * Referer 校验拒绝、站点下线），回放表现为图标缺失、商品图空白、字体退化。
 * 浏览器安全模型下回放端无法兜底，录制时同源 fetch 内联是唯一可靠手段。
 *
 * 安全护栏：
 * - 仅处理与当前页面同源的资源（跨域 fetch 也读不到 body，跳过）；
 * - 单资源大小上限 maxBytes（默认 1MB）、单会话累计预算 budget（默认 8MB），超限静默跳过；
 * - fetch 失败（404 / 网络错误 / 非 2xx）静默跳过，绝不影响回放事件流本身；
 * - URL → dataURI 的模块级缓存，同一资源整个会话只 fetch 一次。
 */

/** 从 CSS 文本中提取 url(...) 引用（跳过已是 data: 的）。 */
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g

/**
 * 递归访问 rrweb 序列化节点树（快照 data.node 与增量 data.adds[].node 同构）。
 * @param {object} node 序列化节点
 * @param {(node: object) => void} cb
 */
function visitNodes(node, cb) {
  if (!node || typeof node !== 'object') return
  cb(node)
  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) visitNodes(child, cb)
  }
}

/**
 * 收集一个事件中所有待内联的资源 URL（绝对化后）。
 * @param {object} event rrweb 事件
 * @param {string} baseHref 页面基准 URL（用于相对路径绝对化）
 * @returns {Map<string, Array<{holder: object, key: string}>>} url -> 待替换位置列表
 */
function collectEventAssets(event, baseHref) {
  const found = new Map()
  const add = (url, holder, key) => {
    let abs
    try { abs = new URL(url, baseHref).href } catch { return }
    if (!/^https?:/i.test(abs)) return
    if (!found.has(abs)) found.set(abs, [])
    // raw：资源在属性文本中的原始写法（可能是相对路径）——替换时按原文匹配，
    // 而解析/去重/fetch 用绝对 URL（同一资源的相对/绝对写法只 fetch 一次）。
    found.get(abs).push({ holder, key, raw: url })
  }
  const handleNode = node => {
    const attrs = node && node.attributes
    if (!attrs) return
    const src = attrs.src
    if (typeof src === 'string' && src && !src.startsWith('data:')) add(src, attrs, 'src')
    const cssText = attrs._cssText
    if (typeof cssText === 'string' && cssText && cssText.includes('url(')) {
      for (const m of cssText.matchAll(CSS_URL_RE)) {
        const u = m[2]
        if (u && !u.startsWith('data:')) add(u, attrs, '_cssText')
      }
    }
  }
  if (event?.type === 2 && event.data?.node) visitNodes(event.data.node, handleNode)
  if (event?.type === 3 && Array.isArray(event.data?.adds)) {
    for (const add0 of event.data.adds) {
      if (add0?.node) visitNodes(add0.node, handleNode)
    }
  }
  return found
}

/**
 * arrayBuffer -> base64（分块转换，避免大文件触发 call stack 限制）。
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** 按扩展名猜测 MIME（响应头缺失时的兜底）。 */
function guessMime(url) {
  const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase()
  const table = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject'
  }
  return table[ext] || 'application/octet-stream'
}

/**
 * 创建回放资源内联器。
 * @param {{maxBytes?: number, budget?: number, fetchImpl?: Function, now?: Function}} [opts]
 * @returns {{inline: (events: object[]) => Promise<object[]>, stats: () => object, reset: () => void}}
 */
export function createReplayAssetInliner({ maxBytes = 1048576, budget = 8388608, fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  const cache = new Map() // url -> dataURI | null（null = 已知失败，不再重试）
  let used = 0
  let inlined = 0, skipped = 0, failed = 0

  async function resolve(url, origin) {
    if (cache.has(url)) return cache.get(url)
    let result = null
    try {
      // 仅同源：跨域资源（CDN 公网资源通常回放时可直连）读取 body 受 CORS 限制，且
      // 内联它们会显著放大体积；保持原 URL 交由回放端按需加载。
      if (doFetch && new URL(url).origin === origin) {
        const res = await doFetch(url)
        if (res && res.ok) {
          const buf = await res.arrayBuffer()
          const mime = (res.headers && res.headers.get && res.headers.get('content-type')) || guessMime(url)
          const size = buf.byteLength || 0
          if (size > 0 && size <= maxBytes && used + size <= budget) {
            used += size
            result = `data:${mime.split(';')[0]};base64,${bufferToBase64(buf)}`
          } else if (size > 0) {
            skipped++
          }
        }
      }
    } catch { result = null }
    if (result) inlined++
    else failed++
    cache.set(url, result)
    return result
  }

  return {
    /** 对一批回放事件做就地内联（修改并返回原数组；无 fetch 环境时原样返回）。 */
    async inline(events) {
      if (!doFetch || !Array.isArray(events) || !events.length) return events
      const baseHref = typeof location !== 'undefined' ? location.href : ''
      const origin = typeof location !== 'undefined' ? location.origin : ''
      if (!baseHref || !origin) return events
      // 先收集本批全部引用，再并发解析（避免对同一 URL 重复 fetch）
      const jobs = []
      for (const event of events) {
        for (const [url, holders] of collectEventAssets(event, baseHref)) {
          jobs.push((async () => {
            const dataUri = await resolve(url, origin)
            if (!dataUri) return
            for (const { holder, key, raw } of holders) {
              if (key === 'src') holder.src = dataUri
              else if (key === '_cssText') {
                holder._cssText = holder._cssText.split(raw).join(dataUri)
              }
            }
          })())
        }
      }
      if (jobs.length) await Promise.all(jobs)
      return events
    },
    stats: () => ({ inlined, skipped, failed, bytesBudgetUsed: used }),
    reset: () => { cache.clear(); used = 0; inlined = 0; skipped = 0; failed = 0 }
  }
}
