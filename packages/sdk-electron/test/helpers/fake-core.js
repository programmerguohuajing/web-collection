/**
 * @file 测试用假平台内核：createPlatformEys 返回记录型 client（形状对齐真实内核 API 面）。
 * makeCore() 每次返回独立 core 实例并自带 client 引用 —— node:test 子测试并发下互不串扰。
 */

export function createFakePlatformClient(cfg, adapter) {
  const calls = {
    track: [],
    error: [],
    metric: [],
    behavior: [],
    flush: [],
    setContext: [],
    destroyCount: 0,
    config: cfg,
    adapter
  }
  const noop = () => {}
  return {
    calls,
    track: (name, props = {}) => calls.track.push({ name, props }),
    error: (reason, extra = {}) => calls.error.push({ reason, extra }),
    metric: (name, value, props = {}) => calls.metric.push({ name, value, props }),
    behavior: (name, props = {}) => calls.behavior.push({ name, props }),
    flush: (force = false) => calls.flush.push({ force }),
    setContext: (context = {}) => calls.setContext.push(context),
    destroy: () => { calls.destroyCount++ },
    setConsent: noop,
    setEnabled: noop,
    addBreadcrumb: noop,
    setUser: noop,
    pageView: noop,
    pageLeave: noop,
    startTransaction: () => ({ setData: noop, finish: noop }),
    markPageReady: noop,
    wrapRequest: request => request,
    wrapFetch: fetchImpl => fetchImpl,
    instrumentApp: value => value,
    instrumentPage: value => value,
    getPrivacyMode: () => 'balanced',
    getConsentCategories: () => ({}),
    getSamplingDecision: () => null,
    getCapabilities: () => ({ ...(adapter?.capabilities || {}) }),
    identify: noop,
    getAnonymousId: () => 'device-123'
  }
}

/**
 * 创建独立内核实例：core.__client 为 createPlatformEys 创建的记录型 client。
 * @returns {{ createPlatformEys: Function, __client: object | null }}
 */
export function makeCore() {
  const core = {
    __client: null,
    createPlatformEys(cfg, adapter) {
      core.__client = createFakePlatformClient(cfg, adapter)
      return core.__client
    }
  }
  return core
}
