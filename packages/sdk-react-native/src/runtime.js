/**
 * @file 宿主能力探测（失效安全 L1：注入 + 探测，缺失即降级并记诊断）
 *
 * 红线：本包源码不得假设任何浏览器全局（window / document / localStorage …）。
 * 所有宿主能力一律「优先 runtime 注入，其次对宿主全局做 typeof 探测」，缺失即返回 null，由调用方静默关闭对应模块。
 */
import { DIAGNOSTIC } from './constants.js'

/**
 * 判断值是否为可调用的函数。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isFunction(value) {
  return typeof value === 'function'
}

/**
 * 判断注入的 storage 是否可用（与 adapters.js:77 能力位判定口径一致）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isStorageLike(value) {
  return Boolean(value) && isFunction(value.getItem) && isFunction(value.setItem)
}

/**
 * 从宿主全局中挑选第一个可用的函数型属性。
 * @param {object} globals 全局对象（默认 globalThis，测试可注入）
 * @param {string[]} names 属性名列表
 * @returns {Function | null}
 */
export function pick(globals, names = []) {
  const source = globals && typeof globals === 'object' ? globals : {}
  for (const name of names) {
    const value = source[name]
    if (isFunction(value)) return value
  }
  return null
}

/**
 * 探测宿主是否具备 AppState 形态（addEventListener + currentState）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAppStateLike(value) {
  return Boolean(value) && isFunction(value.addEventListener)
}

/**
 * 探测 ErrorUtils 形态（setGlobalHandler 必需，getGlobalHandler 可选）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isErrorUtilsLike(value) {
  return Boolean(value) && isFunction(value.setGlobalHandler)
}

/**
 * 探测 Hermes 未处理 Promise 追踪能力（**非公开稳定 API**，必须特性探测 + try/catch）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isHermesLike(value) {
  return Boolean(value) && isFunction(value.enablePromiseRejectionTracker)
}

/**
 * 探测原生崩溃桥接（getPending / clear 至少具备其一即可作为占位通道）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNativeCrashBridge(value) {
  return Boolean(value) && (isFunction(value.getPending) || isFunction(value.clear))
}

/**
 * 解析设备信息：支持静态对象或 getter 函数（getter 抛错时返回 null，绝不向上抛）。
 * @param {unknown} value
 * @returns {object | null}
 */
export function resolveDeviceInfo(value) {
  if (!value) return null
  if (isFunction(value)) {
    try {
      const result = value()
      return result && typeof result === 'object' ? result : null
    } catch {
      return null
    }
  }
  return typeof value === 'object' ? value : null
}

/**
 * 构建帧回调源：优先宿主注入的 frameCallback，其次宿主全局 requestAnimationFrame。
 * 统一契约：`(cb) => unsubscribe`，由采集模块负责在 stop()/destroy() 时退订（失效安全 L5）。
 * @param {object} [globals=globalThis]
 * @returns {((cb: (ts: number) => void) => (() => void)) | null}
 */
export function createFrameSource(globals = globalThis) {
  const raf = pick(globals, ['requestAnimationFrame'])
  if (!raf) return null
  const cancel = pick(globals, ['cancelAnimationFrame'])
  return function frameSource(callback) {
    let stopped = false
    const tick = timestamp => {
      if (stopped) return
      try {
        callback(typeof timestamp === 'number' ? timestamp : Date.now())
      } catch {
        // 帧回调内的异常绝不能打断宿主的渲染循环，静默吞掉（由各采集模块自行记诊断）。
      }
      if (!stopped) raf(tick)
    }
    const handle = raf(tick)
    return function unsubscribe() {
      stopped = true
      if (cancel) {
        try { cancel(handle) } catch { /* 取消失败无需处理，stopped 已阻止后续调度 */ }
      }
    }
  }
}

/**
 * 宿主能力矩阵探测。
 * @param {object} [runtime={}] 宿主注入对象
 * @param {object} [globals=globalThis] 全局对象（测试可注入为空对象以模拟能力全缺失）
 * @returns {{ fetch: Function | null, storage: object | null, appState: object | null, errorUtils: object | null, hermes: object | null, netInfo: object | null, nativeCrash: object | null, frameSource: Function | null, deviceInfo: object | null, getContext: Function | null, version: string, raw: object }}
 */
export function detect(runtime = {}, globals = globalThis) {
  const source = runtime && typeof runtime === 'object' ? runtime : {}
  const scope = globals && typeof globals === 'object' ? globals : globalThis

  const storage = isStorageLike(source.storage) ? source.storage : null
  const fetchImpl = isFunction(source.fetch) ? source.fetch : pick(scope, ['fetch'])
  const appState = isAppStateLike(source.appState) ? source.appState : null
  const errorUtils = isErrorUtilsLike(source.errorUtils)
    ? source.errorUtils
    : (isErrorUtilsLike(scope.ErrorUtils) ? scope.ErrorUtils : null)
  const hermes = isHermesLike(source.hermes)
    ? source.hermes
    : (isHermesLike(scope.HermesInternal) ? scope.HermesInternal : null)
  const netInfo = source.netInfo && (isFunction(source.netInfo.addEventListener) || isFunction(source.netInfo.fetch)) ? source.netInfo : null
  const nativeCrash = isNativeCrashBridge(source.nativeCrash) ? source.nativeCrash : null
  const frameSource = isFunction(source.frameCallback) ? source.frameCallback : createFrameSource(scope)
  const deviceInfo = resolveDeviceInfo(source.deviceInfo)
  const getContext = isFunction(source.getContext) ? source.getContext : null
  const version = typeof source.version === 'string' && source.version ? source.version : 'unknown'

  return {
    fetch: fetchImpl,
    storage,
    appState,
    errorUtils,
    hermes,
    netInfo,
    nativeCrash,
    frameSource,
    deviceInfo,
    getContext,
    version,
    raw: source
  }
}

/**
 * 粗略判断是否运行在 React Native 宿主（用于诊断与文档自查，不参与采集门控）。
 * 判据：存在 ErrorUtils 或 HermesInternal 或 AppState 形态对象。
 * @param {object} [globals=globalThis]
 * @returns {boolean}
 */
export function isReactNative(globals = globalThis) {
  const scope = globals && typeof globals === 'object' ? globals : globalThis
  return isErrorUtilsLike(scope.ErrorUtils) || isHermesLike(scope.HermesInternal) || Boolean(scope.__fbBatchedBridge)
}

/**
 * 声明能力缺失诊断（失效安全 L1 的统一出口）。
 * @param {{ emit?: Function } | null} diagnostics
 * @param {string} capability
 */
export function reportMissing(diagnostics, capability) {
  try {
    diagnostics?.emit?.(DIAGNOSTIC.CAPABILITY_MISSING, { capability })
  } catch {
    // 诊断出口自身异常必须静默，绝不影响主链路。
  }
}
