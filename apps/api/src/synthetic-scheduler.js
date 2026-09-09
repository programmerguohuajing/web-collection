/**
 * @file B3 · 合成监控定时调度器（Node 端）。
 * 每 SYNTHETIC_TICK_SECONDS（默认 60）秒取一批到期探针执行（单批上限见 packages/synthetic.js TICK_BATCH_LIMIT，
 * 超出顺延下一 tick）。单实例守卫：SYNTHETIC_SCHEDULER_ENABLED=false 可关；setInterval + unref 避免阻塞进程退出。
 * 复刻 apps/api/src/slo-scheduler.js 范式。
 */
import { tick } from './services/synthetic-service.js'

let timer = null

function positiveInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.floor(number)))
}

/**
 * 启动合成监控调度。返回是否实际启动。
 * @returns {boolean}
 */
export function startSyntheticScheduler() {
  if (process.env.SYNTHETIC_SCHEDULER_ENABLED === 'false') {
    console.log('[synthetic] scheduler disabled (SYNTHETIC_SCHEDULER_ENABLED=false)')
    return false
  }
  if (timer) return false
  const seconds = positiveInt(process.env.SYNTHETIC_TICK_SECONDS, 60, 10, 3600)
  const intervalMs = seconds * 1000
  timer = setInterval(() => {
    runTick().catch(error => console.error('[synthetic] tick failed', error?.stack || error?.message || error))
  }, intervalMs)
  timer.unref?.()
  console.log(`[synthetic] scheduler started, tick every ${seconds}s`)
  return true
}

/** 单次 tick：执行全部到期探针（runProbe 内部自带落库 + 计数推进 + 告警判定）。 */
export async function runTick() {
  const result = await tick()
  if (result.due > 0) {
    console.log(`[synthetic] tick: ${result.executed}/${result.due} probes executed`)
  }
  return result
}
