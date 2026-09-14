import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * 网络错误告警风暴聚合（2026-09-14 线上事故回归）：
 *
 * 断网/代理故障时应用全部请求同时失败——实测 ts-app-uni 在 24 秒内 24 个不同 URL
 * （静态资源 SVG/PNG + 页面 + IM 接口）全部 fetch 失败。issue 指纹按 source URL
 * 细分（正确，问题列表可逐接口定位），但告警去重此前也复用同一指纹 → 24 个不同
 * 指纹全部穿透冷却去重 → 飞书连收 24 条内容完全相同的
 * 「[Web Collection] ts-app-uni FetchError: Failed to fetch」。
 *
 * 修复：网络类错误（Fetch/XHR/Resource/SSE/WebSocket 的 network/aborted/timeout）
 * 告警指纹去掉 URL 维度，聚合为「应用|错误名|错误类型|消息」；同冷却窗口只发一条，
 * 且消息带上首个失败请求的 URL。issues 表保持按 URL 细分，互不影响。
 */

async function loadWorker() {
  const mod = await import('../cloudflare/worker.js')
  return { worker: mod.default, alertMessage: mod.alertMessage, alertFingerprint: mod.alertFingerprint }
}

test('alertFingerprint：网络类错误不同 URL 聚合为同一告警指纹', async () => {
  const { alertFingerprint } = await loadWorker()
  const base = { appId: 'ts-app-uni', type: 'error', name: 'FetchError', message: 'Failed to fetch' }
  const a = await alertFingerprint({ ...base, props: { source: 'http://x/static/a.svg', errorType: 'network' } }, { fingerprint: 'issue-a' })
  const b = await alertFingerprint({ ...base, props: { source: 'http://x/static/b.png', errorType: 'network' } }, { fingerprint: 'issue-b' })
  const c = await alertFingerprint({ ...base, props: { source: 'http://x/static/a.svg', errorType: 'aborted' } }, { fingerprint: 'issue-c' })
  const d = await alertFingerprint({ ...base, props: { source: 'http://x/static/a.svg', errorType: 'http', status: 500 } }, { fingerprint: 'issue-d' })
  assert.equal(a, b, '同 errorType 同消息、不同 URL 的网络错误应聚合为同一告警指纹')
  assert.notEqual(a, c, '不同 errorType（network vs aborted）应区分')
  assert.notEqual(a, d, 'HTTP 状态码错误（errorType=http）不属于连接层失败，不参与聚合')
  // 非网络类错误保留 issue 指纹（每个问题独立告警，不误伤）
  const js1 = await alertFingerprint({ ...base, name: 'TypeError', props: {}, stack: 'TypeError: x\nat f1\nat f2' }, { fingerprint: 'issue-js1' })
  const js2 = await alertFingerprint({ ...base, name: 'TypeError', props: {}, stack: 'TypeError: y\nat f1\nat f2' }, { fingerprint: 'issue-js2' })
  assert.equal(js1, 'issue-js1')
  assert.equal(js2, 'issue-js2')
})

test('alertMessage：网络类错误消息包含失败请求 URL', async () => {
  const { alertMessage } = await loadWorker()
  const msg = alertMessage({
    appId: 'ts-app-uni', type: 'error', name: 'FetchError', message: 'Failed to fetch',
    props: { source: 'http://192.168.17.45:8010/static/images/home/a.svg', errorType: 'network' },
    path: '/pages/home/index', release: '1.1.0', traceId: 't1'
  }, 'error', 1)
  assert.ok(msg.includes('请求 http://192.168.17.45:8010/static/images/home/a.svg'), `消息应含请求 URL：${msg}`)
  // 非网络错误不带「请求」段
  const plain = alertMessage({ appId: 'app', type: 'error', name: 'TypeError', message: 'x is not a function', props: {}, path: '/p' }, 'error', 1)
  assert.ok(!plain.includes('请求 '), plain)
  // perf 消息格式不受影响
  const perf = alertMessage({ appId: 'app', type: 'perf', metric: 'lcp', value: 5200, path: '/p' }, 'lcp', 4000)
  assert.ok(perf.includes('LCP 5200ms'), perf)
})

/**
 * 有状态 mock D1：覆盖 collect → record → alert 链路的全部查询。
 * alert_history 用内存数组模拟「冷却去重 SELECT / INSERT / value 自增」。
 */
function stormEnv() {
  const state = { alerts: [], nextId: 1 }
  const db = {
    prepare(sql) {
      return {
        _vals: [],
        bind(...vals) { this._vals = vals; return this },
        async first() {
          if (sql.includes('from applications')) {
            return { enabled: 1, sample_rate: 1, replay_sample_rate: 1, collect_key_hash: null, rules_json: null, team_id: null }
          }
          if (sql.includes('from alert_history where id=?')) {
            const [id] = this._vals
            return state.alerts.find(a => a.id === id) || null
          }
          if (sql.includes('from alert_history where')) {
            // 冷却去重：app_id + metric + fingerprint + created_at>=since
            const [appId, metric, fingerprint, since] = this._vals
            return state.alerts.find(a => a.app_id === appId && a.metric === metric && a.fingerprint === fingerprint && a.created_at >= since) || null
          }
          if (sql.includes('from alert_deliveries')) return { total: 0, sent: 0, failed: 0 }
          return null
        },
        async all() { return { results: [] } },
        async run() {
          if (sql.includes('insert into alert_history')) {
            const [appId, metric, fingerprint, level, value, message] = this._vals
            const row = { id: state.nextId++, app_id: appId, metric, fingerprint, level, value: Number(value) || 1, message, created_at: Date.now(), context_json: '{}' }
            state.alerts.push(row)
            return { success: true, meta: { last_row_id: row.id } }
          }
          if (sql.includes('update alert_history set value=value+1')) {
            const [id] = this._vals
            const row = state.alerts.find(a => a.id === id)
            if (row) row.value = Number(row.value) + 1
            return { success: true, meta: {} }
          }
          return { success: true, meta: { last_row_id: state.nextId++ } }
        }
      }
    }
  }
  return { env: { DB: db }, state }
}

// mock ctx：收集 waitUntil 提交的异步任务（落库/告警都在其中），测试里显式 await 后再断言
function trackCtx() {
  const pending = []
  const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})) } }
  return { ctx, done: () => Promise.all(pending) }
}

function collectRequest(events) {
  return new Request('https://example.com/api/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events })
  })
}

test('collect 断网风暴：24 个不同 URL 的网络错误在同一窗口只产生 1 条告警', async () => {
  const { worker } = await loadWorker()
  const { env, state } = stormEnv()
  const urls = Array.from({ length: 24 }, (_, i) => `http://192.168.17.45:8010/static/images/img${i}.svg`)
  const events = urls.map(url => ({
    type: 'error', appId: 'ts-app-uni', name: 'FetchError', message: 'Failed to fetch',
    props: { source: url, errorType: 'network' },
    ts: Date.now(), url: 'http://192.168.17.45:8010/pages/home/index', path: '/pages/home/index', release: '1.1.0'
  }))
  const t = trackCtx()
  const res = await worker.fetch(collectRequest(events), env, t.ctx)
  await t.done()
  assert.equal(res.status, 200)
  assert.equal(state.alerts.length, 1, `24 个网络错误应聚合为 1 条告警，实际 ${state.alerts.length}`)
  assert.equal(state.alerts[0].value, 24, '告警 value 应累加为窗口内发生次数（1+23 次抑制）')
  assert.ok(state.alerts[0].message.includes('请求 '), `消息应含失败请求 URL：${state.alerts[0].message}`)
})

test('collect 跨请求风暴：两个批次的不同 URL 网络错误仍只告警一次', async () => {
  const { worker } = await loadWorker()
  const { env, state } = stormEnv()
  const batch1 = [{ type: 'error', appId: 'app', name: 'FetchError', message: 'Failed to fetch', props: { source: 'http://x/a.svg', errorType: 'network' }, ts: Date.now(), path: '/p' }]
  const batch2 = [{ type: 'error', appId: 'app', name: 'FetchError', message: 'Failed to fetch', props: { source: 'http://x/b.svg', errorType: 'network' }, ts: Date.now(), path: '/p' }]
  const t1 = trackCtx()
  const res1 = await worker.fetch(collectRequest(batch1), env, t1.ctx)
  const t2 = trackCtx()
  const res2 = await worker.fetch(collectRequest(batch2), env, t2.ctx)
  assert.equal(res1.status, 200)
  assert.equal(res2.status, 200)
  await t1.done()
  await t2.done()
  assert.equal(state.alerts.length, 1, '跨请求也应命中冷却去重')
  assert.equal(state.alerts[0].value, 2)
})

test('collect 非网络错误：不同问题仍各自告警（聚合不误伤）', async () => {
  const { worker } = await loadWorker()
  const { env, state } = stormEnv()
  const events = [
    { type: 'error', appId: 'app', name: 'TypeError', message: 'a is not a function', stack: 'TypeError: a\nat f1\nat f2', props: {}, ts: Date.now(), path: '/p1' },
    { type: 'error', appId: 'app', name: 'TypeError', message: 'b is not a function', stack: 'TypeError: b\nat f1\nat f2', props: {}, ts: Date.now(), path: '/p2' }
  ]
  const t = trackCtx()
  const res = await worker.fetch(collectRequest(events), env, t.ctx)
  await t.done()
  assert.equal(res.status, 200)
  assert.equal(state.alerts.length, 2, '两个不同 JS 错误应各产生一条告警')
  assert.equal(state.alerts.every(a => a.value === 1), true, '无抑制发生时 value 保持 1')
})
