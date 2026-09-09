/**
 * @file B2 · SLO 定时调度器（Node 端）。
 * 每 SLO_TICK_MINUTES（默认 5）分钟遍历所有 SLO：computeSnapshot（写全窗口快照）+ evaluateAlerts（多窗口判定 + 越界投递）。
 * 单实例守卫：SLO_SCHEDULER_ENABLED=false 可关；setInterval + unref 避免阻塞进程退出。
 */
import { listSloIds, computeSnapshot, evaluateAlerts } from './services/slo-service.js'

let timer = null

function positiveInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.floor(number)))
}

/**
 * 启动 SLO 调度。返回是否实际启动。
 * @returns {boolean}
 */
export function startSloScheduler() {
  if (process.env.SLO_SCHEDULER_ENABLED === 'false') {
    console.log('[slo] scheduler disabled (SLO_SCHEDULER_ENABLED=false)')
    return false
  }
  if (timer) return false
  const minutes = positiveInt(process.env.SLO_TICK_MINUTES, 5, 1, 60)
  const intervalMs = minutes * 60 * 1000
  timer = setInterval(() => {
    tick().catch(error => console.error('[slo] tick failed', error?.stack || error?.message || error))
  }, intervalMs)
  timer.unref?.()
  console.log(`[slo] scheduler started, tick every ${minutes}m`)
  return true
}

/** 单次遍历：所有 SLO 重算快照并评估燃尽告警。 */
export async function tick() {
  const ids = await listSloIds()
  const now = Date.now()
  for (const id of ids) {
    try {
      const snapshot = await computeSnapshot(id, now)
      await evaluateAlerts(id, snapshot)
    } catch (error) {
      console.error(`[slo] tick failed for ${id}`, error?.stack || error?.message || error)
    }
  }
  return ids.length
}
