/**
 * 将不同后端/历史版本的回放详情响应收敛为播放器唯一消费契约。
 * 支持裸数组、{ events }, { data } 三种历史响应；事件统一使用 timestamp。
 */
export function normalizeReplayPayload(payload) {
  const rawEvents = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.events)
      ? payload.events
      : Array.isArray(payload?.data) ? payload.data : []

  const events = rawEvents
    .filter(event => event && Number.isFinite(Number(event.timestamp ?? event.ts)))
    .map(event => ({
      ...event,
      timestamp: Number(event.timestamp ?? event.ts)
    }))
    .sort((a, b) => a.timestamp - b.timestamp)

  return {
    events,
    rawEventCount: rawEvents.length,
    truncated: Boolean(payload && !Array.isArray(payload) && payload.truncated),
    originalSpanMs: finiteMs(payload?.originalSpanMs),
    spanMs: finiteMs(payload?.spanMs)
  }
}

function finiteMs(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}
