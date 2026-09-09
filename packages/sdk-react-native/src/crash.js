/**
 * @file 崩溃与错误捕获（M4 JS 崩溃 / M5 原生崩溃占位通道）
 *
 * 失效安全红线（架构 §5.8-L4）：**不篡改宿主行为**。
 * - ErrorUtils.setGlobalHandler 必须在上报后**链式调用宿主原 handler**（getGlobalHandler 取得），
 *   否则会改变宿主红屏 / 崩溃行为；原 handler 自身抛错被吞掉，不影响宿主与 SDK。
 * - Hermes `enablePromiseRejectionTracker` 是**非公开稳定 API**，必须 typeof 探测 + try/catch，
 *   不可用则静默跳过（不记诊断噪声）。
 * - 去重 / 面包屑 / 指纹复用内核 error()（core.js:174 1s 去重 + :278 面包屑）。
 */
import { DIAGNOSTIC } from './constants.js'
import { jsCrash, nativeCrash } from './events.js'
import { guard, circuit } from './guard.js'
import { isFunction } from './runtime.js'

/**
 * 创建崩溃监控器。
 * @param {{
 *   error?: (reason: unknown, extra?: object) => void,
 *   diagnostics?: { emit?: Function } | null,
 *   crash?: { js?: boolean, rejection?: boolean, native?: boolean },
 *   now?: () => number
 * }} [options={}]
 */
export function createCrashMonitor(options = {}) {
  const emit = isFunction(options.error) ? options.error : () => {}
  const diagnostics = options.diagnostics || null
  const crashCfg = options.crash && typeof options.crash === 'object' ? options.crash : {}
  const breaker = circuit({ label: 'crash', diagnostics })
  const disposers = []
  let installed = false

  /**
   * 安装 JS 崩溃采集（ErrorUtils）。
   * @param {object | null} errorUtils
   * @returns {(() => void) | null} 反注册函数
   */
  function installJsCrash(errorUtils) {
    if (crashCfg.js === false) return null
    if (!errorUtils || !isFunction(errorUtils.setGlobalHandler)) {
      diagnostics?.emit?.(DIAGNOSTIC.CAPABILITY_MISSING, { capability: 'jsCrash' })
      return null
    }
    let prev = null
    try {
      prev = isFunction(errorUtils.getGlobalHandler) ? errorUtils.getGlobalHandler() : null
    } catch {
      prev = null
    }
    if (!isFunction(prev)) prev = null

    const handler = guard(function globalHandler(err, isFatal) {
      try {
        const event = jsCrash(err, isFatal, 'global')
        emit(err, event.props)
      } finally {
        // L4：无论上报是否成功，都必须把控制权交还原宿主 handler（不吞宿主行为）。
        if (prev) prev(err, isFatal)
      }
    }, 'crash.globalHandler', diagnostics)

    try {
      errorUtils.setGlobalHandler(handler)
    } catch (error) {
      diagnostics?.emit?.(DIAGNOSTIC.SDK_INTERNAL_ERROR, { module: 'crash', reason: 'set_global_handler_failed' })
      return null
    }

    return function disposeJsCrash() {
      // 仅在宿主原有 handler 存在时还原，避免把 null 写回 ErrorUtils 破坏宿主。
      if (!prev) return
      try {
        errorUtils.setGlobalHandler(prev)
      } catch {
        // 还原失败无需处理：handler 内部已保证链式调用，不会丢失宿主行为。
      }
    }
  }

  /**
   * 安装未处理 Promise 采集（Hermes rejection tracker，特性探测 + 静默降级）。
   * @param {object | null} hermes
   * @returns {(() => void) | null}
   */
  function installRejection(hermes) {
    if (crashCfg.rejection === false) return null
    if (!hermes || !isFunction(hermes.enablePromiseRejectionTracker)) return null  // 静默跳过（已知非公开 API）
    const onUnhandled = guard(function handleRejection(_id, rejection) {
      const event = jsCrash(rejection, false, 'unhandledrejection')
      emit(rejection, event.props)
    }, 'crash.rejection', diagnostics)
    try {
      hermes.enablePromiseRejectionTracker({ allRejections: true, onUnhandled })
    } catch (error) {
      diagnostics?.emit?.(DIAGNOSTIC.SDK_INTERNAL_ERROR, { module: 'crash', reason: 'hermes_tracker_failed' })
      return null
    }
    // Hermes 未提供反注册 API，返回空实现以保证 dispose 链完整。
    return function disposeRejection() {}
  }

  /**
   * 上报原生崩溃（占位通道）。
   * 通道默认关闭（Q-G：crash.native = false），关闭时仅记诊断并返回 false，**不抛**。
   * @param {{ name?: string, message?: string, stack?: string, nativeStack?: string, fingerprint?: string, props?: object }} [payload={}]
   * @returns {boolean} 是否真的上报
   */
  function reportNativeCrash(payload = {}) {
    if (crashCfg.native !== true) {
      diagnostics?.emit?.(DIAGNOSTIC.MODULE_DISABLED, { module: 'nativeCrash', reason: 'channel_closed' })
      return false
    }
    return guard(function emitNative() {
      const event = nativeCrash(payload)
      emit(
        { name: event.name, message: event.message, stack: event.stack },
        event.props
      )
      return true
    }, 'crash.nativeCrash', diagnostics)() === true
  }

  /**
   * 启动时排空宿主缓存的原生崩溃（仅当通道开启且有桥接）。
   * @param {object | null} bridge { getPending?, clear? }
   * @returns {Promise<boolean>}
   */
  async function drainPendingNativeCrash(bridge) {
    if (crashCfg.native !== true) return false
    if (!bridge || !isFunction(bridge.getPending)) return false
    let pending = null
    try {
      pending = await Promise.resolve(bridge.getPending())
    } catch {
      return false
    }
    if (!pending) return false
    const sent = reportNativeCrash(pending)
    if (sent && isFunction(bridge.clear)) {
      try { await Promise.resolve(bridge.clear()) } catch { /* 清理失败不影响已上报事件 */ }
    }
    return sent
  }

  /**
   * 安装全部崩溃采集通道。
   * @param {object} [caps={}] runtime.detect 输出
   * @returns {() => void} dispose（幂等）
   */
  function install(caps = {}) {
    if (installed) return () => dispose()
    installed = true
    const jsDispose = installJsCrash(caps.errorUtils || null)
    if (isFunction(jsDispose)) disposers.push(jsDispose)
    const rejectionDispose = installRejection(caps.hermes || null)
    if (isFunction(rejectionDispose)) disposers.push(rejectionDispose)
    if (crashCfg.native === true && caps.nativeCrash) void drainPendingNativeCrash(caps.nativeCrash)
    return () => dispose()
  }

  /** 反注册全部通道（幂等）。 */
  function dispose() {
    installed = false
    const list = disposers.splice(0)
    for (const fn of list) {
      if (isFunction(fn)) {
        try { fn() } catch { /* 反注册失败无需处理 */ }
      }
    }
  }

  return {
    install,
    dispose,
    installJsCrash,
    installRejection,
    reportNativeCrash,
    drainPendingNativeCrash,
    get breaker() {
      return breaker
    }
  }
}
