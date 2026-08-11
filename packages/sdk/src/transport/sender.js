import { createEventId } from './id.js'
import { computeBackoff, classifyResponse } from './retry.js'

/**
 * 可靠发送编排器（Reliable Transport v2 的核心）。
 *
 * 职责：
 * - 维护内存热队列 `items`（`{ id, value, retry }`），并异步镜像到 IndexedDB 冷队列，
 *   实现刷新/崩溃/离线后的恢复（SDK-207）。
 * - 在线发送走 `FetchTransport`，按 `classifyResponse` 决定：成功移除、可重试保留并
 *   指数退避重试、4xx 契约错误永久丢弃（SDK-207）。
 * - 每次发送带 `AbortController` 超时；网络恢复时唤醒（SDK-207）。
 * - 页面退出/隐藏/冻结时走 `BeaconTransport`（UTF-8 字节切片，非破坏性），
 *   事件保留在持久队列，由服务端按 eventId 幂等去重（SDK-219 / API-220）。
 * - 单域名最多一个活跃发送者（可选 `lock`，基于 BroadcastChannel）（SDK-219）。
 * - 通过 `diagnostic` 暴露 queue_full / rate_limited / timeout / retry /
 *   dropped_non_retryable / beacon_* / next_session_recovered 等诊断（SDK-215）。
 */
export class ReliableSender {
  /**
   * @param {object} opts
   * @param {import('./indexeddb-queue.js').IndexedDBQueue} [opts.cold]
   * @param {import('./fetch-transport.js').FetchTransport} [opts.transport]
   * @param {import('./beacon-transport.js').BeaconTransport} [opts.beacon]
   * @param {(event: object) => void} [opts.gif] - 无 fetch 时的 GIF 兜底上报
   * @param {string} [opts.endpoint]
   * @param {number} [opts.maxQueue=200]
   * @param {number} [opts.maxRetries=3]
   * @param {number} [opts.maxBatch=10]
   * @param {object} [opts.diagnostic]
   * @param {string} [opts.collectKey='']
   * @param {{ acquire: Function, release: Function }} [opts.lock]
   * @param {() => boolean} [opts.online]
   * @param {number} [opts.backoffBase=500] - 退避基数（ms），便于测试注入
   * @param {number} [opts.backoffMax=30000] - 退避上限（ms），便于测试注入
   */
  constructor(opts = {}) {
    this.cold = opts.cold || null
    this.transport = opts.transport || null
    this.beacon = opts.beacon || null
    this.gif = opts.gif || null
    this.endpoint = opts.endpoint || '/api/collect'
    this.maxQueue = opts.maxQueue || 200
    this.maxRetries = opts.maxRetries != null ? opts.maxRetries : 3
    this.maxBatch = opts.maxBatch || 10
    this.diagnostic = opts.diagnostic || { emit() {} }
    this.collectKey = opts.collectKey || ''
    this.lock = opts.lock || null
    this.online = opts.online || (() => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true))
    this.backoffBase = opts.backoffBase != null ? opts.backoffBase : 500
    this.backoffMax = opts.backoffMax != null ? opts.backoffMax : 30000
    this.items = []
    this.flushing = false
    this._retryTimer = null
    this.ready = this._load()
  }

  /** 启动时从持久化冷队列恢复未发送事件。 */
  async _load() {
    if (!this.cold) return
    try {
      const recovered = await this.cold.snapshot()
      if (recovered.length) {
        const ids = new Set(this.items.map((i) => i.id))
        const merged = recovered.filter((v) => !ids.has(v.eventId || v.id)).map((value) => ({
          id: value.eventId || value.id,
          value,
          retry: value.retry || 0
        }))
        this.items.push(...merged)
        this.diagnostic.emit('next_session_recovered', { count: merged.length })
      }
    } catch {}
  }

  _persist() {
    if (!this.cold) return Promise.resolve()
    return this.cold
      .replaceAll(this.items.map((i) => ({ id: i.id, value: i.value, ts: i.value?.ts || Date.now() })))
      .catch(() => this.diagnostic.emit('storage_quota', {}))
  }

  /** 主动触发一次持久化（供 setUser 回填后调用）。 */
  persist() {
    return this._persist()
  }

  size() {
    return this.items.length
  }

  /** 入队一个事件，自动补全稳定 eventId。 */
  enqueue(value) {
    if (!value || typeof value !== 'object') return
    if (!value.eventId) value.eventId = createEventId()
    const item = { id: value.eventId, value, retry: value.retry || 0 }
    this.items.push(item)
    if (this.items.length > this.maxQueue) {
      const removed = this.items.splice(0, this.items.length - this.maxQueue)
      this.diagnostic.emit('queue_full', { dropped: removed.length })
    }
    this._persist()
  }

  /** 遍历队列中的事件对象（供 setUser 回填用户字段等）。 */
  forEachItem(fn) {
    this.items.forEach((i) => fn(i.value))
  }

  _acquireLock() {
    if (!this.lock) return Promise.resolve(true)
    try { return this.lock.acquire() } catch { return Promise.resolve(true) }
  }

  _releaseLock() {
    try { this.lock?.release() } catch {}
  }

  _dequeue(batch) {
    const ids = new Set(batch.map((i) => i.id))
    this.items = this.items.filter((i) => !ids.has(i.id))
  }

  /**
   * 在线发送一批事件（fetch + ACK）。
   * 成功/不可重试 → 移除；可重试（429/5xx/超时）→ 保留并安排退避重试。
   * @param {boolean} [force=false] - 是否连续发送直到清空（页面退出在线兜底）
   * @returns {Promise<{sent:number, dropped:number, retried:number, skipped?:boolean}>}
   */
  async sendBatchOnline(force = false) {
    await this.ready
    if (!this.items.length) return { sent: 0, dropped: 0, retried: 0 }
    // 同步置位 flushing（在首个 await 之前），保证并发调用只进入一个活跃发送者。
    if (this.flushing) return { skipped: true, sent: 0, dropped: 0, retried: 0 }
    this.flushing = true
    const locked = await this._acquireLock()
    if (!locked) {
      this.flushing = false
      return { skipped: true, sent: 0, dropped: 0, retried: 0 }
    }
    this.diagnostic.emit('flush_attempt', { size: this.items.length, force })
    let sent = 0
    let dropped = 0
    let retried = 0
    let attempts = 0

    try {
      do {
        const batch = this.items.slice(0, this.maxBatch)
        if (!batch.length) break
        attempts++

        let result
        try {
          if (!this.transport || !this.transport.available()) {
            // 无 fetch：GIF 逐条兜底（fire-and-forget），视为成功并移除。
            if (this.gif) {
              batch.forEach((i) => this.gif(i.value))
              this._dequeue(batch)
              sent += batch.length
              continue
            }
            break
          }
          result = await this.transport.send(batch.map((i) => i.value), {
            keepalive: force,
            timeout: this.transport.timeout
          })
        } catch (err) {
          const classify = err && (err.name === 'TimeoutError' ? 'timeout' : err.name === 'AbortError' ? 'abort' : 'network')
          result = { status: 0, ok: false, classify }
          if (classify === 'timeout') this.diagnostic.emit('timeout', { attempt: attempts })
        }

        const verdict =
          result.classify === 'timeout' || result.classify === 'abort'
            ? 'retry'
            : result.classify === 'network'
              ? 'retry'
              : classifyResponse(result.status)

        if (verdict === 'success') {
          this._dequeue(batch)
          sent += batch.length
        } else if (verdict === 'drop') {
          this._dequeue(batch)
          dropped += batch.length
          this.diagnostic.emit('dropped_non_retryable', { count: batch.length, status: result.status })
        } else {
          // retry：递增计数；超过上限的部分永久丢弃。
          let over = null
          batch.forEach((i) => {
            i.retry++
            if (i.retry > this.maxRetries) (over = over || []).push(i)
          })
          if (over && over.length) {
            this._dequeue(over)
            dropped += over.length
            this.diagnostic.emit('dropped_non_retryable', {
              count: over.length,
              status: result.status,
              reason: 'max_retries'
            })
            // 仍可能因 429 限流，记录 rate_limited 便于观测。
            if (result.status === 429) this.diagnostic.emit('rate_limited', { status: 429, retryAfter: result.retryAfter })
          } else {
            retried += batch.length
            if (result.status === 429) {
              this.diagnostic.emit('rate_limited', { status: 429, retryAfter: result.retryAfter })
            } else {
              this.diagnostic.emit('retry', { count: batch.length, status: result.status, attempt: attempts })
            }
          }
        }
        this._persist()
      } while (force && this.items.length && !this._transportGone())

      if (sent) this.diagnostic.emit('flush_success', { sent })
      if (dropped) this.diagnostic.emit('flush_failed', { dropped })

      // 仍有可重试事件 → 安排指数退避重试（不阻塞当前调用）。
      if (retried && this.items.length) {
        const backoff = computeBackoff(Math.min(attempts, 6), { base: this.backoffBase, max: this.backoffMax })
        clearTimeout(this._retryTimer)
        const t = setTimeout(() => {
          this.sendBatchOnline(false).catch(() => {})
        }, backoff)
        // 退避定时器不应阻止进程/Worker 退出（不持有事件循环）。
        if (typeof t.unref === 'function') t.unref()
        this._retryTimer = t
      }
      return { sent, dropped, retried }
    } finally {
      this.flushing = false
      this._releaseLock()
    }
  }

  _transportGone() {
    return this.transport && !this.transport.available()
  }

  /**
   * 页面退出/隐藏/冻结时的「尽力排队」发送（非破坏性）。
   * 优先 Beacon，回退 fetch keepalive；事件保留在持久队列等待服务端幂等去重。
   * @param {object} [sendOpts]
   * @returns {Promise<object>}
   */
  async sendExitBatch(sendOpts = {}) {
    await this.ready
    if (!this.items.length) return { outcome: 'empty', sent: 0 }
    const events = this.items.map((i) => i.value)
    if (this.beacon) {
      return this.beacon.send(events, { diagnostic: this.diagnostic }).catch((err) => ({
        outcome: 'error',
        error: String((err && err.message) || err)
      }))
    }
    if (this.transport && this.transport.available()) {
      try {
        const res = await this.transport.send(events, { keepalive: true, timeout: this.transport.timeout })
        return { outcome: 'keepalive', status: res.status, ok: res.ok }
      } catch (err) {
        return { outcome: 'keepalive_failed', error: String((err && err.message) || err) }
      }
    }
    return { outcome: 'unavailable' }
  }

  /** 网络恢复时唤醒在线发送。 */
  onOnline() {
    if (this.online()) this.sendBatchOnline(false).catch(() => {})
  }

  async clear() {
    this.items = []
    if (this.cold) await this.cold.clear().catch(() => {})
  }
}
