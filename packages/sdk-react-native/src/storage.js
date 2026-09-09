/**
 * @file 存储适配层（AsyncStorage 注入 / 内存降级 / none 三态）
 *
 * 契约（架构 §5.2）：
 * - 注入判定口径与 adapters.js:77 一致：`typeof storage.getItem === 'function' && typeof storage.setItem === 'function'`。
 * - 未注入或读写抛错 → 降级为内存 Map，`degraded = true`，**仅一次** emit storage_degraded（含 reason），后续静默。
 * - 复用内核存储 key（core.js:17-18），保证 deviceId 跨启动稳定。
 * - 每次读写包 safe 语义：AsyncStorage 抛错 → 记诊断并回退内存，**绝不向上抛**。
 */
import { DIAGNOSTIC, STORAGE_KEYS } from './constants.js'
import { isStorageLike } from './runtime.js'

/**
 * 创建存储适配器。
 * @param {object | null} [storage=null] 宿主注入的 AsyncStorage 形态对象
 * @param {{ emit?: Function } | null} [diagnostics=null]
 * @returns {{
 *   kind: 'async' | 'memory',
 *   degraded: boolean,
 *   getStorage: (key: string) => Promise<any>,
 *   setStorage: (key: string, value: any) => Promise<void>,
 *   removeStorage: (key: string) => Promise<void>,
 *   keys: () => string[]
 * }}
 */
export function createStorageAdapter(storage = null, diagnostics = null) {
  const memory = new Map()
  let useAsync = isStorageLike(storage)
  let degraded = !useAsync
  let warned = false

  /** 降级到内存并记录诊断（仅首次记录）。 */
  function degrade(reason) {
    useAsync = false
    degraded = true
    if (!warned) {
      warned = true
      try {
        diagnostics?.emit?.(DIAGNOSTIC.STORAGE_DEGRADED, { reason })
      } catch {
        // 静默。
      }
    }
  }

  if (degraded) degrade('not_injected')

  /** 解析存储值：JSON 字符串反序列化，非字符串原样返回。 */
  function parse(value) {
    if (typeof value !== 'string') return value
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }

  /**
   * 读取存储。
   * @param {string} key
   * @returns {Promise<any>} 失败或不存在返回 undefined
   */
  async function getStorage(key) {
    if (useAsync) {
      try {
        const raw = await Promise.resolve(storage.getItem(key))
        if (raw === null || raw === undefined) return undefined
        const value = parse(raw)
        memory.set(key, value)
        return value
      } catch (error) {
        degrade('get_threw')
      }
    }
    return memory.get(key)
  }

  /**
   * 写入存储（异步写失败仍会落到内存，保证进程内可读）。
   * @param {string} key
   * @param {any} value
   * @returns {Promise<void>}
   */
  async function setStorage(key, value) {
    memory.set(key, value)
    if (useAsync) {
      try {
        await Promise.resolve(storage.setItem(key, JSON.stringify(value)))
        return
      } catch (error) {
        degrade('set_threw')
      }
    }
  }

  /**
   * 删除存储项。
   * @param {string} key
   * @returns {Promise<void>}
   */
  async function removeStorage(key) {
    memory.delete(key)
    if (useAsync && typeof storage.removeItem === 'function') {
      try {
        await Promise.resolve(storage.removeItem(key))
      } catch (error) {
        degrade('remove_threw')
      }
    }
  }

  return {
    get kind() {
      return useAsync ? 'async' : 'memory'
    },
    get degraded() {
      return degraded
    },
    getStorage,
    setStorage,
    removeStorage,
    /** 当前内存态 key 列表（测试自查用）。 */
    keys: () => [...memory.keys()],
    /** 内核持久化 key（与 core.js:17-18 一致）。 */
    static: STORAGE_KEYS
  }
}
