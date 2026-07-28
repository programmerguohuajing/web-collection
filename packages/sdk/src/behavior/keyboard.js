import { elementInfo } from '../utils/dom.js'

/**
 * 初始化键盘操作监控。
 *
 * 采集关键键盘操作（Enter、Escape 等），不采集实际输入内容。
 * 默认不开启，通过 keyboardTracking: true 启用。
 *
 * @param {object} opts
 * @param {Function} opts.push - SDK 主实例的事件推入方法
 * @param {string[]} [opts.keys=['Enter', 'Escape']] - 要追踪的按键列表
 */
export function setupKeyboardMonitor({ push, keys = ['Enter', 'Escape'] }) {
  const keySet = new Set(keys)
  const onKeyDown = event => {
    if (!keySet.has(event.key)) return
    push({
      type: 'behavior',
      name: 'keyboard',
      props: {
        key: event.key,
        targetElement: {
          tag: event.target?.tagName || '',
          type: event.target?.getAttribute?.('type') || '',
          role: event.target?.getAttribute?.('role') || ''
        },
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ...elementInfo(event.target)
      }
    })
  }
  addEventListener('keydown', onKeyDown, { passive: true })
  return () => removeEventListener('keydown', onKeyDown)
}
