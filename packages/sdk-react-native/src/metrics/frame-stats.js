/**
 * @file 帧率 / 卡顿采集（M2 · metric `frame_stats`）
 *
 * 口径（架构 §5.5，README 必须明示）：RN 的帧回调反映 **JS 线程** 帧率，非系统 UI FPS，
 * 字段名保留 `frame_stats`，避免被误读为「卡顿率」。
 *
 * 计算：
 * - `fps = round(frames / windowSec)`
 * - `droppedFrames = max(0, round(fpsTarget * windowSec) - frames)`
 * - 帧间隔 > `longTaskThresholdMs`（默认 100ms）的超出部分累加为 `longTaskMs`
 * - 采样窗口 `sampleWindowMs`（默认 1000ms）内聚合，上报节流 `reportIntervalMs`（默认 10000ms，≈6 条/分钟）
 * - 仅前台采样；切后台暂停并丢弃当前窗口
 * - 无帧源（宿主无 rAF / 未注入 frameCallback）→ 关闭采集，不注册、不抛
 */
import { circuit, guard } from './../guard.js'

/**
 * 创建帧率采集器。
 * @param {{
 *   metric?: (name: string, value: number, props?: object) => void,
 *   sampleWindowMs?: number,
 *   reportIntervalMs?: number,
 *   fpsTarget?: number,
 *   longTaskThresholdMs?: number,
 *   enabled?: boolean,
 *   now?: () => number,
 *   diagnostics?: { emit?: Function } | null
 * }} [options={}]
 */
export function createFrameStatsCollector(options = {}) {
  const emitMetric = typeof options.metric === 'function' ? options.metric : () => {}
  const sampleWindowMs = Number.isFinite(options.sampleWindowMs) ? Math.max(100, options.sampleWindowMs) : 1000
  const reportIntervalMs = Number.isFinite(options.reportIntervalMs) ? Math.max(1000, options.reportIntervalMs) : 10000
  const fpsTarget = Number.isFinite(options.fpsTarget) ? Math.max(1, options.fpsTarget) : 60
  const longTaskThresholdMs = Number.isFinite(options.longTaskThresholdMs) ? Math.max(1, options.longTaskThresholdMs) : 100
  const diagnostics = options.diagnostics || null
  const enabled = options.enabled !== false
  const breaker = circuit({ label: 'frameStats', diagnostics })

  let frames = 0
  let windowStart = 0
  let lastFrameTs = 0
  let longTaskMs = 0
  let lastReportAt = 0
  let paused = false
  let unsubscribe = null
  let reportCount = 0

  /** 重置当前采样窗口。 */
  function resetWindow() {
    frames = 0
    windowStart = 0
    lastFrameTs = 0
    longTaskMs = 0
  }

  /** 汇总并（按节流）上报一个采样窗口。 */
  function reportWindow(endTs) {
    const elapsedMs = Math.max(1, endTs - windowStart)
    const seconds = elapsedMs / 1000
    const fps = Math.round(frames / seconds)
    const expected = Math.round(fpsTarget * seconds)
    const droppedFrames = Math.max(0, expected - frames)
    const payload = {
      fps,
      droppedFrames,
      longTaskMs: Math.round(longTaskMs),
      sampleWindowMs,
      fpsTarget
    }
    resetWindow()
    // 上报节流：每 reportIntervalMs 最多一条，避免高频 metric 击穿配额。
    if (lastReportAt !== 0 && endTs - lastReportAt < reportIntervalMs) return
    lastReportAt = endTs
    try {
      emitMetric('frame_stats', fps, payload)
      reportCount += 1
    } catch {
      // 采集回调异常绝不上抛。
    }
  }

  /**
   * 帧回调（(ts) => void，ts 为毫秒时间戳）。
   * @param {number} ts
   */
  const onFrame = guard(function handleFrame(ts) {
    if (breaker.disabled || paused || !enabled) return
    const timestamp = Number.isFinite(ts) ? ts : Date.now()
    if (!windowStart) {
      windowStart = timestamp
      lastFrameTs = timestamp
      frames = 0
      longTaskMs = 0
      return
    }
    const delta = timestamp - lastFrameTs
    if (delta > longTaskThresholdMs) longTaskMs += delta - longTaskThresholdMs
    frames += 1
    lastFrameTs = timestamp
    if (timestamp - windowStart >= sampleWindowMs) reportWindow(timestamp)
  }, 'frameStats.onFrame', diagnostics)

  return {
    /**
     * 启动帧率采集。
     * @param {((cb: (ts: number) => void) => (() => void)) | null} [frameSource=null]
     * @returns {() => void} dispose
     */
    start(frameSource = null) {
      if (!enabled) return () => {}
      if (typeof frameSource !== 'function') return () => {}
      try {
        const off = frameSource(onFrame)
        unsubscribe = typeof off === 'function' ? off : null
      } catch {
        unsubscribe = null
      }
      return () => {
        if (typeof unsubscribe === 'function') {
          try { unsubscribe() } catch { /* 退订失败无需处理 */ }
        }
        unsubscribe = null
        resetWindow()
      }
    },
    onFrame,
    /** 手动驱动一帧（测试与宿主桥接使用）。 */
    tick(ts) {
      onFrame(ts)
    },
    /** 汇总当前窗口并立即上报（跳过节流），用于切后台前兜底。 */
    flushWindow(ts = Date.now()) {
      if (!frames) return
      const saved = lastReportAt
      lastReportAt = 0
      reportWindow(ts)
      if (!reportCount) lastReportAt = saved
    },
    /** 切后台：暂停采样并丢弃当前窗口。 */
    pause() {
      paused = true
      resetWindow()
    },
    /** 回前台：恢复采样。 */
    resume() {
      paused = false
    },
    get paused() {
      return paused
    },
    get reportCount() {
      return reportCount
    },
    get breaker() {
      return breaker
    }
  }
}
