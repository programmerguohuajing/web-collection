/**
 * @file 配置归一化与非致命校验（失效安全：越界值钳位 + 记诊断，**绝不抛**）
 *
 * 归一化顺序：内核默认（core.js:31-59）→ 移动端默认覆盖（DEFAULTS）→ 用户选项 → 钳位修正。
 * 移动端默认覆盖项：maxQueue 500 / batchSize 20 / flushInterval 20000（PRD P0-8）。
 */
import { CLAMP, DEFAULTS, DIAGNOSTIC } from './constants.js'

/** 判断是否为普通对象（排除数组 / null / 非对象）。 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 取字符串：非字符串或空串回退默认（非致命）。 */
function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback
}

/**
 * 数值钳位：非有限数回退默认并记诊断；越界钳位到区间边界并记诊断。
 * 诊断明细仅含字段名，**不含值内容**（避免敏感数据外泄）。
 * @param {unknown} value
 * @param {string} field 字段名
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [range]
 * @param {{ emit?: Function } | null} [diagnostics=null]
 * @returns {number}
 */
function numberOr(value, field, fallback, range = {}, diagnostics = null) {
  const min = Number.isFinite(range.min) ? range.min : 0
  const max = Number.isFinite(range.max) ? range.max : Number.MAX_SAFE_INTEGER
  const num = Number(value)
  if (!Number.isFinite(num)) {
    if (value !== undefined) diagnostics?.emit?.(DIAGNOSTIC.SDK_INTERNAL_ERROR, { module: 'config', field })
    return fallback
  }
  const clamped = Math.min(max, Math.max(min, num))
  if (clamped !== num) diagnostics?.emit?.(DIAGNOSTIC.SDK_INTERNAL_ERROR, { module: 'config', field })
  return clamped
}

/**
 * 归一化配置项。
 * @param {object} [options={}] 用户选项
 * @param {{ emit?: Function } | null} [diagnostics=null] 诊断出口
 * @returns {object} 可直接传给内核 createPlatformEys 的 cfg（含 RN 专属字段，内核不消费但无害）
 */
export function normalizeOptions(options = {}, diagnostics = null) {
  const source = isPlainObject(options) ? options : {}
  const cfg = { ...DEFAULTS, ...source }

  // ---- 嵌套对象：与默认值浅合并，缺项用默认补齐 ----
  cfg.privacy = { ...DEFAULTS.privacy, ...(isPlainObject(source.privacy) ? source.privacy : {}) }
  cfg.categorySampleRates = { ...(isPlainObject(source.categorySampleRates) ? source.categorySampleRates : {}) }
  cfg.coldStart = { ...DEFAULTS.coldStart, ...(isPlainObject(source.coldStart) ? source.coldStart : {}) }
  cfg.frameStats = { ...DEFAULTS.frameStats, ...(isPlainObject(source.frameStats) ? source.frameStats : {}) }
  cfg.network = { ...DEFAULTS.network, ...(isPlainObject(source.network) ? source.network : {}) }
  cfg.crash = { ...DEFAULTS.crash, ...(isPlainObject(source.crash) ? source.crash : {}) }
  cfg.deviceInfo = isPlainObject(source.deviceInfo) ? source.deviceInfo : null

  // ---- 字符串 ----
  cfg.endpoint = stringOr(source.endpoint, DEFAULTS.endpoint)
  cfg.appId = stringOr(source.appId, DEFAULTS.appId)
  cfg.release = stringOr(source.release, DEFAULTS.release)
  cfg.environment = stringOr(source.environment, DEFAULTS.environment)
  cfg.collectKey = typeof source.collectKey === 'string' ? source.collectKey : DEFAULTS.collectKey
  cfg.userId = typeof source.userId === 'string' ? source.userId : DEFAULTS.userId
  cfg.userName = typeof source.userName === 'string' ? source.userName : DEFAULTS.userName
  cfg.userPhone = typeof source.userPhone === 'string' ? source.userPhone : DEFAULTS.userPhone

  // ---- 数值（钳位 + 诊断） ----
  cfg.sampleRate = numberOr(source.sampleRate, 'sampleRate', DEFAULTS.sampleRate, CLAMP.sampleRate, diagnostics)
  cfg.batchSize = numberOr(source.batchSize, 'batchSize', DEFAULTS.batchSize, CLAMP.batchSize, diagnostics)
  cfg.flushInterval = numberOr(source.flushInterval, 'flushInterval', DEFAULTS.flushInterval, CLAMP.flushInterval, diagnostics)
  cfg.minFlushInterval = numberOr(source.minFlushInterval, 'minFlushInterval', DEFAULTS.minFlushInterval, CLAMP.minFlushInterval, diagnostics)
  cfg.maxQueue = numberOr(source.maxQueue, 'maxQueue', DEFAULTS.maxQueue, CLAMP.maxQueue, diagnostics)
  cfg.maxRetries = numberOr(source.maxRetries, 'maxRetries', DEFAULTS.maxRetries, CLAMP.maxRetries, diagnostics)
  // Q-A：后台超阈值回前台算新会话。默认 30s；若与现有 Web sessions 口径冲突，**以 Web 口径为准**。
  cfg.sessionTimeoutMs = numberOr(source.sessionTimeoutMs, 'sessionTimeoutMs', DEFAULTS.sessionTimeoutMs, CLAMP.sessionTimeoutMs, diagnostics)
  cfg.coldStartTimeoutMs = numberOr(source.coldStartTimeoutMs, 'coldStartTimeoutMs', DEFAULTS.coldStartTimeoutMs, CLAMP.coldStartTimeoutMs, diagnostics)

  // ---- 帧率子配置钳位 ----
  cfg.frameStats.enabled = cfg.frameStats.enabled !== false
  cfg.frameStats.sampleWindowMs = numberOr(cfg.frameStats.sampleWindowMs, 'frameStats.sampleWindowMs', DEFAULTS.frameStats.sampleWindowMs, CLAMP.sampleWindowMs, diagnostics)
  cfg.frameStats.reportIntervalMs = numberOr(cfg.frameStats.reportIntervalMs, 'frameStats.reportIntervalMs', DEFAULTS.frameStats.reportIntervalMs, CLAMP.reportIntervalMs, diagnostics)
  cfg.frameStats.fpsTarget = numberOr(cfg.frameStats.fpsTarget, 'frameStats.fpsTarget', DEFAULTS.frameStats.fpsTarget, CLAMP.fpsTarget, diagnostics)
  cfg.frameStats.longTaskThresholdMs = numberOr(cfg.frameStats.longTaskThresholdMs, 'frameStats.longTaskThresholdMs', DEFAULTS.frameStats.longTaskThresholdMs, CLAMP.longTaskThresholdMs, diagnostics)

  // ---- 开关 ----
  cfg.enabled = source.enabled === undefined ? DEFAULTS.enabled : Boolean(source.enabled)
  cfg.consent = source.consent === 'denied' ? 'denied' : 'granted'
  cfg.coldStart.enabled = cfg.coldStart.enabled !== false
  cfg.network.enabled = cfg.network.enabled !== false
  // Q-D：默认不静默改写宿主全局 fetch，需显式开启。
  cfg.network.autoWrapGlobalFetch = cfg.network.autoWrapGlobalFetch === true
  // Q-G：原生崩溃占位通道默认关闭，宿主桥接就绪后显式开启。
  cfg.crash.js = cfg.crash.js !== false
  cfg.crash.rejection = cfg.crash.rejection !== false
  cfg.crash.native = cfg.crash.native === true

  // ---- 钩子 ----
  cfg.beforeSend = typeof source.beforeSend === 'function' ? source.beforeSend : null
  cfg.onDiagnostic = typeof source.onDiagnostic === 'function' ? source.onDiagnostic : null

  return cfg
}

/**
 * 包装 beforeSend：执行顺序为「用户钩子先执行 → RN 后置注入 sessionId」。
 *
 * 契约说明（架构 §3.4 / 已知契约外手法）：内核 sessionId 是实例内常量且无 setter（core.js:79），
 * 因此 RN 层自维护会话 ID，并在 beforeSend 最后统一覆盖 item.sessionId。
 * **迁移条件**：若内核将来暴露 setSessionId / 会话旋转 API，应改为调用内核 API 并删除本覆盖逻辑。
 *
 * @param {Function | null} userBeforeSend 用户钩子（返回 false / 非对象即丢弃事件）
 * @param {{ currentId: () => string }} session 会话管理器
 * @param {{ emit?: Function } | null} [diagnostics=null]
 * @returns {(item: object) => object | false}
 */
export function wrapBeforeSend(userBeforeSend, session, diagnostics = null) {
  return function rnBeforeSend(item) {
    if (!item || typeof item !== 'object') return item
    let next = item
    if (typeof userBeforeSend === 'function') {
      try {
        next = userBeforeSend(item)
      } catch (error) {
        // 与内核口径一致（core.js:312）：用户钩子抛异常 → 丢弃该事件。
        diagnostics?.emit?.(DIAGNOSTIC.SDK_INTERNAL_ERROR, { module: 'beforeSend', reason: 'user_hook_threw' })
        return false
      }
    }
    if (!next || typeof next !== 'object') return next
    try {
      next.sessionId = typeof session?.currentId === 'function' ? session.currentId() : next.sessionId
    } catch (error) {
      diagnostics?.emit?.(DIAGNOSTIC.SDK_INTERNAL_ERROR, { module: 'beforeSend', reason: 'session_inject_failed' })
    }
    return next
  }
}
