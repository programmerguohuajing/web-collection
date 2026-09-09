/**
 * @file RN 平台适配器构建（「扩展而非替换」内核 createReactNativeAdapter）
 *
 * 原则：调用内核 adapters.js:55 createReactNativeAdapter 拿到基础适配器，再在其上覆盖
 * getContext / getStorage / setStorage 并**合并** capabilities，保持 PlatformAdapter 接口兼容
 * （packages/sdk/platform.d.ts:51-74）。
 *
 * JS 崩溃采集归属说明：RN 侧统一由 src/crash.js 经 ErrorUtils / Hermes 采集；
 * runtime.onError / onUnhandledRejection 作为「用户自注册监听器」直通内核，二者互不重复
 * （前者是 ErrorUtils 全局钩子，后者是用户传入的订阅函数）。
 */
import { PLATFORM_NAME } from './constants.js'
import { buildUserAgent } from './device.js'
import { guard, reportInternalError } from './guard.js'
import { isFunction } from './runtime.js'

/**
 * 构建 RN 适配器。
 * @param {{
 *   core: { createReactNativeAdapter?: Function },
 *   runtime?: object,
 *   caps?: object,
 *   storage?: { getStorage: Function, setStorage: Function, kind: string, degraded: boolean },
 *   device?: object,
 *   diagnostics?: { emit?: Function } | null
 * }} options
 * @returns {import('../../sdk/platform.d.ts').PlatformAdapter}
 */
export function buildRnAdapter(options = {}) {
  const core = options.core || {}
  const runtime = options.runtime || {}
  const caps = options.caps || {}
  const storage = options.storage || null
  const device = options.device || {}
  const diagnostics = options.diagnostics || null

  let base = {}
  if (isFunction(core.createReactNativeAdapter)) {
    try {
      base = core.createReactNativeAdapter(runtime) || {}
    } catch (error) {
      // 内核适配器构造失败（例如无 fetch）时退回自建 request，保证适配器形态完整。
      reportInternalError('adapter', error, diagnostics)
      base = {}
    }
  }

  const fetchImpl = caps.fetch || runtime.fetch
  const userAgent = buildUserAgent(device)

  /** 构造 request：优先内核适配器的实现，缺失时用探测到的 fetch 自建。 */
  const request = isFunction(base.request)
    ? base.request
    : async function rnRequest({ url, method = 'POST', headers = {}, data = null } = {}) {
      if (!isFunction(fetchImpl)) return { statusCode: 0 }
      return fetchImpl(url, { method, headers, body: JSON.stringify(data) })
    }

  /** 上下文：url 置空（移动端无 URL 语义），path 取当前路由，userAgent 用合成串。 */
  const getContext = guard(() => {
    const injected = isFunction(caps.getContext)
      ? (() => {
        try { return caps.getContext() || {} } catch { return {} }
      })()
      : {}
    const path = typeof injected.path === 'string' ? injected.path : (typeof runtime.routeName === 'string' ? runtime.routeName : '')
    return {
      url: '',
      path,
      title: typeof injected.title === 'string' ? injected.title : '',
      referrer: '',
      network: typeof injected.network === 'string' ? injected.network : undefined,
      userAgent: injected.userAgent || userAgent
    }
  }, 'adapter.getContext', diagnostics)

  return {
    name: PLATFORM_NAME,
    rawRequest: base.rawRequest ?? null,
    request,
    getStorage: storage && isFunction(storage.getStorage) ? key => storage.getStorage(key) : undefined,
    setStorage: storage && isFunction(storage.setStorage) ? (key, value) => storage.setStorage(key, value) : undefined,
    getContext,
    // 用户自注册监听器直通内核（缺失时内核静默跳过，core.js:544-548）
    onError: isFunction(runtime.onError) ? runtime.onError : undefined,
    onUnhandledRejection: isFunction(runtime.onUnhandledRejection) ? runtime.onUnhandledRejection : undefined,
    onNetworkStatusChange: isFunction(runtime.onNetworkStatusChange) ? runtime.onNetworkStatusChange : undefined,
    onNavigationStateChange: isFunction(runtime.onNavigationStateChange) ? runtime.onNavigationStateChange : undefined,
    // 能力位：内核基线 + RN 扩展键（纯声明，不改 platform.d.ts）
    capabilities: {
      ...(base.capabilities && typeof base.capabilities === 'object' ? base.capabilities : {}),
      storage: Boolean(storage && storage.kind === 'async'),
      appState: Boolean(caps.appState),
      frameStats: Boolean(caps.frameSource),
      jsCrash: Boolean(caps.errorUtils),
      nativeCrash: Boolean(caps.nativeCrash),
      deviceInfo: Boolean(device && (device.model || device.systemName)),
      networkStatus: Boolean(caps.netInfo) || Boolean(base.capabilities?.networkStatus)
    }
  }
}
