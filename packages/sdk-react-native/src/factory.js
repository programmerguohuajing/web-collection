/**
 * @file 内核装配层（T02 · createReactNativeEysWithCore）
 *
 * 职责：把「RN 宿主能力探测 → 配置归一化 → 存储/会话 → 设备维度 → 适配器 → 内核 createPlatformEys」
 * 串成一条装配链，并挂载 RN 扩展采集模块（生命周期 / 崩溃 / 冷启动 / 帧率 / 网络），
 * 最终返回 ReactNativeEysClient。
 *
 * 设计要点：
 * - `core` 作为第三参注入（测试友好，可传 fake core；真实运行时由 index.js 注入内核平台模块）。
 * - 全程 safe() / guard() 包裹，**公开 API 与采集回调永不向上抛**（RN 红线：未捕获异常 = 宿主红屏）。
 * - 内核不可用 / fetch 全缺 → 返回 noop 客户端 + core_missing 诊断（架构 §6-L1）。
 * - 会话 ID 覆盖为契约外手法：经 config.wrapBeforeSend 在 beforeSend 后置注入 session.currentId()。
 */
import { DIAGNOSTIC } from './constants.js'
import { createDiagnostics, safe } from './guard.js'
import { detect } from './runtime.js'
import { normalizeOptions, wrapBeforeSend } from './config.js'
import { createStorageAdapter } from './storage.js'
import { createSessionManager } from './session.js'
import { buildRnAdapter } from './adapter.js'
import { buildDeviceContext, applyDeviceContext } from './device.js'
import { createLifecycleInstrumentor } from './lifecycle.js'
import { createCrashMonitor } from './crash.js'
import { createColdStartCollector } from './metrics/cold-start.js'
import { createFrameStatsCollector } from './metrics/frame-stats.js'
import { createNetworkInstrumentor } from './metrics/network.js'

const NOOP = () => {}

/** 构造 noop 客户端（内核缺失 / fetch 缺失时返回，所有方法安全空实现）。 */
function createNoopClient(diagnostics) {
  const client = {
    track: NOOP,
    error: NOOP,
    metric: NOOP,
    behavior: NOOP,
    setConsent: NOOP,
    setEnabled: NOOP,
    setContext: NOOP,
    addBreadcrumb: NOOP,
    startTransaction: NOOP,
    pageView: NOOP,
    pageLeave: NOOP,
    markPageReady: NOOP,
    setUser: NOOP,
    flush: () => Promise.resolve(),
    destroy: NOOP,
    wrapRequest: (impl) => impl,
    wrapFetch: (impl) => impl,
    instrumentApp: NOOP,
    instrumentPage: NOOP,
    getPrivacyMode: () => 'balanced',
    getConsentCategories: () => ({}),
    getSamplingDecision: () => null,
    getCapabilities: () => ({}),
    identify: NOOP,
    getAnonymousId: () => '',
    // RN 扩展 noop
    markAppReady: () => false,
    reportNativeCrash: () => false,
    start: NOOP,
    stop: NOOP
  }
  return client
}

/**
 * 装配 React Native 客户端（可注入内核，测试友好）。
 * @param {object} [options={}] 用户选项（与 normalizeOptions 同口径）
 * @param {object} [runtime={}] 宿主能力注入对象
 * @param {object | null} [core=null] 内核平台模块（须含 createPlatformEys / createReactNativeAdapter）
 * @param {number} [moduleInitTs=Date.now()] 模块求值时刻（冷启动参考点）
 * @returns {import('./index.js').ReactNativeEysClient}
 */
export function createReactNativeEysWithCore(options = {}, runtime = {}, core = null, moduleInitTs = Date.now()) {
  const opts = options && typeof options === 'object' ? options : {}
  const diagnostics = createDiagnostics(typeof opts.onDiagnostic === 'function' ? opts.onDiagnostic : null)

  // 能力探测（注入优先，其次全局探测）。
  const caps = detect(runtime, globalThis)

  // 内核可用性判定（架构 §6-L1）。
  if (!core || typeof core.createPlatformEys !== 'function') {
    diagnostics.emit(DIAGNOSTIC.CORE_MISSING, { reason: 'createPlatformEys_missing' })
    return createNoopClient(diagnostics)
  }
  if (typeof caps.fetch !== 'function') {
    diagnostics.emit(DIAGNOSTIC.CORE_MISSING, { reason: 'fetch_missing' })
    return createNoopClient(diagnostics)
  }

  // 配置归一化。
  const cfg = normalizeOptions(opts, diagnostics)

  // 会话管理（后台超时切分），先于 beforeSend 包装。
  const session = createSessionManager({ timeoutMs: cfg.sessionTimeoutMs })
  cfg.beforeSend = wrapBeforeSend(cfg.beforeSend, session, diagnostics)

  // 存储 / 设备 / 适配器。
  const storage = createStorageAdapter(runtime && runtime.storage ? runtime.storage : null, diagnostics)
  const device = buildDeviceContext(caps, cfg)
  const adapter = buildRnAdapter({ core, runtime, caps, storage, device, diagnostics })

  // 内核客户端（异常降级为 noop）。
  let client = null
  try {
    client = core.createPlatformEys(cfg, adapter)
  } catch (error) {
    diagnostics.emit(DIAGNOSTIC.CORE_MISSING, { reason: 'createPlatformEys_threw' })
    return createNoopClient(diagnostics)
  }
  if (!client || typeof client.behavior !== 'function') {
    diagnostics.emit(DIAGNOSTIC.CORE_MISSING, { reason: 'client_invalid' })
    return createNoopClient(diagnostics)
  }

  // 写入设备维度上下文（随每个事件上报）。
  applyDeviceContext(client, device)

  // 采集模块装配。
  const lifecycle = createLifecycleInstrumentor({
    behavior: client.behavior,
    flush: client.flush,
    session,
    timeoutMs: cfg.sessionTimeoutMs,
    diagnostics
  })
  const crash = createCrashMonitor({ error: client.error, crash: cfg.crash, diagnostics })
  const coldStart = createColdStartCollector({
    metric: client.metric,
    moduleInitTs,
    timeoutMs: cfg.coldStartTimeoutMs,
    enabled: cfg.coldStart.enabled,
    diagnostics
  })
  const frameStats = createFrameStatsCollector({
    metric: client.metric,
    sampleWindowMs: cfg.frameStats.sampleWindowMs,
    reportIntervalMs: cfg.frameStats.reportIntervalMs,
    fpsTarget: cfg.frameStats.fpsTarget,
    longTaskThresholdMs: cfg.frameStats.longTaskThresholdMs,
    enabled: cfg.frameStats.enabled,
    diagnostics
  })
  const network = createNetworkInstrumentor({
    wrapFetch: client.wrapFetch,
    autoWrap: cfg.network.autoWrapGlobalFetch,
    netInfo: caps.netInfo,
    getContext: caps.getContext,
    setContext: client.setContext,
    behavior: client.behavior,
    diagnostics
  })

  // 生命周期管理（start/stop/destroy 全量清理，L5）。
  let stopFrame = null
  let stopNetwork = null

  const start = safe(function startAll() {
    safe(() => lifecycle.install(caps.appState), null, 'factory.lifecycle.install', diagnostics)()
    safe(() => crash.install(caps), null, 'factory.crash.install', diagnostics)()
    safe(() => lifecycle.emitAppStart(true), null, 'factory.appStart', diagnostics)()
    stopFrame = safe(() => frameStats.start(caps.frameSource), null, 'factory.frameStats', diagnostics)() || null
    stopNetwork = safe(() => network.install(caps.netInfo), null, 'factory.network', diagnostics)() || null
    // 冷启动：注册首帧回调与超时兜底（markAppReady 由业务显式校正）。
    safe(() => coldStart.start(caps.frameSource), null, 'factory.coldStart', diagnostics)()
  }, undefined, 'factory.start', diagnostics)

  const stop = safe(function stopAll() {
    safe(() => lifecycle.dispose(), null, 'factory.lifecycle.dispose', diagnostics)()
    safe(() => coldStart.dispose(), null, 'factory.coldStart.dispose', diagnostics)()
    if (typeof stopFrame === 'function') safe(stopFrame, null, 'factory.frameStats.dispose', diagnostics)()
    safe(() => crash.dispose(), null, 'factory.crash.dispose', diagnostics)()
    if (typeof stopNetwork === 'function') safe(stopNetwork, null, 'factory.network.dispose', diagnostics)()
  }, undefined, 'factory.stop', diagnostics)

  const destroy = safe(function destroyAll() {
    stop()
    safe(() => client.destroy(), null, 'factory.destroy', diagnostics)()
  }, undefined, 'factory.destroy', diagnostics)

  // 内核方法安全代理（统一 guard，异常不向上抛）。
  const px = (fn, label, fallback) => safe(fn, fallback, `client.${label}`, diagnostics)

  const rnClient = {
    // ---- 内核直通 ----
    track: px((n, p) => client.track(n, p), 'track'),
    error: px((r, e) => client.error(r, e), 'error'),
    metric: px((n, v, p) => client.metric(n, v, p), 'metric'),
    behavior: px((n, p) => client.behavior(n, p), 'behavior'),
    setConsent: px((s) => client.setConsent(s), 'setConsent'),
    setEnabled: px((e) => client.setEnabled(e), 'setEnabled'),
    setContext: px((c) => client.setContext(c), 'setContext'),
    addBreadcrumb: px((c) => client.addBreadcrumb(c), 'addBreadcrumb'),
    startTransaction: px((n, o) => client.startTransaction(n, o), 'startTransaction'),
    pageView: px((p, o) => client.pageView(p, o), 'pageView'),
    pageLeave: px((p, o) => client.pageLeave(p, o), 'pageLeave'),
    markPageReady: px(() => client.markPageReady(), 'markPageReady'),
    setUser: px((u) => client.setUser(u), 'setUser'),
    flush: px((f) => client.flush(f), undefined, 'flush'),
    wrapRequest: px((i) => client.wrapRequest(i), 'wrapRequest', i => i),
    wrapFetch: (impl) => network.wrap(impl),
    instrumentApp: px((o) => client.instrumentApp(o), 'instrumentApp'),
    instrumentPage: px((o) => client.instrumentPage(o), 'instrumentPage'),
    getPrivacyMode: () => safe(() => client.getPrivacyMode(), 'balanced', 'client.getPrivacyMode', diagnostics)(),
    getConsentCategories: () => safe(() => client.getConsentCategories(), {}, 'client.getConsentCategories', diagnostics)(),
    getSamplingDecision: () => safe(() => client.getSamplingDecision(), null, 'client.getSamplingDecision', diagnostics)(),
    getCapabilities: () => safe(() => client.getCapabilities(), {}, 'client.getCapabilities', diagnostics)(),
    identify: px((id, t) => client.identify(id, t), 'identify'),
    getAnonymousId: () => safe(() => client.getAnonymousId(), '', 'client.getAnonymousId', diagnostics)(),
    // ---- RN 扩展 ----
    markAppReady: () => coldStart.markAppReady(),
    reportNativeCrash: (payload) => crash.reportNativeCrash(payload),
    start,
    stop,
    destroy
  }

  return rnClient
}

export { createNoopClient }
