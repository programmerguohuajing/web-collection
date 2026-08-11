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

export function behaviorDetailLabel(event = {}) {
  const props = event.props || {}
  if (event.type === 'track') return readableText(event.name)
  if (event.type !== 'behavior') return '-'

  if (event.name === 'click' || event.name === 'exposure') {
    return readableText(props.elementLabel, props.label, props.text, props.ariaLabel, props.alt, props.title, props.name, props.id)
  }
  if (event.name === 'page_leave') return props.stayTime == null ? '-' : `停留 ${formatDuration(props.stayTime)}`
  if (event.name === 'scroll') {
    const depth = formatPercent(props.depth)
    const maxDepth = formatPercent(props.maxDepth)
    return depth === '-' && maxDepth === '-' ? '-' : `当前 ${depth} · 最深 ${maxDepth}`
  }
  if (['route', 'replaceState', 'pushState', 'hashchange', 'popstate'].includes(event.name)) {
    return props.from || props.to ? `${props.from || '-'} → ${props.to || '-'}` : '-'
  }
  return '-'
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

export function formatSpanId(event = {}) {
  return firstPresent(event.spanId, event.span_id) || '-'
}

export function formatSpanStatus(event = {}) {
  const props = event.props && typeof event.props === 'object' ? event.props : {}
  const status = firstPresent(props.status, props.statusCode, props.status_code, event.status, event.statusCode, event.status_code)
  const numericStatus = Number(status)
  const failed = event.type === 'error'
    || props.failed === true
    || props.failed === 'true'
    || props.statusClass === 'network_error'
    || String(status).toUpperCase() === 'ERROR'
    || (Number.isFinite(numericStatus) && numericStatus >= 400)

  if (failed && (!status || numericStatus === 0)) return 'ERROR'
  return status == null ? 'OK' : String(status)
}

export function spanStatusType(event = {}) {
  const status = formatSpanStatus(event)
  const numericStatus = Number(status)
  if (status === 'ERROR' || status === 'FAILED' || (Number.isFinite(numericStatus) && numericStatus >= 400)) return 'danger'
  if (Number.isFinite(numericStatus) && numericStatus >= 300) return 'warning'
  if (status === 'UNSET' || status === '-') return 'info'
  return 'success'
}

function formatPercent(value) {
  const number = Number(value)
  return Number.isFinite(number) ? `${Math.round(number)}%` : '-'
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

function firstPresent(...values) {
  return values.find(value => value != null && value !== '')
}
