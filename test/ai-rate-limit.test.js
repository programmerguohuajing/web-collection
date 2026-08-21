import assert from 'node:assert/strict'
import test from 'node:test'
import { createRateLimiter } from '../packages/ai/rate-limit.js'

/**
 * M4：限流器单元测试（§8 按 key 令牌桶）
 * now 可注入可控时钟，便于确定性测试 refill。
 */
test('限流：容量内请求放行', () => {
  const l = createRateLimiter({ capacity: 3, refillPerSec: 1 })
  assert.equal(l.consume('a').ok, true)
  assert.equal(l.consume('a').ok, true)
  assert.equal(l.consume('a').ok, true)
  assert.equal(l.consume('a').ok, false) // 第 4 次超限
})

test('限流：不同 key 独立计数', () => {
  const l = createRateLimiter({ capacity: 1, refillPerSec: 0 })
  assert.equal(l.consume('a').ok, true)
  assert.equal(l.consume('a').ok, false)
  assert.equal(l.consume('b').ok, true) // b 不受 a 影响
  assert.equal(l.consume('b').ok, false)
})

test('限流：超限返回 retryAfterMs>0', () => {
  const l = createRateLimiter({ capacity: 1, refillPerSec: 10 })
  l.consume('a')
  const r = l.consume('a')
  assert.equal(r.ok, false)
  assert.ok(r.retryAfterMs >= 50) // 需 wait 1/10s 补充
})

test('限流：随时间 refill 恢复', () => {
  let t = 0
  const l = createRateLimiter({ capacity: 1, refillPerSec: 1000, now: () => t }) // 每秒补 1000
  assert.equal(l.consume('a').ok, true)
  assert.equal(l.consume('a').ok, false)
  t = 100 // 100ms 后
  assert.equal(l.consume('a').ok, true) // 已补满 100 token
})

test('限流：默认容量 60', () => {
  let t = 0
  const l = createRateLimiter({ now: () => t })
  assert.equal(l.consume('a').ok, true)
  assert.equal(l.remaining('a') + 1, 60) // 已消费 1 → remaining 59
})

test('限流：remaining 反映 refill', () => {
  let t = 0
  const l = createRateLimiter({ capacity: 10, refillPerSec: 100, now: () => t })
  l.consume('a')
  l.consume('a')
  assert.equal(l.remaining('a'), 8)
  t = 10 // 10ms → 补 1
  assert.equal(l.remaining('a'), 9)
})
