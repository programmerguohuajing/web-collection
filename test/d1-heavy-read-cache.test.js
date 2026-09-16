import assert from 'node:assert/strict'
import test from 'node:test'
import worker from '../cloudflare/worker.js'
import { getReleaseStats } from '../packages/ai/queries.js'

function emptyD1(counter) {
  return {
    prepare(sql) {
      return {
        bind() { return this },
        async all() {
          counter.calls++
          counter.sql.push(sql)
          return { results: [] }
        },
        async first() {
          counter.calls++
          counter.sql.push(sql)
          return null
        },
        async run() { return { meta: { changes: 0 } } }
      }
    }
  }
}

test('版本质量重复请求忽略前端 cache-buster 并命中重查询缓存', async () => {
  const counter = { calls: 0, sql: [] }
  const env = { DB: emptyD1(counter), DATA_ACCESS_LEVEL: 'L2' }
  const base = `https://example.com/api/releases/quality?appId=cache-${Date.now()}&dim=release&start=1&end=2`

  const first = await worker.fetch(new Request(`${base}&_t=1`), env)
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('x-d1-read-cache'), 'miss')
  const afterFirst = counter.calls
  assert.ok(afterFirst >= 4, '首次版本质量查询应执行主聚合与分位数查询')

  const second = await worker.fetch(new Request(`${base}&_t=2`), env)
  assert.equal(second.status, 200)
  assert.equal(second.headers.get('x-d1-read-cache'), 'hit')
  assert.equal(counter.calls, afterFirst, '命中缓存后不得再次读取 D1')
})

test('参与度分析重复请求命中重查询缓存', async () => {
  const counter = { calls: 0, sql: [] }
  const env = { DB: emptyD1(counter), DATA_ACCESS_LEVEL: 'L2' }
  const base = `https://example.com/api/analytics/engagement?appId=cache-${Date.now()}&startTime=1&endTime=2`

  const first = await worker.fetch(new Request(`${base}&_t=1`), env)
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('x-d1-read-cache'), 'miss')
  const afterFirst = counter.calls
  assert.ok(afterFirst >= 2, '首次参与度分析应执行 page_leave 与 pv 聚合查询')

  const second = await worker.fetch(new Request(`${base}&_t=2`), env)
  assert.equal(second.status, 200)
  assert.equal(second.headers.get('x-d1-read-cache'), 'hit')
  assert.equal(counter.calls, afterFirst, '命中缓存后不得再次读取 D1')
})

test('AI 单版本统计合并并缓存重复查询', async () => {
  let calls = 0
  const db = {
    prepare() {
      return {
        bind() { return this },
        async all() {
          calls++
          return [{ type: 'error', cnt: 2, perf_avg: null }, { type: 'perf', cnt: 8, perf_avg: 123 }]
        }
      }
    }
  }
  const release = `cache-${Date.now()}`
  const [first, second] = await Promise.all([
    getReleaseStats(db, release, 'app-cache'),
    getReleaseStats(db, release, 'app-cache')
  ])
  assert.deepEqual(first, second)
  assert.equal(calls, 1)
  await getReleaseStats(db, release, 'app-cache')
  assert.equal(calls, 1)
})
