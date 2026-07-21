/** 将 warn/error 记录为错误上下文，不单独上报，避免日志量和敏感信息失控。 */
export function setupConsoleMonitor({ remember, emit, levels = ['log', 'info', 'warn', 'error'], target = globalThis.console }) {
  if (!target) return () => {}
  const originals = {}
  for (const level of levels) {
    const original = target[level]
    if (typeof original !== 'function') continue
    originals[level] = original
    target[level] = (...args) => {
      remember({
        type: 'console',
        name: level,
        message: args.map(format).join(' ').slice(0, 500),
        ts: Date.now(),
        url: globalThis.location?.href || ''
      })
      emit?.(level, args.map(format).join(' ').slice(0, 500))
      return original.apply(target, args)
    }
  }
  return () => Object.assign(target, originals)
}

function format(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value !== 'object' || value === null) return String(value)
  try { return JSON.stringify(value) } catch { return '[Unserializable]' }
}
