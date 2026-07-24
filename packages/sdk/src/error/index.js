/**
 * 初始化全局错误监控。
 *
 * 监听两类错误：
 * 1. `error` 事件（捕获阶段）——区分资源加载失败（img/script/link 等元素的 src/href 错误）
 *    和 JS 运行时错误，分别附带不同的上下文信息上报。
 * 2. `unhandledrejection` 事件——捕获未 catch 的 Promise 异常。
 *
 * @param {object} opts
 * @param {Function} opts.error - SDK 主实例的 error 方法，用于将错误事件推入上报队列
 * @param {number} [opts.clipSize=500] - 保留参数以兼容旧配置，不再采集原始 outerHTML
 */
export function setupErrorMonitor({ error, clipSize = 500 }) {
  const onError = event => {
    const target = event.target
    // 资源加载失败：target 上存在 src 或 href 属性时判定为资源错误
    if (target?.src || target?.href) {
      error(new Error(target.src || target.href), { name: 'ResourceError', tag: target.tagName, elementPath: safeElementPath(target) })
      return
    }
    // JS 运行时错误：附带文件名、行号、列号
    error(event.error || event.message, { source: event.filename, line: event.lineno, column: event.colno })
  }

  // 未处理的 Promise rejection
  const onUnhandledRejection = event => {
    error(event.reason || 'Unhandled rejection', { name: 'UnhandledRejection' })
  }
  addEventListener('error', onError, true)
  addEventListener('unhandledrejection', onUnhandledRejection)
  return () => {
    removeEventListener('error', onError, true)
    removeEventListener('unhandledrejection', onUnhandledRejection)
  }
}

function safeElementPath(element) {
  const tag = String(element?.tagName || '').toLowerCase()
  const id = element?.id ? `#${element.id}` : ''
  const classes = typeof element?.className === 'string' ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(name => `.${name}`).join('') : ''
  return `${tag}${id}${classes}`.slice(0, 240)
}
