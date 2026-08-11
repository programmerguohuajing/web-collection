import { elementInfo } from '../utils/dom.js'

/**
 * 初始化输入行为监控。
 *
 * 采集输入框的聚焦、失焦和值变化事件，不采集实际输入内容。
 * 仅采集元数据：聚焦时长、变化次数、值长度。
 *
 * @param {object} opts
 * @param {Function} opts.push - SDK 主实例的事件推入方法
 */
export function setupInputMonitor({ push }) {
  let focusMap = new WeakMap() // element -> { startTime, changeCount }

  const onFocusIn = event => {
    const target = event.target
    if (!isInputElement(target)) return
    focusMap.set(target, { startTime: Date.now(), changeCount: 0 })
    push({ type: 'behavior', name: 'input_focus', props: { ...elementInfo(target) } })
  }

  const onFocusOut = event => {
    const target = event.target
    if (!isInputElement(target)) return
    const record = focusMap.get(target)
    const props = elementInfo(target)
    if (record) {
      props.duration = Date.now() - record.startTime
      props.valueLength = String(target.value || '').length
    }
    focusMap.delete(target)
    push({ type: 'behavior', name: 'input_blur', props })
  }

  const onInput = event => {
    const target = event.target
    if (!isInputElement(target)) return
    const record = focusMap.get(target)
    if (!record) return
    record.changeCount++
    push({ type: 'behavior', name: 'input_change', props: { ...elementInfo(target), changeCount: record.changeCount } })
  }

  addEventListener('focusin', onFocusIn)
  addEventListener('focusout', onFocusOut)
  addEventListener('input', onInput, { passive: true })

  return () => {
    removeEventListener('focusin', onFocusIn)
    removeEventListener('focusout', onFocusOut)
    removeEventListener('input', onInput)
    focusMap = new WeakMap()
  }
}

/**
 * 判断 DOM 元素是否为可输入元素
 * 可输入元素包括：<input>、<textarea>、contenteditable 元素
 * 排除 <select>（由 selectTracking 独立处理）
 * @param {Element} el - DOM 元素
 * @returns {boolean}
 */
function isInputElement(el) {
  if (!el || el.nodeType !== 1) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true
  if (tag === 'SELECT') return false // select 由 selectTracking 独立处理
  if (el.isContentEditable) return true
  return false
}
