import { elementInfo } from '../utils/dom.js'

/**
 * 初始化点击行为监控。
 * 在捕获阶段监听全局 click 事件，匹配可交互元素
 *（button、a、input 等及带 data-track 属性的元素），
 * 提取元素信息后推入上报队列。
 *
 * @param {object} opts
 * @param {Function} opts.push - SDK 主实例的事件推入方法
 */
export function setupClickMonitor({ push }) {
  const onClick = event => {
    const source = event.target?.nodeType === 1 ? event.target : event.target?.parentElement
    const target = source?.closest?.('[data-track],button,a,input,textarea,select,[role="button"],uni-button') || source
    if (!target) return
    const props = elementInfo(target)
    const label = props.tag === 'BUTTON'
      ? (props.text || props.ariaLabel || props.title || props.name || props.id || props.label)
      : (props.label || props.text || props.ariaLabel || props.alt || props.title || props.name || props.id)
    push({
      type: 'behavior',
      name: 'click',
      props: {
        ...props,
        action: 'click',
        elementLabel: label,
        elementType: props.tag,
        elementName: props.name || '',
        elementId: props.id || '',
        elementText: props.text || '',
        elementRole: props.role || '',
        elementHref: props.href || ''
      }
    })
  }
  addEventListener('click', onClick, true)
  return () => removeEventListener('click', onClick, true)
}
