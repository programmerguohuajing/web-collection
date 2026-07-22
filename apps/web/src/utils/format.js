export function formatDuration(value) {
  const milliseconds = Math.max(0, Number(value))
  if (!Number.isFinite(milliseconds)) return '-'
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60000) return `${Math.round(milliseconds / 100) / 10}s`
  const seconds = Math.floor(milliseconds / 1000)
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
}

export function readableText(...values) {
  return firstReadable(values) || '-'
}

export function formatErrorLocation(event = {}) {
  const { source, line, column } = event.props || {}
  if (source && line) return `${source}:${line}:${column || 0}`
  const match = [...String(event.stack || '').matchAll(/((?:https?:\/\/|\/)[^():\s]+):(\d+):(\d+)/g)]
    .find(item => !/web-collection-sdk(?:\.[\w-]+)?\.js/i.test(item[1]))
  return match ? `${match[1]}:${match[2]}:${match[3]}` : '-'
}

export function scoreWebVitals(perf = {}) {
  const checks = [['fcp', 1800, 3000, 10], ['lcp', 2500, 4000, 25], ['inp', 200, 500, 25], ['cls', 0.1, 0.25, 25], ['ttfb', 800, 1800, 15]]
  let score = 0
  let measured = 0
  for (const [name, good, poor, weight] of checks) {
    if (perf[name] == null) continue
    measured++
    score += perf[name] <= good ? weight : perf[name] <= poor ? weight / 2 : 0
  }
  return measured ? { score: Math.round(score), grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 50 ? 'C' : score >= 25 ? 'D' : 'F', measured } : null
}

function firstReadable(values) {
  for (const value of values) {
    if (value == null) continue
    if (typeof value === 'string') {
      const text = value.trim()
      if (text && text !== '[object Object]') return text
      continue
    }
    if (typeof value === 'object') {
      const nested = firstReadable([value.message, value.error, value.reason, value.detail, value.title, value.name].filter(item => item !== value))
      if (nested) return nested
      try { return JSON.stringify(value) } catch { continue }
    }
    return String(value)
  }
  return ''
}
