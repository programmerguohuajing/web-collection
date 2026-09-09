import assert from 'node:assert/strict'
import test from 'node:test'
import worker from '../cloudflare/worker.js'

/**
 * 线上回归护栏：生产域名由 Cloudflare Worker/D1 提供服务，
 * worker.js 缺 /api/analytics/retention 会直接落到 `return new Response('not found', { status: 404 })`，
 * 前端因此整页报 not found（2026-09 线上缺陷根因）。本用例锁定「路由存在 + 双端同结构」。
 */

const DAY_MS = 86400000
const BASE_DAY = 20000
const END_MS = (BASE_DAY + 30) * DAY_MS // endDay = 20030
const ROWS = [
  { uid: 'u1', day: BASE_DAY }, { uid: 'u1', day: BASE_DAY + 1 }, { uid: 'u1', day: BASE_DAY + 7 },
  { uid: 'u2', day: BASE_DAY }, { uid: 'u2', day: BASE_DAY + 2 },
  { uid: 'u3', day: BASE_DAY + 1 }
]

/** 最小 D1 桩：记录 SQL/参数并返回固定 (uid, day) 行 */
function envStub(rows = ROWS) {
  const state = { sql: '', values: [] }
  return {
    state,
    env: {
      DB: {
        prepare(sql) {
          state.sql = sql
          return {
            bind(...values) {
              state.values = values
              return { all: async () => ({ results: rows }) }
            }
          }
        }
      }
    }
  }
}

function get(path, stub) {
  return worker.fetch(new Request(`https://example.com${path}`), stub.env, { waitUntil: () => {} })
}

test('worker：/api/analytics/retention 已注册（不再 404 not found）', async () => {
  const stub = envStub()
  const res = await get(`/api/analytics/retention?startTime=1&endTime=${END_MS}`, stub)
  assert.equal(res.status, 200, 'worker 必须命中留存路由，而不是落到兜底 404')
  const body = await res.json()
  assert.equal(body.total, 2, '两个同期群（首访日 20000 / 20001）')
  assert.equal(body.totalUsers, 3)
})

test('worker：留存 SQL 为 D1/SQLite 方言（无 PG ::integer，含 group by 去重）', async () => {
  const stub = envStub()
  await get(`/api/analytics/retention?startTime=1&endTime=${END_MS}`, stub)
  const sql = stub.state.sql.replace(/\s+/g, ' ')
  assert.ok(!/::integer/.test(sql), 'D1 不支持 PG 的 ::integer 强转')
  assert.ok(/cast\(ts \/ 86400000 as integer\)/.test(sql), '日切需为 cast(ts / 86400000 as integer)')
  assert.ok(/group by uid, day/.test(sql), '(uid, day) 去重下推 SQL，减少返回行数')
  assert.ok(/type='behavior'/.test(sql) && /name='pv'/.test(sql), '数据源仍为 behavior/pv')
  assert.deepEqual(stub.state.values, [1, END_MS])
})

test('worker：appId 过滤与参数绑定顺序', async () => {
  const stub = envStub()
  await get(`/api/analytics/retention?startTime=1&endTime=${END_MS}&appId=demo`, stub)
  assert.ok(/app_id=\?/.test(stub.state.sql))
  assert.deepEqual(stub.state.values, [1, END_MS, 'demo'])
})

test('worker：响应结构与 Node 端一致（offsets/average/items/complete/caliber）', async () => {
  const stub = envStub()
  const body = await (await get(`/api/analytics/retention?startTime=1&endTime=${END_MS}&offsets=7,3,3&page=1&pageSize=100`, stub)).json()
  assert.deepEqual(body.offsets, [0, 3, 7], '去重 + 升序 + 恒含 0')
  assert.equal(body.minSample, 30)
  assert.ok(typeof body.caliber === 'string' && body.caliber.length > 0)

  const first = body.items.find(item => item.cohortDay === BASE_DAY)
  assert.equal(first.size, 2)
  assert.equal(first.retention.find(r => r.day === 0).rate, 1, 'day0 恒 100%')
  assert.equal(first.retention.find(r => r.day === 7).users, 1)
  assert.ok(first.retention.every(r => 'day' in r && 'users' in r && 'rate' in r))
  assert.equal(first.sampleNote, '样本量不足，仅供参考')

  const avg = Object.fromEntries(body.average.map(r => [r.day, r]))
  assert.equal(avg[0].users, 3, '平均留存按群规模加权')
  assert.equal(avg[0].rate, 1)
})

test('worker：complete 标记窗口成熟度（maxOffset 决定）', async () => {
  const withSmallOffset = await (await get(`/api/analytics/retention?startTime=1&endTime=${END_MS}&offsets=0,7`, envStub())).json()
  assert.equal(withSmallOffset.items.find(i => i.cohortDay === BASE_DAY + 1).complete, true, '20001+7 <= 20030')

  const withDefaultOffset = await (await get(`/api/analytics/retention?startTime=1&endTime=${END_MS}`, envStub())).json()
  assert.deepEqual(withDefaultOffset.offsets, [0, 1, 2, 3, 7, 14, 30])
  assert.equal(withDefaultOffset.items.find(i => i.cohortDay === BASE_DAY + 1).complete, false, '20001+30 > 20030')
})

test('worker：空数据与未知路径不误伤既有分发', async () => {
  const stub = envStub([])
  const body = await (await get(`/api/analytics/retention?startTime=1&endTime=${END_MS}`, stub)).json()
  assert.equal(body.total, 0)
  assert.equal(body.totalUsers, 0)
  assert.ok(body.average.every(r => r.rate === 0))

  const unknown = await get('/api/analytics/retention/unknown', envStub())
  assert.equal(unknown.status, 404, '未注册路径仍应 404')
})

test('worker：offsets 边界（空串 / 非法 / 超 12 档 / 越界天数）', async () => {
  const off = async value => (await (await get(`/api/analytics/retention?startTime=1&endTime=${END_MS}&offsets=${encodeURIComponent(value)}`, envStub())).json()).offsets
  // 空串与非法值均回落默认档位；恒含 0、去重、升序
  assert.deepEqual(await off(''), [0, 1, 2, 3, 7, 14, 30])
  assert.deepEqual(await off('   '), [0, 1, 2, 3, 7, 14, 30])
  assert.deepEqual(await off('abc'), [0, 1, 2, 3, 7, 14, 30])
  // 非法项被丢弃，合法项保留并补 0
  assert.deepEqual(await off('abc,7,x,,3'), [0, 3, 7])
  assert.deepEqual(await off('-1,7'), [0, 7])
  assert.deepEqual(await off('366,7'), [0, 7])
  // 超 12 档截断，防止 offsets=0..365 把响应撑爆
  const truncated = await off('0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,30')
  assert.equal(truncated.length, 12, '最多 12 档')
  assert.deepEqual(truncated, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
})

test('worker：时间参数非法/缺省不 500，分页参数兜底', async () => {
  for (const query of [
    `startTime=abc&endTime=${END_MS}`,
    `startTime=1&endTime=xyz`,
    `startTime=${END_MS}&endTime=1`, // start > end
    '', // 全缺省：回落最近 30 天
    `startTime=1&endTime=${END_MS}&page=0&pageSize=0`,
    `startTime=1&endTime=${END_MS}&page=abc&pageSize=abc`,
    `startTime=1&endTime=${END_MS}&pageSize=9999`
  ]) {
    const res = await get(`/api/analytics/retention?${query}`, envStub())
    assert.equal(res.status, 200, `脏参数不应 500：${query || '(空)'}`)
  }
  // pageSize 上限 100：pageSize=9999 不应把 items 撑爆（本例仅 2 群，断言结构完整即可）
  const body = await (await get(`/api/analytics/retention?startTime=1&endTime=${END_MS}&pageSize=9999`, envStub())).json()
  assert.equal(body.total, 2)
  assert.equal(body.items.length, 2)
  // 默认分页：未提供 page/pageSize 时 items 仍可返回
  const paged = await (await get(`/api/analytics/retention?startTime=1&endTime=${END_MS}&page=2&pageSize=1`, envStub())).json()
  assert.equal(paged.total, 2, 'total 是同期群总数，不受分页影响')
  assert.equal(paged.items.length, 1)
  assert.equal(paged.items[0].cohortDay, BASE_DAY + 1)
})

test('worker：脏 day（超 Date 范围）不 500，cohortDate 降级回显原值', async () => {
  const stub = envStub([{ uid: 'uX', day: 200000000 }, { uid: 'uY', day: BASE_DAY }])
  const res = await get(`/api/analytics/retention?startTime=1&endTime=${END_MS}`, stub)
  assert.equal(res.status, 200, '一行脏数据不得打挂整个接口')
  const body = await res.json()
  assert.equal(body.items.find(i => i.cohortDay === 200000000).cohortDate, '200000000')
  assert.equal(body.items.find(i => i.cohortDay === BASE_DAY).cohortDate, '2024-10-04')
})

test('worker：group by 下推后聚合幂等（重复 (uid, day) 不改变结果）', async () => {
  const uniq = [{ uid: 'u1', day: BASE_DAY }, { uid: 'u1', day: BASE_DAY + 1 }, { uid: 'u2', day: BASE_DAY }]
  const dup = []
  for (let i = 0; i < 50; i++) for (const row of uniq) dup.push({ ...row })
  const a = await (await get(`/api/analytics/retention?startTime=1&endTime=${END_MS}`, envStub(uniq))).json()
  const b = await (await get(`/api/analytics/retention?startTime=1&endTime=${END_MS}`, envStub(dup))).json()
  assert.deepEqual(b, a, '同一 (uid, day) 重复 50 次必须与去重后完全一致')
  assert.equal(a.total, 1)
  assert.equal(a.totalUsers, 2)
})

test('worker：新增分支为精确匹配，不截获相邻/正则路由', async () => {
  // 精确匹配：多余后缀不被吞掉
  assert.equal((await get('/api/analytics/retention2', envStub())).status, 404)
  // 前置正则路由 /^\/api\/analytics\/sessions\// 仍能被分发（落到 sessionEvents，查询 session_id）
  const stub = envStub([])
  await get('/api/analytics/sessions/s1', stub).catch(() => {})
  assert.ok(/session_id=\?/.test(stub.state.sql), '/api/analytics/sessions/:id 仍需命中正则分支，而非被留存路由截获')
  // 紧随其后的 /api/analytics/api-health 仍可达（非 404）
  assert.notEqual((await get('/api/analytics/api-health?startTime=1&endTime=' + END_MS, envStub())).status, 404)
})
