import test from 'node:test'
import assert from 'node:assert/strict'

// 回放会话治理（超长会话截断 + 资源内联）的单元测试：
// 1. truncateReplaySpan：30 分钟跨度上限截断（对齐 Cloudflare Worker 端 REPLAY_SPAN_LIMIT_MS）
// 2. createReplayAssetInliner：同源图片/样式资源转 dataURI（mock fetch + location）
// 3. Worker replayEvents：响应信封 {events, truncated, ...} 与轮换 base 前缀匹配

import { truncateReplaySpan, REPLAY_SPAN_LIMIT_MS } from '../apps/api/src/replay-ingest.js'
import { createReplayAssetInliner } from '../packages/sdk/src/replay/inline-assets.js'

const MIN = 60 * 1000

/** 构造 rrweb 风格事件流：Meta(4) → FullSnapshot(2) → 增量(3)*n */
function makeEvents({ spanMs, snapshotEveryMin = 10 } = {}) {
  const events = [
    { type: 4, timestamp: 0, data: { width: 390, height: 844, href: 'https://h5.example.com/rent' } },
    { type: 2, timestamp: 0, data: { node: { id: 1, type: 0, childNodes: [] } } },
    { type: 3, timestamp: 1000, data: { source: 0 } }
  ]
  for (let t = snapshotEveryMin * MIN; t <= spanMs; t += snapshotEveryMin * MIN) {
    events.push({ type: 2, timestamp: t, data: { node: { id: 2, type: 0, childNodes: [] } } })
    events.push({ type: 3, timestamp: t + 500, data: { source: 0 } })
  }
  return events
}

test('truncateReplaySpan：跨度未超限原样返回', () => {
  const events = makeEvents({ spanMs: 20 * MIN })
  const r = truncateReplaySpan(events)
  assert.equal(r.truncated, false)
  assert.equal(r.events, events)
  assert.equal(r.originalSpanMs, events[events.length - 1].timestamp - events[0].timestamp)
})

test('truncateReplaySpan：超限截取最近 30 分钟且以全量快照开头', () => {
  // 模拟线上实测：1044 分钟会话（首事件 0，末事件 1044min，快照每 10 分钟）
  const events = makeEvents({ spanMs: 1044 * MIN })
  const r = truncateReplaySpan(events)
  assert.equal(r.truncated, true)
  assert.equal(r.originalSpanMs, events[events.length - 1].timestamp - events[0].timestamp)
  // 截断后跨度 ≤ 30 分钟；快照间隔 10 分钟时窗口为 (20, 30] 分钟
  assert.ok(r.spanMs <= REPLAY_SPAN_LIMIT_MS, `spanMs=${r.spanMs} 应 ≤ 30min`)
  assert.ok(r.spanMs > 20 * MIN, `spanMs=${r.spanMs} 应贴近 30 分钟窗口`)
  // 输出流以快照（或其紧邻 Meta）开头，保证 rrweb 可重建
  const first = r.events[0]
  assert.ok(first.type === 2 || first.type === 4, `首事件 type=${first.type} 应为快照或 Meta`)
  assert.ok(r.events.some(e => e.type === 2), '截断流必须含全量快照')
  // 尾部事件保留（截取的是最近窗口）
  assert.equal(r.events[r.events.length - 1], events[events.length - 1])
})

test('truncateReplaySpan：窗口内无快照不截断（宁可超长也不黑屏）', () => {
  const events = [
    { type: 4, timestamp: 0, data: {} },
    { type: 2, timestamp: 0, data: {} },
    { type: 3, timestamp: 90 * MIN, data: {} } // 仅一份快照在 0 点，30 分钟窗口内无快照
  ]
  const r = truncateReplaySpan(events)
  assert.equal(r.truncated, false)
  assert.equal(r.events.length, 3)
})

test('truncateReplaySpan：空流与单事件安全返回', () => {
  assert.deepEqual(truncateReplaySpan([]), { events: [], truncated: false, originalSpanMs: 0, spanMs: 0 })
  const single = [{ type: 2, timestamp: 5, data: {} }]
  const r = truncateReplaySpan(single)
  assert.equal(r.truncated, false)
  assert.equal(r.events, single)
})

test('createReplayAssetInliner：同源 img src 与 _cssText url() 内联为 dataURI', async () => {
  // mock 浏览器环境（node 无 location/btoa 之外的 DOM API）
  const realLocation = globalThis.location
  const realFetch = globalThis.fetch
  const pngBase64 = Buffer.from('fake-png-bytes').toString('base64')
  globalThis.location = { href: 'http://192.168.17.45:8010/rent', origin: 'http://192.168.17.45:8010' }
  globalThis.fetch = async url => {
    assert.equal(String(url), 'http://192.168.17.45:8010/static/img/icon.png')
    return {
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new TextEncoder().encode('fake-png-bytes').buffer
    }
  }
  try {
    const inliner = createReplayAssetInliner()
    const events = [{
      type: 2,
      data: {
        node: {
          id: 1, type: 1, tagName: 'body',
          childNodes: [
            { id: 2, type: 2, tagName: 'img', attributes: { src: '/static/img/icon.png' } },
            { id: 3, type: 2, tagName: 'link', attributes: { href: 'src/app.css', _cssText: '.a{background-image:url("/static/img/icon.png")}' } }
          ]
        }
      }
    }]
    await inliner.inline(events)
    const [img, link] = events[0].data.node.childNodes
    assert.ok(img.attributes.src.startsWith('data:image/png;base64,'), `img src 应为 dataURI：${img.attributes.src}`)
    assert.ok(link.attributes._cssText.includes('data:image/png;base64,'), 'cssText 中 url 应被替换')
    assert.ok(!link.attributes._cssText.includes('/static/img/icon.png'), '原 URL 不应残留')
    assert.equal(inliner.stats().inlined, 1)
  } finally {
    globalThis.location = realLocation
    globalThis.fetch = realFetch
  }
})

test('createReplayAssetInliner：跨域资源跳过（回放端按需直连），失败静默', async () => {
  const realLocation = globalThis.location
  const realFetch = globalThis.fetch
  globalThis.location = { href: 'https://app.example.com/page', origin: 'https://app.example.com' }
  globalThis.fetch = async () => { throw new Error('network down') }
  try {
    const inliner = createReplayAssetInliner()
    const events = [{
      type: 2,
      data: {
        node: {
          id: 1, type: 1,
          childNodes: [
            { id: 2, type: 2, attributes: { src: 'https://cdn.other.com/x.png' } },       // 跨域：不 fetch
            { id: 3, type: 2, attributes: { src: 'https://app.example.com/y.png' } }      // 同源但 fetch 失败：保留原样
          ]
        }
      }
    }]
    await inliner.inline(events)
    assert.equal(events[0].data.node.childNodes[0].attributes.src, 'https://cdn.other.com/x.png')
    assert.equal(events[0].data.node.childNodes[1].attributes.src, 'https://app.example.com/y.png')
    assert.equal(inliner.stats().inlined, 0)
  } finally {
    globalThis.location = realLocation
    globalThis.fetch = realFetch
  }
})

test('createReplayAssetInliner：单资源超限跳过（护栏）', async () => {
  const realLocation = globalThis.location
  const realFetch = globalThis.fetch
  globalThis.location = { href: 'http://a.local/', origin: 'http://a.local' }
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => new ArrayBuffer(2 * 1024 * 1024) // 2MB > 默认 1MB 上限
  })
  try {
    const inliner = createReplayAssetInliner({ maxBytes: 1024 * 1024 })
    const events = [{ type: 2, data: { node: { id: 1, type: 2, attributes: { src: 'http://a.local/big.png' } } } }]
    await inliner.inline(events)
    assert.equal(events[0].data.node.attributes.src, 'http://a.local/big.png')
    assert.ok(inliner.stats().skipped >= 1)
  } finally {
    globalThis.location = realLocation
    globalThis.fetch = realFetch
  }
})

// ---------------- Worker 端 replayEvents：信封结构 + 轮换 base 前缀匹配 ----------------

async function loadWorker() {
  const { default: worker } = await import('../cloudflare/worker.js')
  return worker
}

function replayRowsDb(rows) {
  return {
    prepare(sql) {
      let values = []
      return {
        bind(...bound) { values = bound; return this },
        async all() {
          if (sql.includes('from replays where session_id=?')) return { results: [] }
          if (sql.includes('base_session_id like ?')) {
            // 前缀匹配：base = `${id}_%` 应命中轮换后的 `_r1` 行
            const p = String(values[0] || '')
            return { results: rows.filter(r => String(r.base_session_id || '').startsWith(p.slice(0, -1))) }
          }
          if (sql.includes('base_session_id=?')) return { results: rows.filter(r => r.base_session_id === values[0]) }
          return { results: [] }
        },
        async first() {
          if (sql.includes('from replays where session_id=?')) {
            return rows.find(r => r.session_id === values[0]) || null
          }
          return null
        }
      }
    }
  }
}

test('worker replayEvents：超长会话返回截断信封，轮换 base（_r1）经前缀匹配命中', async () => {
  const worker = await loadWorker()
  const spanMs = 1044 * MIN
  const seg1 = JSON.stringify([
    { type: 4, timestamp: 0, data: { width: 390, height: 844 } },
    { type: 2, timestamp: 0, data: { node: { id: 1 } } },
    { type: 3, timestamp: 60 * 1000, data: {} }
  ])
  const seg2 = JSON.stringify([
    { type: 4, timestamp: spanMs - 10 * MIN, data: { width: 390, height: 844 } },
    { type: 2, timestamp: spanMs - 10 * MIN, data: { node: { id: 9 } } },
    { type: 3, timestamp: spanMs, data: {} }
  ])
  const rows = [
    { session_id: 's1_r1_seg1', base_session_id: 's1_r1', events_json: seg1 },
    { session_id: 's1_r1_seg2', base_session_id: 's1_r1', events_json: seg2 }
  ]
  const res = await worker.fetch(new Request('https://example.com/api/replays/s1'), { DB: replayRowsDb(rows) })
  assert.equal(res.status, 200)
  const body = await res.json()
  // 信封结构（前端已兼容 {events}）
  assert.ok(Array.isArray(body.events), '应返回 events 数组')
  assert.equal(body.truncated, true, '1044 分钟跨度应截断')
  assert.equal(body.originalSpanMs, spanMs)
  // 截断后以快照/Meta 开头且跨度 ≤ 30 分钟
  assert.ok(body.events[0].type === 2 || body.events[0].type === 4)
  assert.ok(body.spanMs <= 30 * MIN)
  assert.ok(body.events.some(e => e.type === 2))
})

test('worker replayEvents：无数据返回空信封（不再是裸空数组）', async () => {
  const worker = await loadWorker()
  const res = await worker.fetch(new Request('https://example.com/api/replays/none'), { DB: replayRowsDb([]) })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.events, [])
  assert.equal(body.truncated, false)
})
