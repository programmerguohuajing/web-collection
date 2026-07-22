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
