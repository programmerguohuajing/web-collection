import { record } from 'rrweb'

/**
 * 初始化会话回放监控（基于 rrweb）。
 *
 * 录制页面 DOM 变化、用户交互等事件，用于在后台回放用户操作路径。
 * 默认开启输入框脱敏（maskAllInputs）、密码/邮箱/电话等敏感字段遮挡，
 * 支持 `.eys-block`（遮挡）和 `.eys-ignore`（忽略）CSS 类名控制。
 * 每分钟自动生成全量快照（checkoutEveryNms），确保回放数据完整性。
 *
 * @param {object} opts
 * @param {Function} opts.emit - rrweb 事件回调，每产生一个录制事件时调用
 * @param {object} [opts.options={}] - rrweb 附加配置，会与默认配置合并
 * @returns {Function} 停止录制的函数
 */
export function setupReplayMonitor({ emit, options = {} }) {
  return record({
    emit,
    maskAllInputs: true,
    maskInputOptions: { password: true, email: true, tel: true, text: true, textarea: true },
    blockClass: 'eys-block',
    blockSelector: '.eys-block',
    ignoreClass: 'eys-ignore',
    ignoreSelector: '.eys-ignore',
    slimDOMOptions: true,
    inlineStylesheet: true,
    checkoutEveryNms: 60000,
    recordCanvas: false,
    collectFonts: true,
    errorHandler: () => {},
    ...options
  })
}

/**
 * 向回放录制中注入自定义事件标记。
 * 可在业务关键节点调用，在回放中标注关键操作。
 *
 * @param {string} tag - 自定义事件标签
 * @param {object} [payload={}] - 附加数据
 */
export function addReplayEvent(tag, payload = {}) {
  record.addCustomEvent?.(tag, payload)
}

/**
 * 立即触发一次全量 DOM 快照。
 * 适用于路由切换等场景，确保回放分段边界清晰。
 */
export function takeReplaySnapshot() {
  record.takeFullSnapshot?.(true)
}
