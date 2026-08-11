/**
 * 跨标签页单活跃发送者锁（Reliable Transport v2）。
 *
 * 目标：同一域名下「最多一个标签页」真正执行发送，避免多标签页重复上报
 * 造成的存储与带宽浪费（服务端仍按 eventId 去重作为最终防线）。
 *
 * 实现：Best-effort 的轻量领导者选举——
 * - 可用 `BroadcastChannel` 时，请求方广播 `request`，持有方回应 `held`；
 *   超时（无竞争者回应）即视为赢得锁。
 * - 不可用时（Node、隐私模式、旧浏览器）退化为同标签页内的布尔守卫。
 *
 * 注意：这是尽力而为的协调，不是强一致锁；最终正确性仍由服务端 eventId 幂等保证。
 * 使用方应在不再需要时调用 `close()`，否则底层 BroadcastChannel 持有的 MessagePort
 * 会使进程/Worker 无法正常退出（资源泄漏）。
 *
 * @param {string} name - 锁名称（通常为 endpoint 域名）
 * @param {object} [opts]
 * @param {typeof BroadcastChannel} [opts.BroadcastChannel] - 可注入，便于测试
 * @param {number} [opts.timeout=120] - 竞争窗口（ms），超时即视为赢得锁
 */
export function createMultiTabLock(name, opts = {}) {
  const Channel = opts.BroadcastChannel || (typeof BroadcastChannel !== 'undefined' ? BroadcastChannel : null)
  const TIMEOUT = opts.timeout != null ? opts.timeout : 120
  let channel = null
  let held = false
  let pendingResolve = null
  let pendingTimer = null

  function ensureChannel() {
    if (channel || !Channel) return
    try {
      channel = new Channel(`eys-lock-${name}`)
      channel.onmessage = (e) => {
        const msg = e.data || {}
        if (msg.type === 'request') {
          // 若本标签页持有锁，告知请求方已被占用。
          if (held) channel.postMessage({ type: 'held' })
        } else if (msg.type === 'held') {
          if (pendingResolve) {
            clearTimeout(pendingTimer)
            const r = pendingResolve
            pendingResolve = null
            held = false
            r(false)
          }
        }
      }
    } catch {
      channel = null
    }
  }

  function acquire() {
    ensureChannel()
    if (!channel) {
      if (held) return Promise.resolve(false)
      held = true
      return Promise.resolve(true)
    }
    if (held) return Promise.resolve(false)
    return new Promise((resolve) => {
      pendingResolve = resolve
      pendingTimer = setTimeout(() => {
        pendingResolve = null
        held = true
        resolve(true)
      }, TIMEOUT)
      channel.postMessage({ type: 'request' })
    })
  }

  function release() {
    held = false
    if (channel) channel.postMessage({ type: 'release' })
  }

  /** 释放底层 BroadcastChannel（及其 MessagePort），避免进程/Worker 泄漏。 */
  function close() {
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingTimer = null
    pendingResolve = null
    if (channel) {
      try { channel.close() } catch {}
      channel = null
    }
  }

  return { acquire, release, close, isHeld: () => held }
}
