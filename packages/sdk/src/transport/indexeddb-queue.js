/**
 * 持久化队列（Reliable Transport v2 的「冷队列」）。
 *
 * 设计：
 * - 浏览器环境优先使用 IndexedDB，保证刷新/崩溃/离线后事件不丢失。
 * - 当 IndexedDB 不可用（Node 测试、隐私模式、SSR、配额耗尽）时降级为内存数组，
 *   保证 SDK 不崩溃；此时崩溃恢复能力退化为「当前会话内存」。
 * - 所有方法均返回 Promise，便于在异步初始化链中 `await`。
 *
 * 记录格式：`{ id, value, ts }`，`id` 即事件 `eventId`，`value` 为事件对象本身。
 */
export class IndexedDBQueue {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dbName='web-collection']
   * @param {string} [opts.storeName='queue']
   * @param {number} [opts.maxQueue=2000]
   * @param {IDBFactory} [opts.idb] - 可注入的 indexedDB 工厂（测试用）
   */
  constructor(opts = {}) {
    this.dbName = opts.dbName || 'web-collection'
    this.storeName = opts.storeName || 'queue'
    this.maxQueue = opts.maxQueue || 2000
    this.idbFactory = opts.idb || (typeof indexedDB !== 'undefined' ? indexedDB : null)
    this._memory = []
    this._db = null
    this._opening = null
  }

  /** 是否真的在使用 IndexedDB（false 表示内存降级模式）。 */
  get isPersistent() {
    return Boolean(this.idbFactory)
  }

  _open() {
    if (!this.idbFactory) return Promise.resolve(null)
    if (this._db) return Promise.resolve(this._db)
    if (this._opening) return this._opening
    this._opening = new Promise((resolve) => {
      let settled = false
      const done = (db) => { if (!settled) { settled = true; this._db = db; resolve(db) } }
      try {
        const req = this.idbFactory.open(this.dbName, 1)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(this.storeName)) {
            const store = db.createObjectStore(this.storeName, { keyPath: 'id' })
            store.createIndex('ts', 'ts', { unique: false })
          }
        }
        req.onsuccess = () => done(req.result)
        req.onerror = () => done(null)
        req.onblocked = () => done(null)
      } catch {
        done(null)
      }
    })
    return this._opening
  }

  _tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, mode)
        const store = tx.objectStore(this.storeName)
        let result
        Promise.resolve(fn(store))
          .then((r) => { result = r })
          .catch(reject)
        tx.oncomplete = () => resolve(result)
        tx.onerror = () => reject(tx.error || new Error('tx error'))
        tx.onabort = () => reject(tx.error || new Error('tx aborted'))
      } catch (err) {
        reject(err)
      }
    })
  }

  _getAll(db) {
    return this._tx(db, 'readonly', (store) => store.getAll()).then((all) => all || [])
  }

  _getAllKeys(db) {
    return this._tx(db, 'readonly', (store) => store.getAllKeys()).then((keys) => keys || [])
  }

  async enqueue(item) {
    const record = {
      id: item.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      value: item.value ?? item,
      ts: item.ts || Date.now()
    }
    const db = await this._open()
    if (!db) {
      this._memory.push(record)
      this._trimMemory()
      return record
    }
    await this._tx(db, 'readwrite', (store) => store.put(record))
    await this._enforceCapacity(db)
    return record
  }

  _trimMemory() {
    if (this._memory.length > this.maxQueue) {
      this._memory.sort((a, b) => a.ts - b.ts)
      this._memory.splice(0, this._memory.length - this.maxQueue)
    }
  }

  async _enforceCapacity(db) {
    const keys = await this._getAllKeys(db)
    if (keys.length <= this.maxQueue) return
    const toDelete = keys.slice(0, keys.length - this.maxQueue)
    await this._tx(db, 'readwrite', (store) => {
      toDelete.forEach((k) => store.delete(k))
      return true
    })
  }

  /** 返回最早的 n 条事件（不移除）。 */
  async peek(n) {
    const db = await this._open()
    if (!db) return this._memory.slice(0, n).map((r) => r.value)
    const all = await this._getAll(db)
    all.sort((a, b) => a.ts - b.ts)
    return all.slice(0, n).map((r) => r.value)
  }

  /** 移除最早的 n 条事件并返回它们。 */
  async dequeue(n) {
    const db = await this._open()
    if (!db) {
      const taken = this._memory.slice(0, n)
      this._memory.splice(0, n)
      return taken.map((r) => r.value)
    }
    const all = await this._getAll(db)
    all.sort((a, b) => a.ts - b.ts)
    const taken = all.slice(0, n)
    await this._tx(db, 'readwrite', (store) => {
      taken.forEach((r) => store.delete(r.id))
      return true
    })
    return taken.map((r) => r.value)
  }

  /** 返回全部事件对象（最旧→最新），用于会话恢复时合并（与 peek/dequeue 一致，返回 value 而非记录）。 */
  async snapshot() {
    const db = await this._open()
    if (!db) return this._memory.slice().sort((a, b) => a.ts - b.ts).map((r) => r.value)
    const all = await this._getAll(db)
    all.sort((a, b) => a.ts - b.ts)
    return all.map((r) => r.value)
  }

  /** 用给定事件集合整体替换持久化内容（用于工作队列变更后的增量写入）。 */
  async replaceAll(items) {
    const db = await this._open()
    const records = items.map((item) => {
      // 兼容两种形态：
      // 1) 已是记录 { id, value, ts }（sender._persist 持久化时传入）；
      // 2) 裸事件对象（测试或手动调用传入）。
      // 若不加区分，记录会被再次包裹 value → 双重嵌套。
      const isRecord = item && typeof item === 'object' && item.value !== undefined
      const value = isRecord ? item.value : item
      const id = (isRecord ? item.id : value && value.eventId) || value?.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const ts = (isRecord ? item.ts : value?.ts) || Date.now()
      return { id, value, ts }
    })
    if (!db) {
      this._memory = records.slice(-this.maxQueue)
      return
    }
    await this._tx(db, 'readwrite', (store) => {
      store.clear()
      records.forEach((r) => store.put(r))
      return true
    })
  }

  async size() {
    const db = await this._open()
    if (!db) return this._memory.length
    const keys = await this._getAllKeys(db)
    return keys.length
  }

  async clear() {
    const db = await this._open()
    if (!db) {
      this._memory = []
      return
    }
    await this._tx(db, 'readwrite', (store) => store.clear())
  }
}
