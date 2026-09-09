/**
 * @file 冷启动采集（M1 · metric `app_cold_start`）
 *
 * 终点优先级：`markAppReady()` 显式 > 首帧回调 > `coldStartTimeoutMs` 超时兜底（props.markSource 区分）。
 * 仅上报一次（实例级 done 标志）；`phase`：本进程首次创建采集器 → 'cold'，其余 → 'warm'。
 * 失效安全：定时器与帧订阅登记在 dispose 内，stop()/destroy() 全量清理（L5）；定时器 unref 避免阻塞宿主退出。
 */

/**
 * 本进程是否已有采集器创建过（决定 phase：首次 cold，其余 warm）。
 * 模块级状态：与「进程首次创建 → cold；进程复用仅重建 → warm」语义一致。
 */
let startedOnce = false

/**
 * 创建冷启动采集器。
 * @param {{
 *   metric?: (name: string, value: number, props?: object) => void,
 *   moduleInitTs?: number,
 *   timeoutMs?: number,
 *   enabled?: boolean,
 *   now?: () => number,
 *   diagnostics?: { emit?: Function } | null
 * }} [options={}]
 */
export function createColdStartCollector(options = {}) {
  const emitMetric = typeof options.metric === 'function' ? options.metric : () => {}
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(100, options.timeoutMs) : 3000
  const moduleInitTs = Number.isFinite(options.moduleInitTs) ? options.moduleInitTs : now()
  const diagnostics = options.diagnostics || null
  const enabled = options.enabled !== false

  const phase = startedOnce ? 'warm' : 'cold'
  startedOnce = true

  let done = false
  let timer = null
  let unsubscribeFrame = null

  /** 清理定时器与帧订阅。 */
  function release() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (typeof unsubscribeFrame === 'function') {
      try { unsubscribeFrame() } catch { /* 退订失败无需处理 */ }
      unsubscribeFrame = null
    }
  }

  /**
   * 上报冷启动指标（仅首次生效）。
   * @param {string} markSource 'app-ready' | 'first-frame' | 'timeout'
   * @returns {boolean} 是否实际上报
   */
  function emit(markSource) {
    if (done) return false
    done = true
    release()
    const appReadyMs = Math.max(0, now() - moduleInitTs)
    try {
      emitMetric('app_cold_start', appReadyMs, { phase, appReadyMs, markSource })
    } catch {
      // 采集回调异常绝不上抛（由 metrics 层已 guard 过，这里再兜一层）。
    }
    return true
  }

  return {
    /** 当前实例的冷/热启动判定（进程级）。 */
    get phase() {
      return phase
    },
    get done() {
      return done
    },
    /**
     * 启动采集：注册帧回调（首帧即终点）与超时兜底定时器。
     * @param {((cb: (ts: number) => void) => (() => void)) | null} [frameSource=null]
     * @returns {() => void} dispose
     */
    start(frameSource = null) {
      if (!enabled || done) return () => release()
      if (typeof frameSource === 'function') {
        try {
          const unsubscribe = frameSource(() => emit('first-frame'))
          unsubscribeFrame = typeof unsubscribe === 'function' ? unsubscribe : null
        } catch {
          unsubscribeFrame = null
        }
      }
      try {
        timer = setTimeout(() => {
          timer = null
          emit('timeout')
        }, timeoutMs)
        // 兜底定时器不阻止宿主进程退出。
        if (timer && typeof timer.unref === 'function') timer.unref()
      } catch {
        timer = null
      }
      return () => release()
    },
    /** 业务显式校正冷启动终点（优先于首帧）。 */
    markAppReady() {
      return emit('app-ready')
    },
    dispose() {
      release()
    }
  }
}
