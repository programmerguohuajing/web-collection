/**
 * SDK 自监控（采集 / 交付健康度）。
 *
 * 设计目标：防止「采集一切正常、但事件从未成功送达后端」的静默失败
 * （类比 2026-08-28 线上事故——worker 写库异常被 waitUntil 吞掉、health 全绿却零入库）。
 * 这里聚焦 **SDK 侧可见** 的交付健康度：订阅 transport 的 diagnostic 诊断事件，
 * 统计成功交付、永久丢弃、重试中、超时、限流、本地队列溢出、存储配额等，
 * 计算健康度并在异常时限频 console.warn，供业务侧与自诊断页观测。
 *
 * 不含任何业务敏感数据：只持有计数、状态码与时间戳。
 */

/** 健康度等级。 */
export const MONITOR_HEALTH = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  CRITICAL: 'critical',
  // 服务端黑洞：SDK 本地发送全部成功（HTTP 2xx），但服务端未落库（类比 2026-08-28——collect 返回 200 却零入库）。
  SERVER_BLACKHOLE: 'server-blackhole'
})

export class SelfMonitor {
  /**
   * @param {object} [opts]
   * @param {number} [opts.windowMs=600000] - 滚动统计窗口（默认 10 分钟）
   * @param {number} [opts.degradedFailThreshold=3] - 进入 degraded 的最小失败样本数
   * @param {number} [opts.staleSuccessMs=300000] - 超过该时长无成功交付即视为异常（默认 5 分钟）
   * @param {number} [opts.blackholeThresholdMs=180000] - 本地持续发送成功，但服务端最后事件时间落后本端超过该值即判定为服务端黑洞（默认 3 分钟）
   * @param {number} [opts.warnCooldownMs=300000] - 控制台告警最小间隔（默认 5 分钟）
   * @param {boolean} [opts.consoleWarn=true] - 是否在异常时 console.warn
   */
  constructor(opts = {}) {
    this.windowMs = opts.windowMs != null ? opts.windowMs : 10 * 60 * 1000
    this.degradedFailThreshold = opts.degradedFailThreshold != null ? opts.degradedFailThreshold : 3
    this.staleSuccessMs = opts.staleSuccessMs != null ? opts.staleSuccessMs : 5 * 60 * 1000
    this.blackholeThresholdMs = opts.blackholeThresholdMs != null ? opts.blackholeThresholdMs : 3 * 60 * 1000
    this.warnCooldownMs = opts.warnCooldownMs != null ? opts.warnCooldownMs : 5 * 60 * 1000
    this.consoleWarn = opts.consoleWarn !== false
    this._lastWarnAt = 0
    this._reset()
  }

  _reset() {
    this.since = Date.now()
    this.sent = 0 // 成功交付（flush_success）的事件数
    this.dropped = 0 // 永久丢弃（flush_failed / dropped_non_retryable）：不可重试
    this.retried = 0 // 进入退避重试的事件数（429/5xx/超时）
    this.timeouts = 0 // 超时次数
    this.rateLimited = 0 // 收到 429 次数
    this.queueFull = 0 // 本地队列溢出丢弃数
    this.storageQuota = 0 // 持久化队列写入失败次数
    this.lastSuccessAt = null
    this.lastError = null // { type, status, at }
    this.recentFailures = [] // 最近失败（带时间戳），最多保留 20 条
    // 服务端回传（来自 /api/diagnostics）：用于发现「本地发送成功但服务端未落库」的黑洞。
    this.serverLastEventTs = null // 服务端该 appId 的最后事件 ts（= 客户端事件 ts，规避跨机时钟差）
    this.serverStatus = null // 服务端诊断状态（healthy/degraded/critical）
    this.serverIngestErrorCount = 0 // 近 1h 服务端入库告警数
  }

  _maybeReset() {
    if (Date.now() - this.since > this.windowMs) this._reset()
  }

  /**
   * 接收 transport 诊断事件（与 ReliableSender 共用同一个 diagnostic sink）。
   * @param {object} event - { type, ...detail, ts }
   */
  onDiagnostic(event) {
    if (!event || !event.type) return
    this._maybeReset()
    switch (event.type) {
      case 'flush_success':
        this.sent += Number(event.sent || 0)
        this.lastSuccessAt = Date.now()
        break
      case 'flush_failed':
        this.dropped += Number(event.dropped || 0)
        this._recordFailure('flush_failed', event)
        break
      case 'dropped_non_retryable':
        this.dropped += Number(event.count || 0)
        this._recordFailure('dropped_non_retryable', event)
        break
      case 'retry':
        this.retried += Number(event.count || 0)
        this._recordFailure('retry', event)
        break
      case 'timeout':
        this.timeouts += Number(event.attempt || 1)
        this._recordFailure('timeout', event)
        break
      case 'rate_limited':
        this.rateLimited++
        this._recordFailure('rate_limited', event)
        break
      case 'queue_full':
        this.queueFull += Number(event.dropped || 0)
        break
      case 'storage_quota':
        this.storageQuota++
        break
      default:
        break
    }
  }

  _recordFailure(type, event) {
    this.lastError = { type, status: event.status || 0, at: Date.now() }
    this.recentFailures.push({ type, status: event.status || 0, at: Date.now() })
    if (this.recentFailures.length > 20) this.recentFailures.shift()
  }

  /**
   * 接入服务端回传的诊断数据（来自 /api/diagnostics），用于发现「本地发送成功但服务端未落库」的黑洞。
   * @param {object} data - { lastEventTs, status, ingestErrorCount }
   */
  setServerDiagnostics(data) {
    if (!data) return
    if (data.lastEventTs != null) this.serverLastEventTs = Number(data.lastEventTs)
    if (data.status != null) this.serverStatus = data.status
    if (data.ingestErrorCount != null) this.serverIngestErrorCount = Number(data.ingestErrorCount)
  }

  /** 计算健康度。 */
  health() {
    this._maybeReset()
    const attempts = this.sent + this.dropped + this.retried
    const failEvents = this.dropped + this.retried + this.timeouts + this.rateLimited
    // critical：采集正常但从未成功交付，或长时间无成功交付。
    if (this.sent === 0 && failEvents > 0) {
      return { status: MONITOR_HEALTH.CRITICAL, message: '事件采集正常但从未成功交付至后端' }
    }
    if (this.lastSuccessAt && Date.now() - this.lastSuccessAt > this.staleSuccessMs && failEvents > 0) {
      const secs = Math.round((Date.now() - this.lastSuccessAt) / 1000)
      return { status: MONITOR_HEALTH.CRITICAL, message: `已 ${secs}s 未成功交付事件，可能存在上报阻断` }
    }
    // server-blackhole：本地持续发送成功（HTTP 2xx），但服务端未落库。
    // 关键判据：本端最近一次成功交付仍在窗口内（说明 SDK 自认发送正常），
    // 且服务端该 appId 的最后事件时间远落后于本端，或近端出现入库告警。
    const localDeliveryHealthy = this.lastSuccessAt && (Date.now() - this.lastSuccessAt) <= this.staleSuccessMs
    if (localDeliveryHealthy && this.serverLastEventTs != null) {
      const gap = this.lastSuccessAt - this.serverLastEventTs
      if (gap > this.blackholeThresholdMs || this.serverIngestErrorCount > 0) {
        const mins = Math.round(gap / 60000) || (this.serverIngestErrorCount > 0 ? '?' : 0)
        return { status: MONITOR_HEALTH.SERVER_BLACKHOLE, message: `本地发送正常但服务端未落库（疑似采集黑洞，最后入库落后约 ${mins} 分钟 / 近1h入库告警 ${this.serverIngestErrorCount} 次）` }
      }
    }
    // degraded：失败率偏高且样本充足。
    const failRate = attempts ? (this.dropped + this.retried) / attempts : 0
    if (failRate >= 0.5 && attempts >= this.degradedFailThreshold) {
      return { status: MONITOR_HEALTH.DEGRADED, message: `交付失败率 ${(failRate * 100).toFixed(1)}%（近窗口）` }
    }
    return { status: MONITOR_HEALTH.HEALTHY, message: '采集与交付正常' }
  }

  /** 返回当前窗口的监控快照。 */
  snapshot() {
    this._maybeReset()
    const attempts = this.sent + this.dropped + this.retried
    const failRate = attempts ? (this.dropped + this.retried) / attempts : 0
    const h = this.health()
    return {
      since: this.since,
      sent: this.sent,
      dropped: this.dropped,
      retried: this.retried,
      timeouts: this.timeouts,
      rateLimited: this.rateLimited,
      queueFull: this.queueFull,
      storageQuota: this.storageQuota,
      deliveryAttempts: attempts,
      failureRate: Number(failRate.toFixed(4)),
      lastSuccessAt: this.lastSuccessAt,
      secondsSinceLastSuccess: this.lastSuccessAt ? Math.round((Date.now() - this.lastSuccessAt) / 1000) : null,
      lastError: this.lastError,
      recentFailures: this.recentFailures.slice(-10),
      // 服务端回传视角
      serverLastEventTs: this.serverLastEventTs,
      serverStatus: this.serverStatus,
      serverIngestErrorCount: this.serverIngestErrorCount,
      blackholeSuspected: h.status === MONITOR_HEALTH.SERVER_BLACKHOLE,
      health: h.status,
      message: h.message
    }
  }

  /**
   * 异常时限频向控制台告警（不抛错、不影响主流程）。
   * 建议每次收到 diagnostic 后调用；内部自限频。
   */
  warnIfDegraded() {
    if (!this.consoleWarn) return
    const h = this.health()
    if (h.status === MONITOR_HEALTH.HEALTHY) return
    const now = Date.now()
    if (now - this._lastWarnAt < this.warnCooldownMs) return
    this._lastWarnAt = now
    try {
      // eslint-disable-next-line no-console
      console.warn(`[web-collection] 自监控告警：SDK 交付健康度为 ${h.status} —— ${h.message}`, this.snapshot())
    } catch {}
  }
}
