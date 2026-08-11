/**
 * DeterministicSampler 单元测试（路线图 Phase 6 · U06 / SDK-208）
 *
 * 覆盖：哈希原语、trace/session 一致性、优先级保留、errorSampleRate 子采样、
 * 远端权重、分类子采样（不破坏 trace）、markPriority、getTraceFlagsForTraceId、
 * 可解释决策字段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cyrb53, foldUnit, hashUnit } from '../src/sampling/hash.js'
import { DeterministicSampler, createDeterministicSampler } from '../src/sampling/deterministic-sampler.js'

// ---------------------------------------------------------------------------
// 哈希原语
// ---------------------------------------------------------------------------
test('cyrb53 对相同输入返回相同整数（确定性）', () => {
  assert.equal(cyrb53('abc'), cyrb53('abc'))
  assert.equal(cyrb53('trace-1', 7), cyrb53('trace-1', 7))
})

test('cyrb53 对相同输入 + 不同盐返回不同结果', () => {
  assert.notEqual(cyrb53('abc', 0), cyrb53('abc', 1))
})

test('foldUnit 与 hashUnit 始终落在 [0,1)', () => {
  for (const s of ['', 'a', 'hello', 'trace-xyz', 'session-9']) {
    const u = hashUnit(s)
    assert.ok(u >= 0 && u < 1, `hashUnit(${s})=${u} 应在 [0,1)`)
  }
  for (let i = 0; i < 100; i++) {
    const u = foldUnit(cyrb53('k' + i))
    assert.ok(u >= 0 && u < 1)
  }
})

test('hashUnit 对大量输入分布大致均匀（既非全 0 也非全 1）', () => {
  let low = 0
  const n = 500
  for (let i = 0; i < n; i++) if (hashUnit('id-' + i) < 0.5) low++
  // 允许较大容差，仅验证哈希把空间铺开。
  assert.ok(low > n * 0.3 && low < n * 0.7, `低于 0.5 的比例=${low / n}`)
})

// ---------------------------------------------------------------------------
// 基础决策
// ---------------------------------------------------------------------------
test('rate=1 时任何单元都采样', () => {
  const s = createDeterministicSampler({ sampleRate: 1 })
  for (const k of ['t1', 't2', 'session-a']) {
    assert.equal(s.decide({ traceId: k }).sampled, true)
    assert.equal(s.decide({ sessionId: k }).sampled, true)
  }
})

test('rate=0 时任何单元都不采样', () => {
  const s = createDeterministicSampler({ sampleRate: 0 })
  for (const k of ['t1', 't2', 'session-a']) {
    assert.equal(s.decide({ traceId: k }).sampled, false)
    assert.equal(s.decide({ sessionId: k }).sampled, false)
  }
})

test('同一 traceId 多次决策结果完全一致（trace 一致性）', () => {
  const s = createDeterministicSampler({ sampleRate: 0.5 })
  const a = s.decide({ traceId: 'abc123' }).sampled
  for (let i = 0; i < 20; i++) {
    assert.equal(s.decide({ traceId: 'abc123' }).sampled, a)
  }
})

test('同一 sessionId 多次决策结果完全一致（session 一致性）', () => {
  const s = createDeterministicSampler({ sampleRate: 0.5 })
  const a = s.decide({ sessionId: 'sess-1' }).sampled
  for (let i = 0; i < 20; i++) {
    assert.equal(s.decide({ sessionId: 'sess-1' }).sampled, a)
  }
})

test('trace 单元与 session 单元使用各自的键（互不影响）', () => {
  const s = createDeterministicSampler({ sampleRate: 0.5 })
  const d1 = s.decide({ traceId: 'same-key' })
  const d2 = s.decide({ sessionId: 'same-key' })
  // 同一字符串作为 trace 或 session 键时，单元不同，决策可不同；二者都不应抛错且字段正确。
  assert.equal(d1.unit, 'trace')
  assert.equal(d2.unit, 'session')
  assert.equal(d1.key, 'same-key')
  assert.equal(d2.key, 'same-key')
})

// ---------------------------------------------------------------------------
// 优先级 / 错误保留
// ---------------------------------------------------------------------------
test('优先级事件（error）在 rate=0 时仍被保留', () => {
  const s = createDeterministicSampler({ sampleRate: 0 })
  assert.equal(s.decide({ traceId: 'x', priority: true }).sampled, true)
  assert.equal(s.decide({ sessionId: 'x', category: 'error', priority: true }).sampled, true)
})

test('markPriority 使指定 traceId 后续决策强制保留（即便 rate=0）', () => {
  const s = createDeterministicSampler({ sampleRate: 0 })
  s.markPriority('keep-me')
  assert.equal(s.decide({ traceId: 'keep-me' }).sampled, true)
  // 未标记的依然被丢弃。
  assert.equal(s.decide({ traceId: 'drop-me' }).sampled, false)
})

test('errorSampleRate 对错误做确定性子采样（既不全部保留也不全部丢弃）', () => {
  const s = createDeterministicSampler({ sampleRate: 0, errorSampleRate: 0.5 })
  let kept = 0
  const total = 200
  for (let i = 0; i < total; i++) {
    const d = s.decide({ traceId: 'err-' + i, priority: true })
    assert.equal(d.rule, 'error_rate')
    if (d.sampled) kept++
  }
  assert.ok(kept > 0 && kept < total, `errorSampleRate=0.5 应保持一部分错误被采样，实际 kept=${kept}`)
  // 同一 key 决策一致。
  assert.equal(s.decide({ traceId: 'err-0', priority: true }).sampled, s.decide({ traceId: 'err-0', priority: true }).sampled)
})

test('errorSampleRate 仅为错误生效，普通事件在 rate=0 仍被丢弃', () => {
  const s = createDeterministicSampler({ sampleRate: 0, errorSampleRate: 0.5 })
  assert.equal(s.decide({ traceId: 'e', priority: false }).sampled, false)
  assert.equal(s.decide({ sessionId: 'e', category: 'performance' }).sampled, false)
})

// ---------------------------------------------------------------------------
// 远端权重
// ---------------------------------------------------------------------------
test('traceState 中的 sampling_weight 作为远端权重覆盖本地决策', () => {
  const s = createDeterministicSampler({ sampleRate: 0, traceState: 'foo=1,sampling_weight=0.5' })
  // 远端权重下，决策规则为 remote，且同一 key 一致。
  const d = s.decide({ traceId: 'abc' })
  assert.equal(d.rule, 'remote')
  assert.equal(d.rate, 0.5)
  assert.equal(s.decide({ traceId: 'abc' }).sampled, d.sampled)
})

test('非法 traceState 不解析出远端权重（退回本地）', () => {
  const s = createDeterministicSampler({ sampleRate: 1, traceState: 'sampling_weight=abc' })
  const d = s.decide({ traceId: 'abc' })
  assert.equal(d.rule, 'trace')
  assert.equal(d.sampled, true)
})

// ---------------------------------------------------------------------------
// 分类子采样
// ---------------------------------------------------------------------------
test('categorySampleRates 仅收窄 session 单元，不破坏 trace', () => {
  // trace 单元：即使命中分类，也应走 trace 规则（不被分类进一步切断）。
  const s = createDeterministicSampler({ sampleRate: 0.5, categorySampleRates: { performance: 0 } })
  const d = s.decide({ traceId: 't1', category: 'performance' })
  assert.equal(d.unit, 'trace')
  assert.equal(d.rule, 'trace')

  // session 单元：分类采样率为 0 → 该分类事件被丢弃。
  const s2 = createDeterministicSampler({ sampleRate: 1, categorySampleRates: { performance: 0 } })
  assert.equal(s2.decide({ sessionId: 's1', category: 'performance' }).sampled, false)
  // 未配置分类的事件按 session 基础率保留。
  assert.equal(s2.decide({ sessionId: 's1', category: 'behavior' }).sampled, true)
})

test('session_category 规则同时受 base 与分类率约束', () => {
  const s = createDeterministicSampler({ sampleRate: 1, categorySampleRates: { performance: 0.5 } })
  const d = s.decide({ sessionId: 's9', category: 'performance' })
  assert.equal(d.rule, 'session_category')
  assert.equal(d.categoryRate, 0.5)
  assert.equal(typeof d.sampled, 'boolean')
  // 确定性：重复调用一致。
  assert.equal(s.decide({ sessionId: 's9', category: 'performance' }).sampled, d.sampled)
})

// ---------------------------------------------------------------------------
// traceFlags 一致性
// ---------------------------------------------------------------------------
test('getTraceFlagsForTraceId 与 decide 一致且为合法取值', () => {
  const s = createDeterministicSampler({ sampleRate: 0.5 })
  for (const k of ['a', 'b', 'c', 'd', 'e']) {
    const flags = s.getTraceFlagsForTraceId(k)
    assert.ok(flags === '01' || flags === '00', `flags=${flags}`)
    assert.equal(flags === '01', s.decide({ traceId: k }).sampled)
  }
})

test('getTraceFlagsForTraceId 对相同 traceId 始终返回相同 flags（父子 Span 一致）', () => {
  const s = createDeterministicSampler({ sampleRate: 0.5 })
  const flags = s.getTraceFlagsForTraceId('shared-trace')
  for (let i = 0; i < 10; i++) {
    assert.equal(s.getTraceFlagsForTraceId('shared-trace'), flags)
  }
})

// ---------------------------------------------------------------------------
// 可解释字段
// ---------------------------------------------------------------------------
test('决策结果包含可解释字段 rule/unit/key/rate', () => {
  const s = createDeterministicSampler({ sampleRate: 0.5, categorySampleRates: { performance: 0.3 } })
  const d = s.decide({ sessionId: 's', category: 'performance' })
  assert.ok(typeof d.rule === 'string' && d.rule.length > 0)
  assert.ok(d.unit === 'trace' || d.unit === 'session' || d.unit === 'global')
  assert.equal(d.key, 's')
  assert.ok(typeof d.rate === 'number')
})
