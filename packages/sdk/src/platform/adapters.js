export function createMiniProgramAdapter(api = detectMiniProgramApi()) {
  if (!api?.request) throw new Error('Web Collection: unsupported mini program runtime')
  const name = detectName(api)
  return {
    name,
    rawRequest: api.request.bind(api),
    request: options => callbackRequest(api, options),
    getStorage: key => getStorage(api, key),
    setStorage: (key, data) => setStorage(api, key, data),
    getContext: () => miniContext(api, name),
    onError: listener => subscribe(api, 'onError', 'offError', listener),
    onUnhandledRejection: listener => subscribe(api, 'onUnhandledRejection', 'offUnhandledRejection', listener),
    onNetworkStatusChange: listener => subscribe(api, 'onNetworkStatusChange', 'offNetworkStatusChange', listener)
  }
}

export function createUniAppAdapter(api = globalThis.uni) {
  return createMiniProgramAdapter(api)
}

export function createTaroAdapter(api) {
  return createMiniProgramAdapter(api)
}

export function createReactNativeAdapter(runtime = {}) {
  const fetchImpl = runtime.fetch || globalThis.fetch
  if (!fetchImpl) throw new Error('Web Collection: React Native fetch is required')
  const storage = runtime.storage
  return {
    name: 'react-native',
    rawRequest: null,
    request: async ({ url, method, headers, data }) => fetchImpl(url, { method, headers, body: JSON.stringify(data) }),
    getStorage: key => storage?.getItem(key).then(parseStored),
    setStorage: (key, value) => storage?.setItem(key, JSON.stringify(value)),
    getContext: runtime.getContext || (() => ({ path: runtime.routeName || '', userAgent: `ReactNative/${runtime.version || 'unknown'}` })),
    onError: runtime.onError,
    onUnhandledRejection: runtime.onUnhandledRejection,
    onNetworkStatusChange: runtime.onNetworkStatusChange,
    onNavigationStateChange: runtime.onNavigationStateChange
  }
}

export function detectMiniProgramApi() {
  return globalThis.wx || globalThis.my || globalThis.tt || globalThis.swan || globalThis.qq || globalThis.ks || globalThis.jd
}

function callbackRequest(api, options) {
  return new Promise((resolve, reject) => {
    api.request({
      ...options,
      header: options.headers,
      success: resolve,
      fail: reject
    })
  })
}

function miniContext(api, name) {
  const pages = globalThis.getCurrentPages?.() || []
  const page = pages[pages.length - 1]
  const system = api.getSystemInfoSync?.() || {}
  const path = page?.route || page?.$page?.fullPath || ''
  return {
    path,
    url: path,
    title: page?.data?.navigationBarTitleText || '',
    userAgent: `${name}/${system.version || system.SDKVersion || 'unknown'} ${system.system || system.platform || ''} ${system.model || ''}`.trim()
  }
}

function detectName(api) {
  const pairs = [['wx', globalThis.wx], ['alipay', globalThis.my], ['douyin', globalThis.tt], ['baidu', globalThis.swan], ['qq', globalThis.qq], ['kuaishou', globalThis.ks], ['jd', globalThis.jd], ['uni-app', globalThis.uni]]
  return pairs.find(([, value]) => value === api)?.[0] || 'mini-program'
}

function subscribe(api, on, off, listener) {
  if (typeof api[on] !== 'function') return undefined
  api[on](listener)
  return () => api[off]?.(listener)
}

function parseStored(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function getStorage(api, key) {
  if (!api.getStorageSync) return undefined
  if (api === globalThis.my) return api.getStorageSync({ key })?.data
  return api.getStorageSync(key)
}

function setStorage(api, key, data) {
  if (!api.setStorageSync) return undefined
  if (api === globalThis.my) return api.setStorageSync({ key, data })
  return api.setStorageSync(key, data)
}
