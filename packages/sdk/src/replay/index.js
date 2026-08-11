import { loadRrweb } from './rrweb-driver.js'

/**
 * 会话回放模块 facade（SDK-209 · 懒加载）。
 *
 * 本模块不再在顶层静态 import rrweb，而是通过 `loadRrweb()` 在回放真正启动时
 * 按需加载。核心包（ESM/IIFE）不会包含 rrweb；`replay:false` 时根本不会触发加载。
 *
 * facade 持有已加载的 rrweb 驱动引用；未加载前 `addReplayEvent` / `takeReplaySnapshot`
 * 为安全的 no-op，避免录制未启动时调用抛错。
 */

let driver = null
let loading = null

/**
 * 加载并缓存 rrweb 驱动（幂等；并发调用共享同一 Promise）。
 * @param {object} [opts]
 * @param {string} [opts.replayLibUrl]
 * @returns {Promise<object>} rrweb 模块
 */
export async function ensureDriver({ replayLibUrl } = {}) {
  if (driver) return driver
  if (!loading) loading = loadRrweb({ replayLibUrl })
  driver = await loading
  return driver
}

/**
 * 是否已经加载 rrweb 驱动（用于轻量判断，不触发加载）。
 * @returns {boolean}
 */
export function isDriverLoaded() {
  return !!driver
}

/**
 * 仅供测试：注入/清空 rrweb 驱动，避免测试中真的 import('rrweb') 触发 Node 下的
 * MessagePort 泄漏。生产代码不得使用。
 * @param {object|null} d
 */
export function __setDriver(d) {
  driver = d
  loading = null
}

/**
 * 初始化会话回放监控（基于 rrweb）。必须先 `ensureDriver`。
 *
 * @param {object} opts
 * @param {Function} opts.emit - rrweb 事件回调
 * @param {object} [opts.options={}] - rrweb 附加配置
 * @returns {Function} 停止录制的函数（rrweb 的 record 返回值）
 */
export function setupReplayMonitor({ emit, options = {} }) {
  if (!driver) {
    throw new Error('[web-collection] setupReplayMonitor 必须在 ensureDriver 之后调用')
  }
  const { record } = driver
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
    recordCanvas: false,
    collectFonts: true,
    errorHandler: () => {},
    ...options
  })
}

/**
 * 向回放录制中注入自定义事件标记。
 * @param {string} tag
 * @param {object} [payload={}]
 */
export function addReplayEvent(tag, payload = {}) {
  driver?.record?.addCustomEvent?.(tag, payload)
}

/**
 * 立即触发一次全量 DOM 快照。
 */
export function takeReplaySnapshot() {
  driver?.record?.takeFullSnapshot?.(true)
}
