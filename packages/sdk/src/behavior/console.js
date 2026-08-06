/**
 * 初始化 Console 日志监控
 * 通过 monkey-patch console.log/info/warn/error 方法，拦截日志输出并记录为面包屑，
 * 同时保留原始 console 行为不变。只记录不单独上报，避免日志量和敏感信息失控。
 *
 * @param {object} opts
 * @param {Function} opts.remember  - 将日志记录到面包屑队列中的回调
 * @param {Function} [opts.emit]    - 可选的自定义日志输出通道（如第三方日志服务）
 * @param {string[]} [opts.levels=['log','info','warn','error']] - 需要拦截的 console 级别
 * @param {object} [opts.target=globalThis.console] - 目标 console 对象（跨平台兼容时使用）
 * @returns {Function} 恢复原始 console 的清理函数
 */
export function setupConsoleMonitor({ remember, emit, levels = ['log', 'info', 'warn', 'error'], target = globalThis.console }) {
  if (!target) return () => {}
  const originals = {}
  for (const level of levels) {
    const original = target[level]
    if (typeof original !== 'function') continue
    originals[level] = original
    // 替换目标方法：记录日志 → 可选 emit → 调用原方法保持行为不变
    target[level] = (...args) => {
      remember({
        type: 'console',
        name: level,
        message: args.map(format).join(' ').slice(0, 500),  // 截断 500 字符，防止日志过长
        ts: Date.now(),
        url: globalThis.location?.href || ''
      })
      emit?.(level, args.map(format).join(' ').slice(0, 500))
      return original.apply(target, args)
    }
  }
  // 返回清理函数：恢复所有被修改的 console 方法
  return () => Object.assign(target, originals)
}

/**
 * 将任意类型的值格式化为字符串
 * - Error 实例 → "Name: message"
 * - 普通对象 → JSON.stringify
 * - 不可序列化的对象 → "[Unserializable]"
 * @param {*} value
 * @returns {string}
 */
function format(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value !== 'object' || value === null) return String(value)
  try { return JSON.stringify(value) } catch { return '[Unserializable]' }
}
