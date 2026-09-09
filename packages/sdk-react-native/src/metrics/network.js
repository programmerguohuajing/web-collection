/**
 * @file 网络采集（M3 · metric `fetch` 复用内核 wrapFetch + 可选 NetInfo 网络类型）
 *
 * 失效安全红线（架构 §5.8-L4）：`wrapFetch` 必须保持内核 `wrapFetch` 的返回值与异常语义
 * （请求失败 → 原异常被 rethrow），绝不吞异常、绝不改变宿主 fetch 行为。
 *
 * NetInfo（可选）：监听网络类型变化 → 更新 context.network.type + behavior('network_change')（M10）。
 * 缺失则 capability_missing: networkStatus，其余采集照常。
 */
import { DIAGNOSTIC, EVENT_NAME } from '../constants.js'
import { guard } from '../guard.js'
import { isFunction } from '../runtime.js'

/**
 * 创建网络采集器。
 * @param {{
 *   wrapFetch?: ((impl?: Function) => Function) | null,
 *   autoWrap?: boolean,
 *   netInfo?: { addEventListener?: Function, fetch?: Function } | null,
 *   getContext?: (() => object) | null,
 *   setContext?: ((ctx: object) => void) | null,
 *   behavior?: (name: string, props?: object) => void,
 *   diagnostics?: { emit?: Function } | null
 * }} [options={}]
 */
export function createNetworkInstrumentor(options = {}) {
  const wrapFetch = isFunction(options.wrapFetch) ? options.wrapFetch : null
  const autoWrap = options.autoWrap === true
  const netInfo = options.netInfo || null
  const getContext = isFunction(options.getContext) ? options.getContext : null
  const setContext = isFunction(options.setContext) ? options.setContext : null
  const behavior = isFunction(options.behavior) ? options.behavior : () => {}
  const diagnostics = options.diagnostics || null
  const disposers = []

  /**
   * 复用内核 wrapFetch（架构 §5.6，与 Web 端口径一致）。
   * 保持返回值与异常语义：内核 wrapFetch(impl) 返回包装后的函数，请求失败会 rethrow。
   * @param {Function} [impl] 被包装的 fetch 实现；缺省时内核包装全局 fetch。
   * @returns {Function} 包装后的 fetch（无内核时为原 impl 透传）
   */
  function wrap(impl) {
    if (!isFunction(wrapFetch)) return impl
    return wrapFetch(impl)
  }

  /**
   * 安装 NetInfo 监听：网络类型变化 → 更新 context.network + behavior('network_change')。
   * 返回退订函数；能力缺失或订阅失败返回 null。
   * @returns {(() => void) | null}
   */
  function install() {
    if (!netInfo || !isFunction(netInfo.addEventListener)) {
      diagnostics?.emit?.(DIAGNOSTIC.CAPABILITY_MISSING, { capability: 'networkStatus' })
      return null
    }
    let last = null
    const onState = guard(function handleNetworkState(state) {
      const type = (state && (state.type || state.networkType)) || 'unknown'
      if (type === last) return
      last = type
      // 更新 context.network（与内核 setContext 合并，避免覆盖 device/os/app 维度）。
      if (isFunction(setContext)) {
        try {
          const current = isFunction(getContext) ? (() => { try { return getContext() || {} } catch { return {} } })() : {}
          const merged = {
            ...(current && typeof current === 'object' ? current : {}),
            network: { ...(current && current.network && typeof current.network === 'object' ? current.network : {}), type }
          }
          setContext(merged)
        } catch {
          // context 写入失败不影响网络事件。
        }
      }
      try { behavior(EVENT_NAME.NETWORK_CHANGE, { network: type }) } catch { /* 静默 */ }
    }, 'network.onState', diagnostics)

    let unsubscribe = null
    try {
      const subscription = netInfo.addEventListener('change', onState)
      unsubscribe = isFunction(subscription?.remove)
        ? () => subscription.remove()
        : (isFunction(subscription) ? subscription : null)
    } catch {
      unsubscribe = null
    }
    if (isFunction(unsubscribe)) disposers.push(unsubscribe)

    // 立即拉取一次当前状态（NetInfo.fetch 返回当前网络记录）。
    if (isFunction(netInfo.fetch)) {
      try { Promise.resolve(netInfo.fetch()).then(onState).catch(() => {}) } catch { /* 静默 */ }
    }

    // 主动改写宿主全局 fetch（仅当 autoWrap 显式开启，Q-D 默认关闭）。
    if (autoWrap && isFunction(wrapFetch) && typeof globalThis.fetch === 'function') {
      try { globalThis.fetch = wrap(globalThis.fetch) } catch { /* 改写失败不影响采集 */ }
    }

    return () => dispose()
  }

  /** 退订（幂等）。 */
  function dispose() {
    const list = disposers.splice(0)
    for (const fn of list) {
      if (isFunction(fn)) {
        try { fn() } catch { /* 退订失败无需处理 */ }
      }
    }
  }

  return { install, dispose, wrap }
}
