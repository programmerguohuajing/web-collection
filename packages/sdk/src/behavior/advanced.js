import { elementInfo } from '../utils/dom.js'

/**
 * 设置高级用户行为监控
 * 按需监听表单提交、愤怒点击、死点击、剪贴板操作/下载、选择框变更等行为并上报
 *
 * @param {Object}   options
 * @param {Function} options.push                - 数据上报函数，接收形如 { type, name, props } 的行为事件
 * @param {boolean}  [options.formTracking=false]        - 是否监听表单提交
 * @param {boolean}  [options.rageClick=false]            - 是否监听愤怒点击（同一元素 1 秒内连续点击 3 次）
 * @param {boolean}  [options.deadClick=false]            - 是否监听死点击（标记了 data-track-dead-click 的元素被点击但未产生响应）
 * @param {boolean}  [options.interactionTracking=false]  - 是否监听复制、粘贴、下载操作
 * @param {boolean}  [options.selectTracking=false]       - 是否监听 <select> 选项变更
 * @returns {Function} 返回一个清理函数，调用后可解除所有事件监听
 */
export function setupAdvancedBehaviorMonitor({ push, formTracking = false, rageClick = false, deadClick = false, interactionTracking = false, selectTracking = false }) {
  // 收集所有事件解绑函数，用于最终统一清理
  const disposers = []
  // 使用 WeakMap 存储每个 DOM 元素的点击历史，元素被移除时自动 GC，避免内存泄漏
  const clickHistory = new WeakMap()

  // 所有开关均未开启时，直接返回空函数，避免不必要的开销
  if (!formTracking && !rageClick && !deadClick && !interactionTracking && !selectTracking) return () => {}

  // ========== 表单提交监听 ==========
  if (formTracking) {
    const onSubmit = event => {
      const form = event.target
      push({ type: 'behavior', name: 'form_submit', props: formInfo(form) })
    }
    // 使用捕获阶段确保即使事件被 stopPropagation 也能监听到
    addEventListener('submit', onSubmit, true)
    disposers.push(() => removeEventListener('submit', onSubmit, true))
  }

  // ========== 愤怒点击 & 死点击监听 ==========
  if (rageClick || deadClick) {
    const onClick = event => {
      // 确保 target 为元素节点，若为文本节点则取其父元素
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement
      if (!target) return

      // 愤怒点击：同一元素在 1 秒内被点击 3 次即为愤怒点击
      if (rageClick) {
        const now = Date.now()
        const previous = clickHistory.get(target)
        // 如果距离上次点击开始不超过 1 秒则累加计数，否则重置计数重新开始
        const item = previous && now - previous.startedAt < 1000
          ? { startedAt: previous.startedAt, count: previous.count + 1 }
          : { startedAt: now, count: 1 }
        clickHistory.set(target, item)
        // 仅在第 3 次点击时上报，避免中间过程产生冗余数据
        if (item.count === 3) push({ type: 'behavior', name: 'rage_click', props: elementInfo(target) })
      }

      // 死点击：点击了带 data-track-dead-click 属性的元素（由开发者声明式标记无响应区域）
      if (deadClick && target.matches?.('[data-track-dead-click]')) {
        push({ type: 'behavior', name: 'dead_click', props: elementInfo(target) })
      }
    }
    addEventListener('click', onClick, true)
    disposers.push(() => removeEventListener('click', onClick, true))
  }

  // ========== 用户交互监听（复制 / 粘贴 / 下载） ==========
  if (interactionTracking) {
    const onCopy = event => push({ type: 'behavior', name: 'copy', props: elementInfo(event.target) })
    const onPaste = event => push({ type: 'behavior', name: 'paste', props: elementInfo(event.target) })
    const onDownload = event => {
      // 通过事件委托查找最近的带 download 属性的 <a> 标签
      const target = event.target?.closest?.('a[download]')
      if (target) push({ type: 'behavior', name: 'download', props: { ...elementInfo(target), download: target.getAttribute('download') || '' } })
    }
    addEventListener('copy', onCopy, true)
    addEventListener('paste', onPaste, true)
    addEventListener('click', onDownload, true)
    disposers.push(() => removeEventListener('copy', onCopy, true))
    disposers.push(() => removeEventListener('paste', onPaste, true))
    disposers.push(() => removeEventListener('click', onDownload, true))
  }

  // ========== 选择框变更监听 ==========
  if (selectTracking) {
    const onChange = event => {
      const target = event.target
      // 仅处理 <select> 元素的变更事件
      if (!target || target.tagName !== 'SELECT') return
      const options = target.options
      const selectedIndex = target.selectedIndex
      push({
        type: 'behavior',
        name: 'select_change',
        props: {
          ...elementInfo(target),
          selectedValue: target.value || '',              // 当前选中项的值
          selectedText: options[selectedIndex]?.text || '', // 当前选中项的文本
          selectedIndex,                                   // 当前选中项的索引
          totalOptions: options.length                     // 可选项总数
        }
      })
    }
    // 使用冒泡阶段（默认），因为 select 的 change 事件通常不会被阻止冒泡
    addEventListener('change', onChange)
    disposers.push(() => removeEventListener('change', onChange))
  }

  // 返回清理函数：遍历执行所有解绑操作
  return () => disposers.forEach(dispose => dispose())
}

/**
 * 提取表单基本信息
 * @param {HTMLFormElement} form
 * @returns {{ id: string, name: string, action: string, method: string }}
 */
function formInfo(form) {
  return {
    id: form?.id || '',
    name: form?.name || '',
    action: form?.action || '',
    method: form?.method || 'get'
  }
}
