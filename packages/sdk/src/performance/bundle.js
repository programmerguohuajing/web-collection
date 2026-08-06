/**
 * Bundle 大小监控模块。
 *
 * 按 initiatorType 聚合 JS/CSS 资源，在页面卸载时上报 Bundle 级别摘要。
 * 默认不开启，通过 bundleMonitoring: true 启用。
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 主实例的 metric 方法
 */
export function setupBundleMonitor({ metric }) {
  const jsBytes = new Map()  // origin-ish -> bytes
  const cssBytes = new Map()
  let jsCount = 0
  let cssCount = 0

  observe('resource', e => {
    if (e.initiatorType === 'script') {
      jsCount++
      jsBytes.set(e.name, (jsBytes.get(e.name) || 0) + (e.decodedBodySize || 0))
    } else if (e.initiatorType === 'link') {
      cssCount++
      cssBytes.set(e.name, (cssBytes.get(e.name) || 0) + (e.decodedBodySize || 0))
    }
  })

  return () => {
    const jsTotal = [...jsBytes.values()].reduce((a, b) => a + b, 0)
    const cssTotal = [...cssBytes.values()].reduce((a, b) => a + b, 0)
    metric('bundle_summary', 0, {
      jsTotalBytes: jsTotal,
      cssTotalBytes: cssTotal,
      jsCount,
      cssCount,
      chunks: buildChunks(jsBytes, cssBytes)
    })
  }
}

/**
 * 根据 JS/CSS 字节统计构建 chunk 列表
 * 对 URL 提取 chunk 名去重，同一 chunk 只保留一条记录，最多返回 50 个
 * @param {Map<string, number>} jsBytes  - URL → JS 字节数
 * @param {Map<string, number>} cssBytes - URL → CSS 字节数
 * @returns {Array<{name: string, size: number, type: string}>} chunk 列表
 */
function buildChunks(jsBytes, cssBytes) {
  const chunks = []
  const seen = new Set()
  for (const [name, size] of jsBytes) {
    const key = chunkKey(name)
    if (!seen.has(key)) {
      seen.add(key)
      chunks.push({ name: key, size, type: 'js' })
    }
  }
  for (const [name, size] of cssBytes) {
    const key = chunkKey(name)
    if (!seen.has(key)) {
      seen.add(key)
      chunks.push({ name: key, size, type: 'css' })
    }
  }
  return chunks.slice(0, 50)
}

/**
 * 从资源 URL 提取可读的 chunk 名称
 * 例如：
 *   /assets/main.a1b2c3.js       → main
 *   /js/vendors~chunk.d4e5f6.js  → vendors~chunk
 *   blob:...                      → unknown
 * @param {string} url - 资源完整 URL
 * @returns {string} 提取的 chunk 名
 */
function chunkKey(url) {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    const file = parts.pop() || ''
    // 依次去除：多级扩展名(.min.js)、hash值(6位以上)、分割符中的 hash
    const base = file.replace(/\.\w+\.\w+$/, '').replace(/\.[a-f0-9]{6,}/g, '').replace(/~\w+~/g, '~')
    return base || 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 安全的 PerformanceObserver 工厂
 * 使用 buffered: true 可捕获创建前已产生的条目，try-catch 防止不支持的类型报错
 * @param {string} type    - PerformanceEntry 类型
 * @param {Function} handler - 单条性能条目的回调
 */
function observe(type, handler) {
  try {
    new PerformanceObserver(list => list.getEntries().forEach(handler)).observe({ type, buffered: true })
  } catch {}
}
