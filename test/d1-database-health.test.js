import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  decodeReplayEventsFromStorage,
  encodeReplayEventsForStorage,
  shouldRunHourlyRollupW
} from '../cloudflare/worker.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('D1 写放大迁移只删除已审计的冗余索引', () => {
  const sql = readFileSync(path.join(ROOT, 'cloudflare/migrations/0040_reduce_d1_write_amplification.sql'), 'utf8')
  for (const name of [
    'idx_events_event_id',
    'idx_events_request_id',
    'idx_events_app_version',
    'idx_metric_daily_app_metric_day'
  ]) assert.match(sql, new RegExp(`drop index if exists ${name}`))
  assert.doesNotMatch(sql, /drop\s+(?:table|column)/i)
})

test('小时汇总只接受 */5 cron 的整点计划时间', () => {
  assert.equal(shouldRunHourlyRollupW(Date.UTC(2026, 8, 13, 3, 0)), true)
  assert.equal(shouldRunHourlyRollupW(Date.UTC(2026, 8, 13, 3, 5)), false)
  assert.equal(shouldRunHourlyRollupW(Date.UTC(2026, 8, 13, 3, 55)), false)
})

test('回放写入使用 gzip 文本并可无损读取，同时兼容历史明文 JSON', async () => {
  const events = [
    { type: 4, timestamp: 1, data: { width: 390, height: 844 } },
    { type: 2, timestamp: 2, data: { node: { id: 1, textContent: '页面'.repeat(10000) } } },
    { type: 3, timestamp: 3, data: { source: 1 } }
  ]
  const chunks = await encodeReplayEventsForStorage(events)
  assert.equal(chunks.length, 1)
  assert.match(chunks[0], /^gzip:/)
  assert.ok(chunks[0].length < JSON.stringify(events).length)
  assert.deepEqual(await decodeReplayEventsFromStorage(chunks[0]), events)
  assert.deepEqual(await decodeReplayEventsFromStorage(JSON.stringify(events)), events)
})

test('数据库保留期清理覆盖 Cloudflare 与 Node 已有口径以及新增增长表', () => {
  const worker = readFileSync(path.join(ROOT, 'cloudflare/worker.js'), 'utf8')
  for (const sql of [
    "delete from issues where status='resolved' and last_seen<?",
    'delete from spans where ts<?',
    'delete from sdk_monitoring where ts<?'
  ]) assert.ok(worker.includes(sql), `缺少清理语句：${sql}`)
  assert.doesNotMatch(worker, /async function hourlyRollupW[\s\S]{0,1200}await metricDailyRollupW\(env\)/)
})

test('cron 数据库查询预算有界且告警重试不在多个 cron 重复执行', () => {
  const worker = readFileSync(path.join(ROOT, 'cloudflare/worker.js'), 'utf8')
  assert.match(worker, /missing\.filter\(d => d < today\)\.slice\(0, 5\)/)
  assert.match(worker, /alert_deliveries[\s\S]*?order by updated_at limit 5/)
  const scheduled = worker.slice(worker.indexOf('async scheduled('), worker.indexOf('\n  }\n}', worker.indexOf('async scheduled(')))
  assert.equal((scheduled.match(/retryPendingAlertDeliveries\(env\)/g) || []).length, 1)
  assert.match(scheduled, /controller\.cron === '\* \* \* \* \*'[\s\S]*retryPendingAlertDeliveries\(env\)/)
})
