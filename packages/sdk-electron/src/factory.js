/**
 * @file 组装工厂：依赖注入的运行时 + 平台内核 → Electron 客户端
 *
 * 与 RN 包（packages/sdk-react-native/src/factory.js）同构：
 *   - 内核经参数注入（core），便于单测与「内核缺失静默降级 noop」；
 *   - 所有插桩器挂载/卸载统一管理；公开 API 永不向宿主抛错（红线）；
 *   - electron 对象（app / process / ipcMain / webContents）全部经 runtime 注入。
 */
import { DIAGNOSTIC } from './constants.js'
import { createDiagnostics, guard, safe } from './guard.js'
import { createElectronAdapter } from './adapter.js'
import { createAsyncStorageAdapter } from './storage.js'
import { buildDeviceContext } from './device.js'
import { createLifecycleInstrumentor } from './lifecycle.js'
import { createCrashMonitor, attachRendererWatchdog } from './crash.js'

/** 内核 client 透传到 Electron 客户端的方法面 */
const KERNEL_PASSTHROUGH = [
  'track', 'error', 'metric', 'behavior', 'pageView', 'pageLeave',
  'setConsent', 'setEnabled', 'setContext', 'addBreadcrumb', 'setUser',
  'startTransaction', 'markPageReady', 'flush', 'destroy',
  'wrapRequest', 'wrapFetch', 'instrumentApp', 'instrumentPage',
  'getPrivacyMode', 'getConsentCategories', 'getSamplingDecision',
  'getCapabilities', 'identify', 'getAnonymousId'
]

/**
 * 创建 Electron SDK 客户端（内核注入版，测试入口）
 * @param {object} [options={}]  内核 createPlatformEys 配置（endpoint/appId/release/采样等原样透传）
 * @param {object} [runtime={}]  Electron 运行时（依赖注入）：
 *   - fetch                     主进程 fetch（缺省回落 globalThis.fetch）
 *   - storage                   同步存储 { get(key), set(key, value) }（推荐 createJsonFileStorage）
 *   - app                       Electron app 对象（生命周期插桩）
 *   - nodeProcess               主进程 process（崩溃监控；缺省 globalThis.process）
 *   - getContext                自定义上下文（缺省静态 Electron UA）
 *   - onError / onUnhandledRejection  主进程错误钩子（缺省由 crash 模块自动接管 process 事件）
 *   - autoLifecycle / autoCrash 自动挂载开关（默认 true；false 后由 client.start() 手动挂载）
 *   - webContents               单个/数组 webContents（渲染进程看门狗）
 *   - processUptimeMs           冷启动耗时来源（缺省 process.uptime()*1000）
 *   - electronVersion / appVersion   设备上下文覆盖项
 * @param {object} [core=null]   平台内核（import('@web-collection/sdk/platform')）
 * @param {number} [moduleInitTs=Date.now()] 模块加载时间（预留冷启动兜底）
 * @returns {object} Electron 客户端（内核 API 透传 + start/dispose）
 */
export function createElectronEysWithCore(options = {}, runtime = {}, core = null, moduleInitTs = Date.now()) {
  const diagnostics = createDiagnostics(options.onDiagnostic || runtime.onDiagnostic)
  if (!core || typeof core.createPlatformEys !== 'function') {
    diagnostics.emit(DIAGNOSTIC.CORE_MISSING, { package: '@web-collection/sdk-electron' })
    return createNoopClient(diagnostics)
  }
  const fetchImpl = runtime.fetch || globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    diagnostics.emit(DIAGNOSTIC.FETCH_MISSING, { hint: 'Electron >= 22 main process provides global fetch' })
    return createNoopClient(diagnostics)
  }

  try {
    const asyncStorage = createAsyncStorageAdapter(runtime.storage)
    const adapter = createElectronAdapter({ ...runtime, fetch: fetchImpl, asyncStorage })
    const client = core.createPlatformEys({ ...options }, adapter)
    const deviceContext = safe(() => buildDeviceContext(runtime), {}, 'device', diagnostics)()
    safe(() => client.setContext?.(deviceContext), undefined, 'setContext', diagnostics)()

    // 主进程错误钩子：宿主未注入时由崩溃监控直接接管 process 事件（避免重复注册见 runtime.onError 判空）。
    const lifecycle = createLifecycleInstrumentor({
      app: runtime.app,
      client,
      diagnostics,
      deviceContext,
      processUptimeMs: runtime.processUptimeMs
    })
    const crash = createCrashMonitor({ nodeProcess: runtime.nodeProcess, client, diagnostics })
    const rendererDispose = attachRendererWatchdogs(runtime, client, diagnostics)

    if (runtime.autoLifecycle !== false) lifecycle.install()
    if (runtime.autoCrash !== false) crash.install()

    const electronClient = { ...client }
    for (const key of KERNEL_PASSTHROUGH) {
      if (typeof client?.[key] === 'function') electronClient[key] = (...args) => client[key](...args)
    }
    electronClient.__eysElectron = { adapter, lifecycle, crash, deviceContext }
    let disposed = false
    /** 手动挂载插桩（autoLifecycle/autoCrash=false 时使用；幂等） */
    electronClient.start = guard(() => {
      lifecycle.install()
      crash.install()
    }, 'start', diagnostics)
    /** 卸载插桩并销毁内核 client（退出前调用；幂等——重复调用为空操作） */
    electronClient.dispose = guard(() => {
      if (disposed) return
      disposed = true
      lifecycle.dispose()
      crash.dispose()
      rendererDispose()
      try { client.destroy?.() } catch { /* destroy 内部已兜底 */ }
    }, 'dispose', diagnostics)
    return electronClient
  } catch (error) {
    diagnostics.emit(DIAGNOSTIC.SDK_INTERNAL_ERROR, { module: 'factory', reason: error instanceof Error ? error.name : 'Error' })
    return createNoopClient(diagnostics)
  }
}

/**
 * 渲染进程看门狗批量挂载：支持 runtime.webContents（单个/数组）与
 * getAllWebContents()（即时快照）两种注入形态；返回统一卸载函数。
 */
function attachRendererWatchdogs(runtime, client, diagnostics) {
  const disposers = []
  const attach = safe((wc) => {
    const dispose = attachRendererWatchdog(wc, client, diagnostics)
    if (typeof dispose === 'function') disposers.push(dispose)
  }, undefined, 'renderer-watchdog', diagnostics)
  const list = safe(() => {
    if (runtime.webContents) return Array.isArray(runtime.webContents) ? runtime.webContents : [runtime.webContents]
    if (typeof runtime.getAllWebContents === 'function') return runtime.getAllWebContents() || []
    return []
  }, [], 'renderer-watchdog', diagnostics)()
  ;(list || []).forEach(attach)
  return () => disposers.splice(0).forEach(dispose => dispose?.())
}

/**
 * noop 客户端：内核/fetch 缺失时的静默降级形态（API 面与真实客户端一致，全部空操作）。
 */
function createNoopClient(diagnostics) {
  const noop = () => {}
  const client = {
    track: noop, error: noop, metric: noop, behavior: noop, pageView: noop, pageLeave: noop,
    setConsent: noop, setEnabled: noop, setContext: noop, addBreadcrumb: noop, setUser: noop,
    startTransaction: () => ({ setData: noop, finish: noop }),
    markPageReady: noop, flush: noop, destroy: noop,
    wrapRequest: (request) => (typeof request === 'function' ? request : noop),
    wrapFetch: (fetchImpl) => (typeof fetchImpl === 'function' ? fetchImpl : noop),
    instrumentApp: (value) => value, instrumentPage: (value) => value,
    getPrivacyMode: () => 'balanced',
    getConsentCategories: () => ({ essential: true, performance: true, analytics: true, replay: true, diagnostics: true }),
    getSamplingDecision: () => null,
    getCapabilities: () => ({}),
    identify: noop, getAnonymousId: () => '',
    start: noop, dispose: noop
  }
  client.__eysElectron = { degraded: true, diagnostics }
  return client
}
