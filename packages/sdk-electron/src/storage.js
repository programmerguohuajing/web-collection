/**
 * @file 存储层：主进程持久化 deviceId / 事件队列（内核 hydrate/persist 契约）
 *
 * 内核通过 adapter.getStorage(key) / adapter.setStorage(key, value) 读写，
 * value 为 JSON 可序列化对象（内核自行 stringify/parse 前后处理见 adapters 契约——
 * 与 RN 适配器一致：setStorage 收到的是已序列化字符串，getStorage 返回解析后的值）。
 *
 * Electron 主进程没有 localStorage，默认提供两种实现：
 *   - createJsonFileStorage({ readFile, writeFile, file })：JSON 文件持久化（推荐，跨启动保留 deviceId/队列）
 *   - createMemoryStorage()：内存兜底（仅会话内有效）
 * fs 由调用方注入（import { readFileSync } from 'node:fs'），本包不 import electron / node:fs，
 * 保持可单测 + 渲染端可安全打包。
 */

/**
 * 创建 JSON 文件存储。所有 IO 经 safe 包装，绝不向宿主抛错。
 * @param {object} options
 * @param {(file: string, encoding: 'utf-8') => string} options.readFile   注入的同步读（node:fs.readFileSync）
 * @param {(file: string, data: string) => void}     options.writeFile     注入的同步写（node:fs.writeFileSync）
 * @param {string}                                   options.file          存储文件绝对路径（建议 app.getPath('userData') + '/eys-storage.json'）
 * @returns {{ get: (key: string) => any, set: (key: string, value: any) => void }}
 */
export function createJsonFileStorage({ readFile, writeFile, file }) {
  const safeRead = safeWrap(() => {
    if (typeof readFile !== 'function' || !file) return undefined
    const raw = readFile(file, 'utf-8')
    return raw ? JSON.parse(raw) : undefined
  })
  const safeWrite = safeWrap(() => {})
  return {
    get(key) {
      const data = safeRead()
      return data ? data[key] : undefined
    },
    set(key, value) {
      const data = safeRead() || {}
      data[key] = value
      try {
        safeWrite(() => writeFile(file, JSON.stringify(data)))
      } catch {
        // 写失败静默（队列仍在内存，下次写入覆盖）。
      }
    }
  }
}

/**
 * 创建内存存储（会话内有效；主进程常驻场景下等价于进程生命周期）。
 * @returns {{ get: (key: string) => any, set: (key: string, value: any) => void }}
 */
export function createMemoryStorage() {
  const map = new Map()
  return {
    get(key) {
      return map.get(key)
    },
    set(key, value) {
      map.set(key, value)
    }
  }
}

/** 异步适配：把同步存储包成内核期望的 async get/set（getStorage 返回 Promise）。 */
export function createAsyncStorageAdapter(syncStorage) {
  if (!syncStorage || typeof syncStorage.get !== 'function') return undefined
  return {
    getStorage: async (key) => {
      try {
        return syncStorage.get(key)
      } catch {
        return undefined
      }
    },
    setStorage: async (key, value) => {
      try {
        syncStorage.set(key, value)
      } catch {
        // 静默。
      }
    }
  }
}

function safeWrap(fn) {
  return (...args) => {
    try {
      return fn(...args)
    } catch {
      return undefined
    }
  }
}
