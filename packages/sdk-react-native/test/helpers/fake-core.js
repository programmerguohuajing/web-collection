/**
 * @file Fake kernel core（测试用，零构建依赖）
 *
 * 实现 { createPlatformEys, createReactNativeAdapter }，记录 metric/behavior/error/track
 * 等调用与参数，供断言 RN 层事件「形状与时机」。真实内核契约由 contract.test.js 另测。
 */
export const recorded = { client: null }

/** 创建假内核客户端（记录调用）。 */
export function createPlatformEys(cfg = {}, adapter = {}) {
  const calls = {
    track: [],
    error: [],
    metric: [],
    behavior: [],
    pageView: [],
    pageLeave: [],
    flush: 0,
    setContext: [],
    wrapFetch: 0,
    destroy: 0
  }
  const client = {
    track: (n, p) => calls.track.push({ n, p }),
    error: (r, e) => calls.error.push({ r, e }),
    metric: (name, value, p) => calls.metric.push({ name, value, props: p }),
    behavior: (name, p) => calls.behavior.push({ name, props: p }),
    pageView: (p, o) => calls.pageView.push({ p, o }),
    pageLeave: (p, o) => calls.pageLeave.push({ p, o }),
    setContext: (c) => calls.setContext.push(c),
    flush: () => {
      calls.flush += 1
      return Promise.resolve()
    },
    destroy: () => {
      calls.destroy += 1
    },
    wrapFetch: () => {
      calls.wrapFetch += 1
      return (impl) => impl || globalThis.fetch
    },
    wrapRequest: (impl) => impl,
    setConsent: () => {},
    setEnabled: () => {},
    addBreadcrumb: () => {},
    startTransaction: () => {},
    markPageReady: () => {},
    setUser: () => {},
    instrumentApp: () => {},
    instrumentPage: () => {},
    getPrivacyMode: () => 'balanced',
    getConsentCategories: () => ({}),
    getSamplingDecision: () => null,
    getCapabilities: () => (adapter && adapter.capabilities) || {},
    identify: () => {},
    getAnonymousId: () => 'anon'
  }
  client.__calls = calls
  recorded.client = client
  return client
}

/** 假 RN 适配器（供 buildRnAdapter 内部调用，验证扩展路径）。 */
export function createReactNativeAdapter(runtime = {}) {
  return {
    name: 'react-native-fake',
    capabilities: { storage: Boolean(runtime.storage) },
    request: async () => ({ statusCode: 200 }),
    getContext: () => ({}),
    getStorage: runtime.storage ? runtime.storage.getItem : undefined,
    setStorage: runtime.storage ? runtime.storage.setItem : undefined
  }
}
