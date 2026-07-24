export const SDK_VERSION = '0.1.7'

const DEFAULT_REDACT_KEYS = ['password', 'token', 'secret', 'authorization', 'cookie']

export function eventSource(event) {
  if (event.source) return event.source
  if (event.type === 'track') return 'manual'
  if (event.type === 'behavior' || event.type === 'perf' || event.type === 'error' || event.type === 'replay' || event.type === 'log') return 'auto'
  return 'manual'
}

export function eventCategory(event) {
  if (event.type === 'error') return 'error'
  if (event.type === 'replay') return 'replay'
  if (event.type === 'behavior') return event.name === 'exposure' ? 'exposure' : 'behavior'
  if (event.type === 'perf') return ['fetch', 'xhr', 'websocket', 'sse'].includes(event.metric) ? 'requests' : 'performance'
  return undefined
}

export function sampleRateFor(category, rates = {}, fallback = 1) {
  const value = category && rates[category] != null ? Number(rates[category]) : Number(fallback)
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
}

export function redactObject(value, redactKeys = DEFAULT_REDACT_KEYS, depth = 0) {
  if (depth > 4 || value == null) return value
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactObject(item, redactKeys, depth + 1))
  if (typeof value !== 'object') return value
  const keys = new Set(redactKeys.map(key => String(key).toLowerCase()))
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, keys.has(key.toLowerCase()) ? '[REDACTED]' : redactObject(item, redactKeys, depth + 1)]))
}

export function sanitizeEvent(event, privacy = {}) {
  const redactKeys = [...DEFAULT_REDACT_KEYS, ...(privacy.redactKeys || [])]
  const result = { ...event }
  if (result.props) result.props = redactObject(result.props, redactKeys)
  if (result.context) result.context = redactObject(result.context, redactKeys)
  if (result.breadcrumbs) result.breadcrumbs = redactObject(result.breadcrumbs, redactKeys)
  if (typeof result.message === 'string') result.message = redactText(result.message, redactKeys)
  return result
}

function redactText(value, keys) {
  const pattern = keys.map(key => String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return pattern ? value.replace(new RegExp(`(${pattern})([=: ]+)[^,; ]+`, 'gi'), '$1$2[REDACTED]') : value
}
