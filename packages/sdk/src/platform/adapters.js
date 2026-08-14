/**
 * @file 平台适配器集合
 * 为不同宿主环境（微信/支付宝/抖音/百度/QQ/快手/京东小程序、UniApp、Taro、React Native）
 * 提供统一的 PlatformAdapter 接口实现。
 */

/**
 * 创建小程序平台适配器（微信/支付宝/抖音/百度/QQ/快手/京东通用）
 * 自动检测平台 API 并封装 request、storage、context、错误监听等能力
 * @param {object} [api] - 平台 API 对象（wx/my/tt/swan/qq/ks/jd），不传时自动检测
 * @returns {import('../../platform.d.ts').PlatformAdapter}
 */
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
    onNetworkStatusChange: listener => subscribe(api, 'onNetworkStatusChange', 'offNetworkStatusChange', listener),
    // 能力位声明（P1-4）：小程序无 DOM / 曝光 / 回放 / Beacon，但具备网络状态与存储。
    capabilities: {
      dom: false,
      exposure: false,
      replay: false,
      networkStatus: typeof api.onNetworkStatusChange === 'function',
      navigation: false,
      storage: typeof api.getStorageSync === 'function',
      beacon: false,
      visibility: false
    }
  }
}

/** UniApp 适配器（复用小程序适配器，uni 对象提供了兼容的 API） */
export function createUniAppAdapter(api = globalThis.uni) {
  return createMiniProgramAdapter(api)
}

/** Taro 适配器（复用小程序适配器） */
export function createTaroAdapter(api) {
  return createMiniProgramAdapter(api)
}

/**
 * React Native 适配器
 * 使用 fetch 作为网络层，AsyncStorage 作为存储层
 * @param {object} [runtime={}] - React Native 运行时对象
 */
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
    onNavigationStateChange: runtime.onNavigationStateChange,
    // 能力位声明（P1-4）：RN 无 DOM / 曝光 / 回放 / Beacon；网络/导航/存储取决于运行时注入。
    capabilities: {
      dom: false,
      exposure: false,
      replay: false,
      networkStatus: typeof runtime.onNetworkStatusChange === 'function',
      navigation: typeof runtime.onNavigationStateChange === 'function',
      storage: typeof storage?.getItem === 'function',
      beacon: false,
      visibility: false
    }
  }
}

/**
 * 自动检测当前小程序平台 API
 * 按顺序尝试 wx（微信）→ my（支付宝）→ tt（抖音）→ swan（百度）→ qq → ks（快手）→ jd（京东）
 * @returns {object | undefined}
 */
export function detectMiniProgramApi() {
  return globalThis.wx || globalThis.my || globalThis.tt || globalThis.swan || globalThis.qq || globalThis.ks || globalThis.jd
}

/**
 * 将小程序 callback 风格的 request 包装为 Promise
 * 小程序 request 使用 success/fail 回调，此处统一转为 Promise 接口
 */
function callbackRequest(api, options) {
  return new Promise((resolve, reject) => {
    api.request({
      ...options,
      header: options.headers,  // 小程序统一使用 header 而非 headers
      success: resolve,
      fail: reject
    })
  })
}

/**
 * 获取小程序页面上下文（路径、标题、UserAgent）
 * 通过 getCurrentPages 获取当前页面栈，取最后一个即为当前页面
 */
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

/**
 * 根据 API 对象反查平台名称
 * 通过对比全局存储的各平台对象引用，判断当前运行环境
 */
function detectName(api) {
  const pairs = [['wx', globalThis.wx], ['alipay', globalThis.my], ['douyin', globalThis.tt], ['baidu', globalThis.swan], ['qq', globalThis.qq], ['kuaishou', globalThis.ks], ['jd', globalThis.jd], ['uni-app', globalThis.uni]]
  return pairs.find(([, value]) => value === api)?.[0] || 'mini-program'
}

/**
 * 订阅平台事件（如 onError / onNetworkStatusChange）
 * 返回取消订阅函数，符合 cleanup 模式
 * @param {object} api          - 平台 API 对象
 * @param {string} on           - 订阅方法名（如 onError）
 * @param {string} off          - 取消订阅方法名（如 offError）
 * @param {Function} listener   - 回调函数
 * @returns {Function | undefined} 取消订阅的函数
 */
function subscribe(api, on, off, listener) {
  if (typeof api[on] !== 'function') return undefined
  api[on](listener)
  return () => api[off]?.(listener)
}

/** 解析存储值：若为 JSON 字符串则反序列化，否则原样返回 */
function parseStored(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

/** 平台无关的同步读存储（兼容支付宝 getStorageSync({ key }) 的参数差异） */
function getStorage(api, key) {
  if (!api.getStorageSync) return undefined
  if (api === globalThis.my) return api.getStorageSync({ key })?.data
  return api.getStorageSync(key)
}

/** 平台无关的同步写存储（兼容支付宝 setStorageSync({ key, data }) 的参数差异） */
function setStorage(api, key, data) {
  if (!api.setStorageSync) return undefined
  if (api === globalThis.my) return api.setStorageSync({ key, data })
  return api.setStorageSync(key, data)
}
