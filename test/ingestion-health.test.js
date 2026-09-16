import assert from 'node:assert/strict'
import test from 'node:test'
import { getDiagnostics, getIngestionHealth, getSdkSize } from '../apps/api/src/services/sdk-health-service.js'

test('getIngestionHealth 返回入库链路状态结构', async () => {
  const res = await getIngestionHealth()
  assert.ok(res && typeof res === 'object')
  assert.ok(res.ingestion)
  assert.ok(['healthy', 'degraded', 'critical'].includes(res.ingestion.status))
  assert.ok(res.ingestion.stalledMs === null || typeof res.ingestion.stalledMs === 'number')
  assert.ok(typeof res.ingestion.writtenLast1h === 'number')
  assert.ok(typeof res.ingestion.failed === 'number')
  assert.ok(typeof res.ingestion.ingestErrorCount === 'number')
})

test('getDiagnostics 返回接入配置有效性事实派生结构', async () => {
  const res = await getDiagnostics({ appId: 'demo-app' })
  assert.ok(res && typeof res === 'object')
  assert.equal(res.appId, 'demo-app')
  assert.ok(['healthy', 'degraded', 'critical'].includes(res.status))
  assert.ok(typeof res.receivedLast1h === 'number')
  assert.ok(typeof res.ingestErrorCount === 'number')
})

test('getSdkSize 无数据库记录时自动测算本地 SDK 构建包', async () => {
  const res = await getSdkSize()
  assert.ok(res && typeof res === 'object')
  assert.equal(res.hasData, true)
  assert.ok(Array.isArray(res.list) && res.list.length > 0)
  assert.ok(res.list[0].rawBytes > 0)
  assert.ok(res.list[0].gzBytes > 0)
})
