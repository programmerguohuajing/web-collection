/**
 * @file 失效安全原语（L2 函数级隔离 / L3 模块熔断 / 诊断出口）
 *
 * RN 端红线：Web 端 SDK 抛异常最坏是采集中断，**RN 端未捕获异常会直接导致宿主 App 红屏 / 崩溃**。
 * 因此本包把「公开 API 与采集回调永不向上抛」作为一级红线，所有外部边界一律经本文件的包装器。
 */
import { CIRCUIT_BREAKER_THRESHOLD, DIAGNOSTIC } from './constants.js'

/**
 * 创建诊断出口（本包约定事件名见 DIAGNOSTIC，出口为 options.onDiagnostic）。
 * 出口自身抛错一律静默（诊断不得反向影响主链路）。
 * @param {Function | null} [sink=null] onDiagnostic 回调
 * @returns {{ emit: (name: string, detail?: object) => void }}
 */
export function createDiagnostics(sink = null) {
  return {
    /**
     * 发送一条诊断事件。
     * @param {string} name 诊断名（DIAGNOSTIC.*）
     * @param {object} [detail={}] 诊断明细（仅含字段名等元信息，不含业务敏感数据）
     */
    emit(name, detail = {}) {
      if (typeof sink !== 'function') return
      try {
        sink({ name, ts: Date.now(), ...detail })
      } catch {
        // 出口异常静默。
      }
    }
  }
}

/**
 * 记录 SDK 内部异常（L2）：异常已被吞掉，仅记诊断，绝不向上抛。
 * @param {string} label 模块标签
 * @param {unknown} error 原始异常
 * @param {{ emit?: Function } | null} [diagnostics=null]
 */
export function reportInternalError(label, error, diagnostics = null) {
  try {
    diagnostics?.emit?.(DIAGNOSTIC.SDK_INTERNAL_ERROR, {
      module: label,
      reason: error instanceof Error ? error.name : typeof error
    })
  } catch {
    // 静默。
  }
}

/**
 * 函数级隔离（L2）：包装任意函数，异常 → 记诊断并返回兜底值，**永不 throw**。
 * @template T
 * @param {(...args: any[]) => T} fn 被包装函数
 * @param {T | (() => T)} [fallback=undefined] 兜底值或兜底工厂
 * @param {string} [label='unknown'] 模块标签（进入诊断）
 * @param {{ emit?: Function } | null} [diagnostics=null]
 * @returns {(...args: any[]) => T}
 */
export function safe(fn, fallback = undefined, label = 'unknown', diagnostics = null) {
  if (typeof fn !== 'function') return () => resolveFallback(fallback)
  return function safeWrapped(...args) {
    try {
      return fn.apply(this, args)
    } catch (error) {
      reportInternalError(label, error, diagnostics)
      return resolveFallback(fallback)
    }
  }
}

/**
 * 无返回值版本的 safe：用于事件回调 / 订阅回调（返回值恒为 undefined）。
 * @param {Function} fn
 * @param {string} label
 * @param {{ emit?: Function } | null} [diagnostics=null]
 * @returns {(...args: any[]) => void}
 */
export function guard(fn, label = 'unknown', diagnostics = null) {
  return safe(fn, undefined, label, diagnostics)
}

/** 解析兜底值（支持工厂函数形式，避免每次构造对象）。 */
function resolveFallback(fallback) {
  return typeof fallback === 'function' ? fallback() : fallback
}

/**
 * 创建模块熔断器（L3）：同一模块**连续** N 次异常即永久关闭，避免每帧刷屏与持续 CPU 占用。
 * @param {{ label?: string, diagnostics?: { emit?: Function } | null, maxFailures?: number }} [options={}]
 * @returns {{
 *   disabled: boolean,
 *   failures: number,
 *   recordSuccess: () => void,
 *   recordFailure: (detail?: object) => void,
 *   reset: () => void,
 *   wrap: (fn: Function, fallback?: any, label?: string) => Function
 * }}
 */
export function circuit(options = {}) {
  const label = options.label || 'module'
  const diagnostics = options.diagnostics || null
  const maxFailures = Number.isFinite(options.maxFailures) ? Math.max(1, Math.floor(options.maxFailures)) : CIRCUIT_BREAKER_THRESHOLD
  let failures = 0
  let disabled = false

  function recordSuccess() {
    failures = 0
  }

  function recordFailure(detail = {}) {
    failures += 1
    if (!disabled && failures >= maxFailures) {
      disabled = true
      try {
        diagnostics?.emit?.(DIAGNOSTIC.MODULE_DISABLED, { module: label, failures, ...detail })
      } catch {
        // 静默。
      }
    }
  }

  return {
    get disabled() {
      return disabled
    },
    get failures() {
      return failures
    },
    recordSuccess,
    recordFailure,
    /** 重置熔断状态（仅供测试与显式恢复使用）。 */
    reset() {
      failures = 0
      disabled = false
    },
    /**
     * 以熔断语义包装函数：熔断后直接返回兜底值不再执行；每次异常计数，成功则清零连续计数。
     * @param {Function} fn
     * @param {any} [fallback=undefined]
     * @param {string} [wrapLabel=label]
     */
    wrap(fn, fallback = undefined, wrapLabel = label) {
      return function circuitWrapped(...args) {
        if (disabled) return resolveFallback(fallback)
        try {
          const result = typeof fn === 'function' ? fn.apply(this, args) : undefined
          recordSuccess()
          return result
        } catch (error) {
          reportInternalError(wrapLabel, error, diagnostics)
          recordFailure()
          return resolveFallback(fallback)
        }
      }
    }
  }
}
