/**
 * Replay 环形缓冲（SDK-210 · 内存护栏 + 错误前 30 秒可恢复）。
 *
 * 取代原先无界的 `replayEvents` 数组。回放事件持续产生，若因离线 / 限流 / 主线程
 * 阻塞导致 flush 滞后，无界数组会无限增长，撑爆内存。环形缓冲通过两个维度封顶：
 *   - 容量上限 `maxSize`：超出后丢弃最旧事件（emit replay_buffer_full）。
 *   - 时间窗口 `windowMs`：超出窗口的旧事件在读取时被惰性淘汰（内存护栏）。
 *
 * 错误触发保留：正常录制时增量 flush 持续发送；当发生错误 / 分段结束 / 页面卸载
 * （force）时调用 `drain()` 取出**全部留存**（最近 windowMs 内）的事件，保证「错误前
 * 30 秒」的回放片段可随错误一并恢复。
 */
export class ReplayRingBuffer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxSize=1500] - 最大留存事件数
   * @param {number} [opts.windowMs=30000] - 留存时间窗口（默认 30s）
   */
  constructor({ maxSize = 1500, windowMs = 30000 } = {}) {
    this.maxSize = Math.max(1, maxSize | 0)
    this.windowMs = Math.max(0, windowMs | 0)
    /** @type {Array<{ts:number, event:object}>} */
    this._buf = []
    this._evicted = 0
  }

  /**
   * 写入一个回放事件（附带时间戳）。
   * @param {object} event
   * @param {number} [ts]
   * @returns {{ evicted: number }} 本次因容量超限被丢弃的事件数
   */
  push(event, ts = Date.now()) {
    this._buf.push({ ts, event })
    let evicted = 0
    // 容量护栏：超出 maxSize 丢弃最旧
    while (this._buf.length > this.maxSize) {
      this._buf.shift()
      evicted++
    }
    this._evicted += evicted
    return { evicted }
  }

  /** 当前留存数量（不含已过窗口但未被惰性淘汰的项） */
  get size() {
    return this._buf.length
  }

  /** 累计因容量超限被丢弃的事件数（用于诊断，可重置） */
  get evictedTotal() {
    return this._evicted
  }

  /**
   * 取出并清空全部留存事件（force 场景：错误前窗口全量恢复）。
   * 顺带惰性淘汰超出时间窗口的旧事件（内存护栏）。
   * @param {number} [now]
   * @returns {object[]} 事件数组（不含时间戳包装）
   */
  drain(now = Date.now()) {
    this._evictExpired(now)
    const out = this._buf.map((e) => e.event)
    this._buf = []
    return out
  }

  /**
   * 取出最多 count 个事件（增量 flush 场景），不超出时间窗口。
   * @param {number} count
   * @param {number} [now]
   * @returns {object[]}
   */
  take(count, now = Date.now()) {
    this._evictExpired(now)
    const slice = this._buf.slice(0, count)
    this._buf = this._buf.slice(count)
    return slice.map((e) => e.event)
  }

  /**
   * 惰性淘汰超出时间窗口的旧事件。
   * @param {number} now
   */
  _evictExpired(now) {
    if (this.windowMs <= 0) return
    const cutoff = now - this.windowMs
    let i = 0
    while (i < this._buf.length && this._buf[i].ts < cutoff) i++
    if (i > 0) {
      this._evicted += i
      this._buf = this._buf.slice(i)
    }
  }

  /** 清空缓冲（销毁时） */
  clear() {
    this._buf = []
  }
}
