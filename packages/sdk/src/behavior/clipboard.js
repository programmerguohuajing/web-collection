/**
 * 剪贴板操作监控模块（MDN: Clipboard API）。
 *
 * 包裹 navigator.clipboard.readText / writeText，仅记录操作类型与长度等元数据，
 * **绝不记录剪贴板内容**（隐私红线）。用于了解复制/粘贴交互分布。
 *
 * 上报为 `clipboard_read` / `clipboard_write` 行为事件。
 *
 * @param {object} opts
 * @param {Function} opts.push - SDK 事件推送方法
 */
export function setupClipboardMonitor({ push }) {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return () => {}

  const clip = navigator.clipboard
  const restores = []

  const wrap = (method, name, propsFn) => {
    if (typeof clip[method] !== 'function') return
    const native = clip[method].bind(clip)
    clip[method] = function (...args) {
      push({ type: 'behavior', name, props: propsFn ? propsFn(...args) : {} })
      return native(...args)
    }
    restores.push(() => { clip[method] = native })
  }

  // 仅元数据：writeText 记录字符长度；readText 不记录任何返回值
  wrap('readText', 'clipboard_read')
  wrap('writeText', 'clipboard_write', (text) => ({ length: typeof text === 'string' ? text.length : 0 }))

  return () => { restores.forEach(r => r()) }
}
