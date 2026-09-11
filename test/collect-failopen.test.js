import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * 采集端 fail-open 契约：/api/collect 永不因平台侧故障（D1 rows_read 打满 /
 * applications 查询失败）返回 5xx（2026-09-11 线上事故：D1 日配额超限期间
 * 采集端收到 500 风暴 + SDK 控制台满屏报错）。
 *
 * 修复：applications 配置查询 .catch(() => null) 降级（跳过采样配置与
 * collect_key 校验），采集端始终拿到 2xx ACK；落库失败由 ingestionMonitor
 * 计数 + 自动告警暴露。
 */

async function loadWorker() {
  const { default: worker } = await import('../cloudflare/worker.js')
  return worker
}

/** mock env.DB：applications 查询抛错（模拟 D1 配额超限），其余查询按 handler 返回。 */
function failingApplicationsDb(recordImpl = null) {
  return {
    DB: {
      prepare(sql) {
        return {
          bind() { return this },
          async first() {
            if (sql.includes('from applications')) throw new Error('D1_ERROR: too many reads')
            return null
          },
          async all() { return { results: [] } },
          async run() { recordImpl?.(sql); return { success: true, results: [], meta: {} } }
        }
      }
    }
  }
}

test('collect：applications 查询失败（D1 超限）仍返回 200，不再 500', async () => {
  const worker = await loadWorker()
  const env = failingApplicationsDb()
  const res = await worker.fetch(new Request('https://example.com/api/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ type: 'track', appId: 'demo', name: 'click', ts: Date.now() }] })
  }), env, { waitUntil() {} })
  assert.equal(res.status, 200, `应 200 fail-open，实际 ${res.status}`)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.accepted, 1)
})

test('collect：D1 正常时鉴权仍生效（fail-open 不弱化正常路径）', async () => {
  const worker = await loadWorker()
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind() { return this },
          async first() {
            if (sql.includes('from applications')) {
              return { enabled: 1, sample_rate: 1, replay_sample_rate: 1, collect_key_hash: 'a'.repeat(64), rules_json: null, team_id: null }
            }
            return null
          },
          async all() { return { results: [] } },
          async run() { return { success: true, results: [], meta: {} } }
        }
      }
    }
  }
  const res = await worker.fetch(new Request('https://example.com/api/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ type: 'track', appId: 'demo', name: 'click' }] })
  }), env, { waitUntil() {} })
  // 配置了 collect_key_hash 且未携带正确 x-app-key → 401（原有鉴权语义保留）
  assert.equal(res.status, 401)
})
