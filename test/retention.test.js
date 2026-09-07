import assert from 'node:assert/strict'
import test from 'node:test'
import { listRetention } from '../apps/api/src/services/retention-service.js'

const DAY_MS = 86400000
const BASE_DAY = 20000

/** 合成 query 桩：直接返回 (uid, day) 行，绕过 PG */
function queryStub(rows) {
  return async () => rows
}

/** 构造行：days 为该用户的活跃日数组 */
function rowsFrom(users) {
  const rows = []
  for (const [uid, days] of Object.entries(users)) {
    for (const day of days) rows.push({ uid, day })
  }
  return rows
}

const END_MS = (BASE_DAY + 30) * DAY_MS // endDay = 20030

test('listRetention：按首访日分群，day0 留存恒为 100%', async () => {
  const rows = rowsFrom({
    u1: [BASE_DAY, BASE_DAY + 1, BASE_DAY + 7],
    u2: [BASE_DAY, BASE_DAY + 2],
    u3: [BASE_DAY + 1]
  })
  const res = await listRetention({ startTime: 1, endTime: END_MS }, queryStub(rows))
  assert.equal(res.total, 2, '两个同期群（首访日 20000 / 20001）')
  assert.equal(res.totalUsers, 3)

  const first = res.items.find(item => item.cohortDay === BASE_DAY)
  assert.equal(first.size, 2)
  const day0 = first.retention.find(r => r.day === 0)
  assert.equal(day0.users, 2)
  assert.equal(day0.rate, 1, 'day0 恒 100%')

  const second = res.items.find(item => item.cohortDay === BASE_DAY + 1)
  assert.equal(second.size, 1)
})

test('listRetention：N 日留存计数与比率正确', async () => {
  const rows = rowsFrom({
    u1: [BASE_DAY, BASE_DAY + 1, BASE_DAY + 7],
    u2: [BASE_DAY, BASE_DAY + 2]
  })
  const res = await listRetention({ startTime: 1, endTime: END_MS }, queryStub(rows))
  const cohort = res.items.find(item => item.cohortDay === BASE_DAY)
  const byDay = Object.fromEntries(cohort.retention.map(r => [r.day, r]))

  assert.equal(byDay[1].users, 1, '第1日：u1 回访')
  assert.equal(byDay[1].rate, 0.5)
  assert.equal(byDay[2].users, 1, '第2日：u2 回访')
  assert.equal(byDay[7].users, 1, '第7日：u1 回访')
  assert.equal(byDay[3].users, 0, '第3日：无人回访')
  assert.equal(byDay[3].rate, 0)
})

test('listRetention：平均留存按群规模加权', async () => {
  const rows = rowsFrom({
    u1: [BASE_DAY, BASE_DAY + 1, BASE_DAY + 7],
    u2: [BASE_DAY, BASE_DAY + 2],
    u3: [BASE_DAY + 1]
  })
  const res = await listRetention({ startTime: 1, endTime: END_MS }, queryStub(rows))
  const avg = Object.fromEntries(res.average.map(r => [r.day, r]))

  assert.equal(avg[0].users, 3)
  assert.equal(avg[0].rate, 1)
  assert.equal(avg[1].users, 1)
  assert.equal(Math.round(avg[1].rate * 10000) / 10000, Math.round((1 / 3) * 10000) / 10000)
})

test('listRetention：uid 为空的行被跳过', async () => {
  const rows = [{ uid: null, day: BASE_DAY }, { uid: '', day: BASE_DAY }, { uid: 'u1', day: BASE_DAY }]
  const res = await listRetention({ startTime: 1, endTime: END_MS }, queryStub(rows))
  assert.equal(res.totalUsers, 1, '仅 u1 计入')
})

test('listRetention：自定义 offsets 解析（去重 + 排序 + 恒含 0）', async () => {
  const rows = rowsFrom({ u1: [BASE_DAY, BASE_DAY + 3] })
  const res = await listRetention({ startTime: 1, endTime: END_MS, offsets: '7,3,3' }, queryStub(rows))
  assert.deepEqual(res.offsets, [0, 3, 7])
  const cohort = res.items[0]
  assert.deepEqual(cohort.retention.map(r => r.day), [0, 3, 7])
  assert.equal(cohort.retention.find(r => r.day === 3).users, 1)
})

test('listRetention：默认 offsets 为 0,1,2,3,7,14,30', async () => {
  const res = await listRetention({ startTime: 1, endTime: END_MS }, queryStub([]))
  assert.deepEqual(res.offsets, [0, 1, 2, 3, 7, 14, 30])
})

test('listRetention：空数据返回零值不报错', async () => {
  const res = await listRetention({ startTime: 1, endTime: END_MS }, queryStub([]))
  assert.equal(res.total, 0)
  assert.equal(res.totalUsers, 0)
  assert.ok(res.average.every(r => r.rate === 0))
  assert.ok(typeof res.caliber === 'string' && res.caliber.length > 0, '返回口径说明')
})

test('listRetention：complete 标记窗口是否成熟', async () => {
  const rows = rowsFrom({
    u1: [BASE_DAY],
    u2: [BASE_DAY + 1]
  })
  const res = await listRetention({ startTime: 1, endTime: END_MS }, queryStub(rows))
  const c0 = res.items.find(item => item.cohortDay === BASE_DAY)
  const c1 = res.items.find(item => item.cohortDay === BASE_DAY + 1)
  assert.equal(c0.complete, true, '20000+30 <= 20030')
  assert.equal(c1.complete, false, '20001+30 > 20030，远期留存被低估')
})

test('listRetention：分页与样本量提示', async () => {
  const users = {}
  for (let i = 0; i < 25; i += 1) users[`u${i}`] = [BASE_DAY]
  const res = await listRetention({ startTime: 1, endTime: END_MS, page: 1, pageSize: 1 }, queryStub(rowsFrom(users)))
  assert.equal(res.items.length, 1, 'pageSize 生效')
  assert.equal(res.items[0].size, 25)
  assert.equal(res.items[0].sampleNote, '样本量不足，仅供参考')
})

test('listRetention：appId 传参时 SQL 带 app_id 条件', async () => {
  let captured = null
  const stub = async (sql, params) => {
    captured = { sql, params }
    return []
  }
  await listRetention({ startTime: 1, endTime: END_MS, appId: 'demo' }, stub)
  assert.ok(captured.sql.includes('app_id = ?'), 'SQL 含 app_id 条件')
  assert.deepEqual(captured.params, [1, END_MS, 'demo'])
})
