import { setupClickMonitor } from './click.js'
import { setupPvMonitor } from './pv.js'
import { setupRouteMonitor } from './route.js'
import { setupScrollMonitor } from './scroll.js'
import { setupAdvancedBehaviorMonitor } from './advanced.js'

/**
 * 初始化用户行为监控模块。
 * 统一入口，依次启动 PV、点击、路由、滚动四个子监控。
 *
 * @param {object} opts
 * @param {Function} opts.push - SDK 主实例的事件推入方法
 * @param {Function} [opts.onRoute] - 路由变化时的回调，用于触发回放分段
 */
export function setupBehaviorMonitor({ push, onRoute, formTracking, rageClick, deadClick, interactionTracking }) {
  const disposers = [
    setupPvMonitor({ push }),
    setupClickMonitor({ push }),
    setupRouteMonitor({ push, onRoute }),
    setupScrollMonitor({ push }),
    setupAdvancedBehaviorMonitor({ push, formTracking, rageClick, deadClick, interactionTracking })
  ]
  return () => disposers.forEach(dispose => dispose?.())
}
