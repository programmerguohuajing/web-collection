import { setupClickMonitor } from './click.js'
import { setupInputMonitor } from './input.js'
import { setupPvMonitor } from './pv.js'
import { setupRouteMonitor } from './route.js'
import { setupScrollMonitor } from './scroll.js'
import { setupAdvancedBehaviorMonitor } from './advanced.js'

/**
 * 初始化用户行为监控模块。
 * 统一入口，依次启动 PV、点击、输入、路由、滚动四个子监控。
 *
 * @param {object} opts
 * @param {Function} opts.push - SDK 主实例的事件推入方法
 * @param {Function} [opts.onRoute] - 路由变化时的回调，用于触发回放分段
 */
export function setupBehaviorMonitor({ push, sanitizer, onRoute, formTracking, rageClick, deadClick, interactionTracking, inputTracking, selectTracking }) {
  // 子模块级容错：每个子监控独立 try/catch。若不隔离，某个子模块初始化抛错
  //（如 route 在无 history 的环境）会让整组 disposer 被外层 safe() 丢弃——
  // 先行注册的监听（pv 的 visibilitychange/scroll 等）将永不移除，destroy 后
  // 残留为僵尸监听器，重复初始化时叠加出多个一直 pending 的 collect 发送者。
  const disposers = []
  const safeSetup = (label, setup) => {
    try {
      const dispose = setup()
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (err) {
      console.warn(`[web-collection] behavior 子模块 "${label}" 初始化失败，已跳过：`, err && err.message)
    }
  }
  safeSetup('pv', () => setupPvMonitor({ push }))
  safeSetup('click', () => setupClickMonitor({ push, sanitizer }))
  if (inputTracking) safeSetup('input', () => setupInputMonitor({ push }))
  safeSetup('route', () => setupRouteMonitor({ push, onRoute }))
  safeSetup('scroll', () => setupScrollMonitor({ push }))
  safeSetup('advanced', () => setupAdvancedBehaviorMonitor({ push, sanitizer, formTracking, rageClick, deadClick, interactionTracking, selectTracking }))
  return () => disposers.forEach(dispose => dispose?.())
}
