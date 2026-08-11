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
  const disposers = [
    setupPvMonitor({ push }),
    setupClickMonitor({ push, sanitizer }),
    ...(inputTracking ? [setupInputMonitor({ push })] : []),
    setupRouteMonitor({ push, onRoute }),
    setupScrollMonitor({ push }),
    setupAdvancedBehaviorMonitor({ push, sanitizer, formTracking, rageClick, deadClick, interactionTracking, selectTracking })
  ]
  return () => disposers.forEach(dispose => dispose?.())
}
