import assert from 'node:assert/strict'
import test from 'node:test'
import { getIngestionHealth } from '../apps/api/src/services/sdk-health-service.js'

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
