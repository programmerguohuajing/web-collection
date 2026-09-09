/**
 * @file AppState 生命周期采集（M6 / M7 / M8）
 *
 * 状态机（架构 §5.3）：
 * - start() → behavior('app_start', { cold: true })，归一为 session_started
 * - active → background/inactive：behavior('app_background', { elapsedMs }) + flush(true)
 * - background → active：SessionManager.onForeground 判定旋转；
 *   超时（默认 30s）→ 新会话 + behavior('app_start', { cold: false })，再 behavior('app_foreground', { elapsedMs, newSession: true })
 *   阈值内 → 仅 behavior('app_foreground', { elapsedMs, newSession: false })
 * - 无 appState 注入：不注册，emit capability_missing: appState，其余采集照常
 *
 * 失效安全：回调整体 guard 包裹；install 返回 dispose，stop()/destroy() 全量退订（L5）。
 */
import { DIAGNOSTIC } from './constants.js'
import { background, foreground } from './events.js'
import { circuit, guard, guard as safeGuard } from './guard.js'
import { isFunction } from './runtime.js'

/**
 * 创建生命周期采集器。
 * @param {{
 *   behavior?: (name: string, props?: object) => void,
 *   flush?: (force?: boolean) => void | Promise<void>,
 *   emitAppStart?: (cold: boolean) => void,
 *   session?: { markBackground?: Function, onForeground?: Function } | null,
 *   now?: () => number,
 *   timeoutMs?: number,
 *   diagnostics?: { emit?: Function } | null
 * }} [options={}]
 */
export function createLifecycleInstrumentor(options = {}) {
  const behavior = isFunction(options.behavior) ? options.behavior : () => {}
  const flush = isFunction(options.flush) ? options.flush : () => {}
  const emitAppStart = isFunction(options.emitAppStart) ? options.emitAppStart : cold => behavior('app_start', { cold })
  const session = options.session || null
  const now = isFunction(options.now) ? options.now : () => Date.now()
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 30000
  const diagnostics = options.diagnostics || null
  const breaker = circuit({ label: 'lifecycle', diagnostics })

  let activeAt = now()
  let unsubscribe = null

  /**
   * 发射切前台事件（供宿主或测试直接驱动）。
   * @param {number} [elapsedMs=0]
   * @param {boolean} [newSession=false]
   */
  function emitForeground(elapsedMs = 0, newSession = false) {
    const event = foreground(elapsedMs, newSession)
    behavior(event.name, event.props)
  }

  /**
   * 发射切后台事件（不含 flush，便于测试拆分断言）。
   * @param {number} [elapsedMs=0]
   */
  function emitBackground(elapsedMs = 0) {
    const event = background(elapsedMs)
    behavior(event.name, event.props)
  }

  /**
   * 发射会话起点事件。
   * @param {boolean} [cold=true]
   */
  function emitAppStartEvent(cold = true) {
    emitAppStart(cold)
  }

  /** AppState change 回调（整体 guard，异常绝不向上抛）。 */
  const onChange = safeGuard(function handleChange(state) {
    if (breaker.disabled) return
    try {
      if (state === 'background' || state === 'inactive') {
        const elapsedMs = Math.max(0, now() - activeAt)
        try { session?.markBackground?.(now()) } catch { /* 会话状态异常不影响生命周期事件 */ }
        emitBackground(elapsedMs)
        // 切后台立即强制发送（PRD P0-4 / P0-8；内核 flush(true) 绕过节流）
        void flush(true)
        return
      }
      if (state === 'active') {
        const result = session && isFunction(session.onForeground)
          ? (() => {
            try { return session.onForeground(now(), timeoutMs) } catch { return { rotated: false, elapsedMs: 0 } }
          })()
          : { rotated: false, elapsedMs: 0 }
        if (result && result.rotated) emitAppStart(false)
        emitForeground(result?.elapsedMs || 0, Boolean(result?.rotated))
        activeAt = now()
      }
    } catch (error) {
      breaker.recordFailure()
      throw error
    }
  }, 'lifecycle.onChange', diagnostics)

  /**
   * 订阅宿主 AppState。返回退订函数；能力缺失或订阅失败返回 null。
   * @param {object | null} appState
   * @returns {(() => void) | null}
   */
  function install(appState) {
    if (!appState || !isFunction(appState.addEventListener)) {
      diagnostics?.emit?.(DIAGNOSTIC.CAPABILITY_MISSING, { capability: 'appState' })
      return null
    }
    try {
      const subscription = appState.addEventListener('change', onChange)
      unsubscribe = isFunction(subscription?.remove) ? () => subscription.remove() : (isFunction(subscription) ? subscription : null)
      return () => dispose()
    } catch (error) {
      // 宿主 API 抛错：静默降级，不阻断其余采集。
      diagnostics?.emit?.(DIAGNOSTIC.SDK_INTERNAL_ERROR, { module: 'lifecycle', reason: 'appstate_subscribe_failed' })
      return null
    }
  }

  /** 退订（幂等）。 */
  function dispose() {
    const fn = unsubscribe
    unsubscribe = null
    if (isFunction(fn)) {
      try { fn() } catch { /* 退订失败无需处理 */ }
    }
  }

  return {
    install,
    dispose,
    emitAppStart: emitAppStartEvent,
    emitForeground,
    emitBackground,
    get breaker() {
      return breaker
    }
  }
}
