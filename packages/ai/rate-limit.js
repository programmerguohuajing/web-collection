/**
 * @file 简单内存令牌桶限流器（双后端共享，ADR-004 / §8）
 *
 * 云 Worker 无跨实例共享状态，单实例内限流足以遏制单客户端滥用；
 * PG 后端（apps/api 单进程或多进程 pm2）同样用内存计数，粒度按实例。
 * - createRateLimiter({ capacity, refillPerSec }) -> { consume(key), remaining(key), ttlMs() }
 * - consume 返回 { ok, remaining, retryAfterMs }：ok=false 表示超限（需返回 429）。
 *
 * 用法（ai-worker.js / ai-service.js）：
 *   const limiter = createRateLimiter({ capacity: env.AI_RATE_CAPACITY || 60, refillPerSec: 10 })
 *   const { ok, retryAfterMs } = limiter.consume(key)
 *   if (!ok) return json({ error: 'rate limited' }, 429, { 'retry-after': Math.ceil(retryAfterMs/1000) })
 */
export function createRateLimiter({ capacity = 60, refillPerSec = 10, now = Date.now } = {}) {
  const cap = Number(capacity) > 0 ? Number(capacity) : 60
  const refill = Number(refillPerSec) > 0 ? Number(refillPerSec) : 10
  const time = () => Number(now())
  // key -> { tokens, updatedAt }
  const buckets = new Map()
  const MAX_BUCKETS = 5000 // 防内存无限增长

  function bucket(key) {
    let b = buckets.get(key)
    const nowTs = time()
    if (!b) {
      if (buckets.size >= MAX_BUCKETS) {
        // 简单清理：删除最旧的一半（按 updatedAt 粗排）
        const oldest = [...buckets.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt).slice(0, Math.floor(MAX_BUCKETS / 2))
        for (const [k] of oldest) buckets.delete(k)
      }
      b = { tokens: cap, updatedAt: nowTs }
      buckets.set(key, b)
      return b
    }
    // 按流逝时间补充 token
    const elapsedMs = nowTs - b.updatedAt
    if (elapsedMs > 0) {
      b.tokens = Math.min(cap, b.tokens + (elapsedMs / 1000) * refill)
      b.updatedAt = nowTs
    }
    return b
  }

  function consume(key, cost = 1) {
    const b = bucket(String(key ?? 'default'))
    if (b.tokens >= cost) {
      b.tokens -= cost
      return { ok: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 }
    }
    const deficit = cost - b.tokens
    const retryAfterMs = Math.ceil((deficit / refill) * 1000)
    return { ok: false, remaining: 0, retryAfterMs }
  }

  function remaining(key) {
    const b = buckets.get(String(key ?? 'default'))
    if (!b) return cap
    const elapsedMs = time() - b.updatedAt
    return Math.min(cap, Math.floor(b.tokens + (elapsedMs / 1000) * refill))
  }

  return { consume, remaining, capacity: cap, refillPerSec: refill }
}
