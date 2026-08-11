import { parseRetryAfter } from './retry.js'

/**
 * 基于 fetch 的在线传输通道（Reliable Transport v2 的「常规发送」通道）。
 *
 * 特性：
 * - 每次发送使用独立 `AbortController`，支持超时中止（区分 `TimeoutError` 与 `AbortError`）。
 * - force=true（页面退出）时携带 `keepalive`，保证卸载阶段仍能尽力送达。
 * - 保留 `x-app-key` 自定义鉴权头（与现有后端兼容）。
 * - 解析 `Retry-After` 供调度器遵守。
 *
 * 与 BeaconTransport 实现同一 `Transport` 接口（`send(events, opts) -> Promise<result>`）。
 */
export class FetchTransport {
  /**
   * @param {object} [opts]
   * @param {string} [opts.endpoint='/api/collect']
   * @param {string} [opts.collectKey='']
   * @param {(input: any, init?: any) => Promise<any>} [opts.fetchImpl]
   * @param {number} [opts.timeout=10000] - 单次发送超时（ms）
   * @param {object} [opts.headers] - 额外静态头
   */
  constructor(opts = {}) {
    this.endpoint = opts.endpoint || '/api/collect'
    this.collectKey = opts.collectKey || ''
    this.fetchImpl =
      opts.fetchImpl !== undefined
        ? opts.fetchImpl
        : typeof fetch !== 'undefined'
          ? fetch.bind(globalThis)
          : null
    this.timeout = opts.timeout || 10000
    this.baseHeaders = opts.headers || {}
    this.name = 'fetch'
  }

  /** 当前环境是否具备 fetch 能力。 */
  available() {
    return typeof this.fetchImpl === 'function'
  }

  /**
   * @param {object[]} events - 待发送事件数组
   * @param {object} [sendOpts]
   * @param {AbortSignal} [sendOpts.abortSignal] - 外部取消信号
   * @param {boolean} [sendOpts.keepalive=false] - 页面退出时尽力送达
   * @param {number} [sendOpts.timeout] - 覆盖默认超时
   * @param {object} [sendOpts.headers] - 覆盖/追加头
   * @returns {Promise<{status:number, ok:boolean, retryAfter:number, headers:any}>}
   */
  async send(events, sendOpts = {}) {
    if (!this.available()) {
      const e = new Error('fetch unavailable')
      e.name = 'TransportUnavailable'
      throw e
    }
    const { abortSignal, keepalive = false, timeout = this.timeout, headers = {} } = sendOpts
    const body = JSON.stringify({ events })
    const reqHeaders = {
      'content-type': 'application/json',
      ...this.baseHeaders,
      ...headers
    }
    if (this.collectKey) reqHeaders['x-app-key'] = this.collectKey

    const ac = new AbortController()
    let timedOut = false
    let timer = null
    const onAbort = () => ac.abort()
    if (abortSignal) {
      if (abortSignal.aborted) ac.abort()
      else abortSignal.addEventListener('abort', onAbort)
    }
    if (timeout && timeout > 0) {
      timer = setTimeout(() => { timedOut = true; ac.abort() }, timeout)
    }

    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: reqHeaders,
        body,
        keepalive,
        signal: ac.signal
      })
      const status = res.status
      const retryAfter = parseRetryAfter(res.headers?.get?.('retry-after'))
      return { status, ok: res.ok, retryAfter, headers: res.headers }
    } catch (err) {
      // 包装为可分类的错误，避免直接抛出只读 DOMException。
      const name = timedOut
        ? 'TimeoutError'
        : err && err.name === 'AbortError'
          ? 'AbortError'
          : 'NetworkError'
      const e = new Error(timedOut ? 'timeout' : (err && err.message) || 'network error')
      e.name = name
      throw e
    } finally {
      if (timer) clearTimeout(timer)
      if (abortSignal) abortSignal.removeEventListener?.('abort', onAbort)
    }
  }
}
