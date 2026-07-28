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

function chunkKey(url) {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    const file = parts.pop() || ''
    // 提取 chunk 名：如 main.abc123.js -> main，vendors~xxx.js -> vendors
    const base = file.replace(/\.\w+\.\w+$/, '').replace(/\.[a-f0-9]{6,}/g, '').replace(/~\w+~/g, '~')
    return base || 'unknown'
  } catch {
    return 'unknown'
  }
}

function observe(type, handler) {
  try {
    new PerformanceObserver(list => list.getEntries().forEach(handler)).observe({ type, buffered: true })
  } catch {}
}
