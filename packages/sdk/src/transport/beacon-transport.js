import { parseRetryAfter } from './retry.js'

/**
 * 页面退出阶段的「尽力排队」传输通道（Reliable Transport v2）。
 *
 * 设计约束（来自路线图 5.1.D）：
 * - `sendBeacon` 不能携带自定义 Header，因此无法携带 `x-app-key`；
 *   配置了 `collectKey` 时回退到 `fetch(..., { keepalive: true })`。
 * - 按 UTF-8 字节切片（TextEncoder / Blob.size），单个 Beacon 批次默认 ≤ 60 KiB；
 *   **不得使用 JS 字符串长度**判断字节数（中文多字节会误判）。
 * - 单条事件超过字节上限时标记 `beacon_oversize` 并跳过（退出 flush 是非破坏性的，
 *   该事件仍留在持久队列，下一会话常规发送会再次尝试）。
 * - `sendBeacon` 返回 `true` 仅代表浏览器接受排队，不代表服务端已入库；
 *   因此退出 flush 是「非破坏性」的——事件保留在持久队列，由服务端按 eventId 幂等去重。
 */
export class BeaconTransport {
  /**
   * @param {object} [opts]
   * @param {string} [opts.endpoint='/api/collect']
   * @param {string} [opts.collectKey='']
   * @param {(url: string, data: any) => boolean} [opts.sendBeacon] - navigator.sendBeacon 绑定
   * @param {(input: any, init?: any) => Promise<any>} [opts.fetchImpl]
   * @param {number} [opts.maxBytes=61440]
   * @param {number} [opts.timeout=8000]
   * @param {TextEncoder} [opts.encoder]
   */
  constructor(opts = {}) {
    this.endpoint = opts.endpoint || '/api/collect'
    this.collectKey = opts.collectKey || ''
    this.sendBeacon =
      opts.sendBeacon ||
      (typeof navigator !== 'undefined' && navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null)
    this.fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null)
    this.maxBytes = opts.maxBytes || 60 * 1024
    this.timeout = opts.timeout || 8000
    this.encoder = opts.encoder || (typeof TextEncoder !== 'undefined' ? new TextEncoder() : null)
    this.name = 'beacon'
  }

  /** 当前环境是否具备 sendBeacon 能力。 */
  available() {
    return typeof this.sendBeacon === 'function'
  }

  /** 计算字符串的 UTF-8 字节长度（优先 TextEncoder，回退 Blob.size，再回退字符长度）。 */
  _byteLength(str) {
    if (this.encoder) return this.encoder.encode(str).length
    if (typeof Blob !== 'undefined') {
      try { return new Blob([str]).size } catch {}
    }
    return str.length
  }

  /**
   * 将事件集合拆分为不超过 `maxBytes` 的批次（UTF-8 字节切片）。
   * @param {object[]} events
   * @returns {{ events: object[], bytes: number, oversize: boolean }[]}
   */
  _partition(events) {
    const batches = []
    let current = []
    let currentBytes = 0
    for (const ev of events) {
      const evBytes = this._byteLength(JSON.stringify(ev))
      if (evBytes > this.maxBytes) {
        batches.push({ events: [ev], bytes: evBytes, oversize: true })
        continue
      }
      if (current.length) {
        const projected = this._byteLength(JSON.stringify(current.concat(ev)))
        if (projected > this.maxBytes) {
          batches.push({ events: current, bytes: currentBytes, oversize: false })
          current = [ev]
          currentBytes = evBytes
          continue
        }
        current.push(ev)
        currentBytes = projected
      } else {
        current = [ev]
        currentBytes = evBytes
      }
    }
    if (current.length) batches.push({ events: current, bytes: currentBytes, oversize: false })
    return batches
  }

  /**
   * 发送一批事件（非破坏性）。
   * @param {object[]} events
   * @param {object} [sendOpts]
   * @param {object} [sendOpts.diagnostic] - 诊断分发器
   * @returns {Promise<{outcome:string, queued?:number, rejected?:number, oversize?:number, bytes?:number, status?:number, ok?:boolean}>}
   */
  async send(events, sendOpts = {}) {
    const diagnostic = sendOpts.diagnostic
    diagnostic?.emit('beacon_attempted', { count: events.length })

    // 配置了 collectKey 时 sendBeacon 无法携带鉴权头，回退 fetch keepalive。
    if (this.collectKey) {
      diagnostic?.emit('beacon_fallback', { reason: 'collectKey_present' })
      return this._fallbackFetch(events, sendOpts)
    }
    if (!this.available()) {
      diagnostic?.emit('beacon_fallback', { reason: 'beacon_unavailable' })
      return this._fallbackFetch(events, sendOpts)
    }

    const partitions = this._partition(events)
    let queued = 0
    let rejected = 0
    let oversize = 0
    let queuedBytes = 0
    for (const part of partitions) {
      if (part.oversize) {
        oversize++
        diagnostic?.emit('beacon_oversize', { bytes: part.bytes })
        continue
      }
      const body = JSON.stringify({ events: part.events })
      const payload = typeof Blob !== 'undefined' ? new Blob([body], { type: 'application/json' }) : body
      let ok = false
      try {
        ok = this.sendBeacon(this.endpoint, payload) === true
      } catch {
        ok = false
      }
      if (ok) {
        queued++
        queuedBytes += part.bytes
      } else {
        rejected++
        diagnostic?.emit('beacon_rejected', { bytes: part.bytes })
      }
    }
    if (queued) diagnostic?.emit('beacon_queued', { count: queued, bytes: queuedBytes })
    return {
      outcome: queued ? 'queued' : rejected ? 'rejected' : 'empty',
      queued,
      rejected,
      oversize,
      bytes: queuedBytes
    }
  }

  async _fallbackFetch(events, sendOpts = {}) {
    const diagnostic = sendOpts.diagnostic
    if (!this.fetchImpl) return { outcome: 'fallback_unavailable' }
    const body = JSON.stringify({ events })
    const headers = { 'content-type': 'application/json' }
    if (this.collectKey) headers['x-app-key'] = this.collectKey
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body,
        keepalive: true
      })
      return { outcome: 'fallback', status: res.status, ok: res.ok, retryAfter: parseRetryAfter(res.headers?.get?.('retry-after')) }
    } catch (err) {
      return { outcome: 'fallback_failed', error: String((err && err.message) || err) }
    }
  }
}
