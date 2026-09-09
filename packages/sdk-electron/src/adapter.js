/**
 * @file 主进程平台适配器：对接内核 PlatformAdapter 契约
 *
 * 契约（对齐 packages/sdk/src/platform/adapters.js 的 createReactNativeAdapter）：
 *   request({ url, method, headers, data }) → Promise<{ status | statusCode }>
 *   getStorage(key) / setStorage(key, value) —— 由注入的 sync storage 异步适配
 *   getContext() → { path, url, title, referrer, userAgent }
 *   onError / onUnhandledRejection —— 由注入的主进程错误钩子桥接（内核自动注册）
 *   capabilities —— 能力位声明（P1-4）：主进程无 DOM/回放/曝光，有存储。
 *
 * @param {object} runtime 依赖注入的运行时（见 factory.js；electron 对象绝不在本包 import）
 */
export function createElectronAdapter(runtime = {}) {
  const fetchImpl = runtime.fetch || globalThis.fetch
  if (!fetchImpl) throw new Error('Web Collection: Electron main-process fetch is required (Electron >= 22 / Node >= 18)')
  const storage = runtime.storage
  return {
    name: 'electron',
    rawRequest: null,
    request: async ({ url, method, headers, data }) => fetchImpl(url, { method, headers, body: JSON.stringify(data) }),
    ...(runtime.asyncStorage || {}),
    getContext: runtime.getContext || (() => ({ path: '', url: '', title: '', referrer: '', userAgent: 'Electron' })),
    onError: runtime.onError,
    onUnhandledRejection: runtime.onUnhandledRejection,
    // 能力位声明（P1-4）：主进程无 DOM / 曝光 / 回放 / Beacon / 导航；存储取决于注入。
    capabilities: {
      dom: false,
      exposure: false,
      replay: false,
      networkStatus: typeof runtime.onNetworkStatusChange === 'function',
      navigation: false,
      storage: typeof storage?.get === 'function' || typeof runtime.asyncStorage?.getStorage === 'function',
      beacon: false,
      visibility: false
    }
  }
}
