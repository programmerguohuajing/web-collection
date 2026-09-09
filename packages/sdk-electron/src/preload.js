/**
 * @file 渲染进程 / preload 入口：IPC 传输适配器 + 桥接暴露（本文件不 import 平台内核，可独立单测）
 *
 * 渲染进程两条路线（详见 README）：
 *   A. 直连模式（推荐，renderer 加载 http(s)）：渲染进程直接用 @web-collection/sdk Web 版，
 *      DOM/性能/错误/回放全能力，本文件不参与。
 *   B. 桥接模式（renderer 加载 file:// 或需统一走主进程出口）：
 *      preload 中调用 exposeEysBridge()；渲染进程用平台内核组装：
 *        import { createPlatformEys } from '@web-collection/sdk/platform'
 *        import { createElectronIpcAdapter } from '@web-collection/sdk-electron/preload'
 *        const eys = createPlatformEys(options, createElectronIpcAdapter({ ipcRenderer }))
 *      事件经 IPC 发到主进程 attachIpcSink() 代理上报（凭据不出主进程）。
 *
 * ⚠️ preload 上下文注意：contextIsolation 开启时，不要把 ipcRenderer 本体暴露给页面；
 *    只暴露 send 最小能力（见 exposeEysBridge），或在 preload 内组装 adapter 后仅暴露纯数据接口。
 */
import { DEFAULT_IPC_CHANNEL } from './constants.js'

/**
 * 创建渲染进程 IPC 平台适配器（对接内核 PlatformAdapter 契约）
 * @param {object} options
 * @param {object} options.ipcRenderer Electron ipcRenderer 对象（依赖注入，不 import）
 * @param {string} [options.channel]   IPC 通道名（须与主进程 attachIpcSink 一致）
 * @returns {object} PlatformAdapter（name='electron-renderer'）
 */
export function createElectronIpcAdapter(options = {}) {
  const ipcRenderer = options.ipcRenderer
  const channel = options.channel || DEFAULT_IPC_CHANNEL
  if (!ipcRenderer || typeof ipcRenderer.send !== 'function') {
    throw new Error('Web Collection: ipcRenderer is required for the Electron IPC adapter')
  }
  // 会话内内存存储：内核队列/重试期间不丢（跨启动持久化由主进程侧负责）。
  const memory = new Map()
  const useInvoke = typeof ipcRenderer.invoke === 'function'

  return {
    name: 'electron-renderer',
    rawRequest: null,
    /**
     * 经 IPC 把批量载荷交给主进程代理上报。
     * invoke（带 ack）：主进程返回 { ok, status }，内核据此走重试/丢弃判定；
     * send（退化）：fire-and-forget，返回 202 让内核按成功处理（老版本 Electron）。
     */
    request: async ({ data }) => {
      const payload = data && data.events ? data : data
      if (useInvoke) {
        const ack = await ipcRenderer.invoke(channel, payload)
        return { status: Number(ack?.status ?? 200) }
      }
      ipcRenderer.send(channel, payload)
      return { status: 202 }
    },
    getStorage: async (key) => memory.get(key),
    setStorage: async (key, value) => { memory.set(key, value) },
    getContext: () => {
      // 渲染进程拥有完整浏览器上下文；单测（无 window/document）时安全回落。
      try {
        return {
          path: globalThis.location?.pathname || '',
          url: globalThis.location?.href || '',
          title: globalThis.document?.title || '',
          referrer: globalThis.document?.referrer || '',
          userAgent: `${globalThis.navigator?.userAgent || ''} Electron`.trim()
        }
      } catch {
        return { path: '', url: '', title: '', referrer: '', userAgent: 'Electron' }
      }
    },
    // 能力位声明（P1-4）：IPC 桥模式无 DOM 自动插桩/回放/曝光（如需请走直连模式 Web SDK）。
    capabilities: {
      dom: false,
      exposure: false,
      replay: false,
      networkStatus: false,
      navigation: false,
      storage: true,
      beacon: false,
      visibility: false
    }
  }
}

/**
 * preload 桥接暴露：把「发送采集载荷」的最小能力暴露给渲染进程。
 * contextIsolation 开启时在 preload 中调用；renderer 侧把 window.__EYS_IPC__.send
 * 作为 IPC 通道（或自行封装 adapter.request）。
 * @param {object} ipcRenderer preload 中的 ipcRenderer
 * @param {string} [channel]    IPC 通道名
 */
export function exposeEysBridge(ipcRenderer, channel = DEFAULT_IPC_CHANNEL) {
  if (!ipcRenderer || typeof ipcRenderer.send !== 'function') return
  try {
    globalThis.__EYS_IPC__ = {
      channel,
      send: (payload) => {
        try { ipcRenderer.send(channel, payload) } catch { /* 静默：桥接失败不阻断页面 */ }
      }
    }
  } catch {
    // 静默。
  }
}
