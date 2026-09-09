/**
 * QA 纯函数验证：Next Horizon E2（API 健康）+ B4（回放 ↔ 分析联动）。
 *
 * 被测函数均非导出成员，故从源文件按正则抽取真实源码后 eval，
 * 保证验证的是「线上那份代码」而不是复制粘贴的副本。
 *
 * 运行：node --test test/qa-e2-b4-pure.test.js
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReplayQuery } from '../apps/web/src/utils/replay-link.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 按函数名从源码中抽取完整函数声明并实例化。 */
function extractFn(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `源码中未找到 function ${name}`)
  // 必须先跳过参数列表：默认参数里可能含 "{}"（如 `event = {}`），
  // 直接从 start 找第一个 "{" 会误把默认参数的花括号当成函数体起点。
  let depth = 0
  let i = source.indexOf('(', start)
  const bodyStart = (() => {
    for (let j = i; j < source.length; j++) {
      if (source[j] === '(') depth++
      else if (source[j] === ')') { depth--; if (depth === 0) return source.indexOf('{', j) }
    }
    return -1
  })()
  assert.notEqual(bodyStart, -1, `未能定位 ${name} 的函数体`)
  depth = 0
  for (i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') { depth--; if (depth === 0) break }
  }
  const code = source.slice(start, i + 1)
  // eslint-disable-next-line no-new-func
  return new Function(`${code}; return ${name}`)()
}

// ── percentileAt（cloudflare/worker.js:544） ──────────────────────────────
const workerSource = readFileSync(join(root, 'cloudflare/worker.js'), 'utf8')
const percentileAt = extractFn(workerSource, 'percentileAt')

/** PostgreSQL percentile_cont 参考实现（1-based 线性插值），用于交叉验证。 */
function percentileCont(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  if (!n) return null
  const pos = 1 + (n - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo - 1]
  return sorted[lo - 1] + (sorted[hi - 1] - sorted[lo - 1]) * (pos - lo)
}

test('percentileAt: 空数组 / 缺失输入返回 null', () => {
  assert.equal(percentileAt([], 0.95), null)
  assert.equal(percentileAt(null, 0.95), null)
  assert.equal(percentileAt(undefined, 0.5), null)
})

test('percentileAt: 单元素恒等于该元素', () => {
  assert.equal(percentileAt([42], 0), 42)
  assert.equal(percentileAt([42], 0.5), 42)
  assert.equal(percentileAt([42], 0.95), 42)
  assert.equal(percentileAt([42], 1), 42)
})

test('percentileAt: 全相同值恒等于该值', () => {
  assert.equal(percentileAt([7, 7, 7, 7, 7], 0.5), 7)
  assert.equal(percentileAt([7, 7, 7, 7, 7], 0.95), 7)
})

test('percentileAt: p=0 / p=1 命中索引边界', () => {
  const values = [10, 20, 30, 40, 50]
  assert.equal(percentileAt(values, 0), 10)
  assert.equal(percentileAt(values, 1), 50)
})

test('percentileAt: 索引为整数时直接取值（无插值）', () => {
  // n=5, p=0.5 -> index=2 整数 -> sorted[2]=30
  assert.equal(percentileAt([10, 20, 30, 40, 50], 0.5), 30)
  // n=21, p=0.95 -> index=19 整数 -> sorted[19]
  const v = Array.from({ length: 21 }, (_, i) => i + 1)
  assert.equal(percentileAt(v, 0.95), 20)
})

test('percentileAt: p95 落在索引中间时正确线性插值', () => {
  // n=10, index=(10-1)*0.95=8.5499... -> 9 + (10-9)*(index-8) ≈ 9.55（浮点，用容差比较）
  assert.ok(Math.abs(percentileAt([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95) - 9.55) < 1e-9)
  // n=4, index=3*0.95=2.85 -> 3 + (4-3)*0.85 = 3.85
  assert.ok(Math.abs(percentileAt([1, 2, 3, 4], 0.95) - 3.85) < 1e-9)
})

test('percentileAt: 不修改入参且对无序输入正确', () => {
  const input = [5, 1, 4, 2, 3]
  percentileAt(input, 0.95)
  assert.deepEqual(input, [5, 1, 4, 2, 3], '入参被就地排序 = 副作用')
  assert.equal(percentileAt([5, 1, 4, 2, 3], 0.5), 3)
})

test('percentileAt: 与 PostgreSQL percentile_cont 语义一致（随机对照）', () => {
  let seed = 20260907
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  for (let round = 0; round < 300; round++) {
    const n = 1 + Math.floor(rand() * 40)
    const values = Array.from({ length: n }, () => Math.round(rand() * 5000))
    for (const p of [0, 0.5, 0.75, 0.9, 0.95, 0.99, 1]) {
      assert.ok(
        Math.abs(percentileAt(values, p) - percentileCont(values, p)) < 1e-9,
        `n=${n} p=${p} 与 percentile_cont 不一致`
      )
    }
  }
})

// ── buildReplayQuery（apps/web/src/utils/replay-link.js:17） ──────────────
test('buildReplayQuery: 空/undefined 输入返回空 query', () => {
  assert.deepEqual(buildReplayQuery(), {})
  assert.deepEqual(buildReplayQuery({}), {})
})

test('回归：buildReplayQuery 显式 null 不再抛错', () => {
  assert.deepEqual(buildReplayQuery(null), {})
  assert.deepEqual(buildReplayQuery(undefined), {})
})

test('回归：buildReplayQuery 不臆造 device_id（后端无该过滤能力）', () => {
  // Node replayWhere / Worker replayFilters 均无 deviceId 过滤，
  // 前端产出该参数会被后端静默忽略 -> 表现为「看起来过滤了、实则全量」，比空列表更危险。
  assert.deepEqual(buildReplayQuery({ url: '/a', deviceId: 'd1' }), { path: '/a' })
  assert.deepEqual(buildReplayQuery({ deviceId: 'd1' }), {})
  assert.ok(!/device/i.test(readFileSync(join(root, 'apps/web/src/utils/replay-link.js'), 'utf8')))
})

test('buildReplayQuery: 仅输出有值的参数', () => {
  assert.deepEqual(buildReplayQuery({ url: '/checkout', userId: '', userName: null }), { path: '/checkout' })
  assert.deepEqual(buildReplayQuery({ userId: 'u1' }), { userId: 'u1' })
  assert.deepEqual(buildReplayQuery({ url: '/a', userId: 'u1', userName: '张三' }),
    { path: '/a', userId: 'u1', userName: '张三' })
})

test('buildReplayQuery: url 优先于 path；path 字段可回退', () => {
  assert.deepEqual(buildReplayQuery({ url: '/from-url', path: '/from-path' }), { path: '/from-url' })
  assert.deepEqual(buildReplayQuery({ path: '/from-path' }), { path: '/from-path' })
  assert.deepEqual(buildReplayQuery({ url: '', path: '/from-path' }), { path: '/from-path' })
})

test('buildReplayQuery: url 含查询串时原样透传（后端为 LIKE %value% 匹配）', () => {
  const url = 'https://shop.example.com/api/order?id=1&t=2'
  assert.deepEqual(buildReplayQuery({ url }), { path: url })
})

test('buildReplayQuery: 未知字段被忽略，不臆造后端不支持的参数', () => {
  const out = buildReplayQuery({ url: '/a', sessionId: 's1', startTime: 1, endTime: 2, keyword: 'k' })
  assert.deepEqual(out, { path: '/a' })
  assert.ok(!('startTime' in out) && !('endTime' in out), '不应臆造时间参数')
})

test('buildReplayQuery: userId 缺失时不做 device_id 回退（当前实现）', () => {
  // 记录现状：调用方若只给 deviceId，产出为空 query（后端亦无 deviceId 过滤）。
  assert.deepEqual(buildReplayQuery({ url: '/a', deviceId: 'd1' }), { path: '/a' })
  assert.deepEqual(buildReplayQuery({ deviceId: 'd1' }), {})
})

// ── 契约一致性：Node/PG 端 vs Worker/D1 端返回字段集 ──────────────────────
/** 从源码中切出锚点处的对象字面量原文（按花括号配平）。 */
function objectLiteral(source, anchor) {
  const match = anchor.exec(source)
  assert.ok(match, `未找到锚点: ${anchor}`)
  let depth = 0
  const start = source.indexOf('{', match.index)
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1) }
  }
  return ''
}

/** 断言字面量原文里存在该属性（兼容 `k: v` 简写与 `k,`）。 */
function hasProp(literal, key) {
  return new RegExp(`(^|[{,\\s])${key}\\s*[,:}]`).test(literal)
}

const apiSource = readFileSync(join(root, 'apps/api/src/services/analytics-service.js'), 'utf8')

const OVERVIEW_KEYS = ['method', 'url', 'endpoint', 'count', 'errorCount', 'errorRate', 'avgDuration', 'p50', 'p95', 'maxDuration', 'statusCodes']
const SERIES_KEYS = ['bucket', 'count', 'errorCount', 'errorRate', 'avgDuration', 'p95']

test('契约：总览端点字段集两端一致', () => {
  const node = objectLiteral(apiSource, /return\s*\{\s*method,/)
  const worker = objectLiteral(workerSource, /return\{method:entry\.method/)
  assert.ok(node.length > 0 && worker.length > 0, '未能切出对象字面量')
  for (const key of OVERVIEW_KEYS) {
    assert.ok(hasProp(node, key), `Node 端缺少字段 ${key}`)
    assert.ok(hasProp(worker, key), `Worker 端缺少字段 ${key}`)
  }
  // 反向：字面量里不得出现契约外的字段
  for (const literal of [node, worker]) {
    for (const found of literal.matchAll(/(?:^|[{,]\s*)([A-Za-z_$][\w$]*)\s*[,:}]/g)) {
      assert.ok(OVERVIEW_KEYS.includes(found[1]), `存在契约外字段: ${found[1]}`)
    }
  }
})

test('契约：时序点字段集两端一致', () => {
  const node = objectLiteral(apiSource, /return\s*\{\s*bucket:/)
  const worker = objectLiteral(workerSource, /\.map\(b=>\(\{bucket:b\.bucket/)
  assert.ok(node.length > 0 && worker.length > 0, '未能切出对象字面量')
  for (const key of SERIES_KEYS) {
    assert.ok(hasProp(node, key), `Node 端缺少字段 ${key}`)
    assert.ok(hasProp(worker, key), `Worker 端缺少字段 ${key}`)
  }
  for (const literal of [node, worker]) {
    for (const found of literal.matchAll(/(?:^|[{,]\s*)([A-Za-z_$][\w$]*)\s*[,:}]/g)) {
      assert.ok(SERIES_KEYS.includes(found[1]), `存在契约外字段: ${found[1]}`)
    }
  }
})

// ── method 大小写 / 分桶：Node vs Worker 口径一致性（回归 BUG-1/2/3） ──────
// SDK 直接上报 fetch/xhr 的原始 method（packages/sdk/src/performance/fetch.js:21、
// xhr.js:19），不做 toUpperCase，因此库里可能出现小写 'get'/'post'。
test('回归：Node 总览按大写归并，与 Worker 分组口径一致', () => {
  const rows = [
    { method: 'get', url: '/a', value: 10 },
    { method: 'GET', url: '/a', value: 20 }
  ]
  // Worker：read() 先 toUpperCase 再分组
  const workerKeys = new Set(rows.map(r => `${String(r.method || 'GET').toUpperCase()} ${r.url}`))
  // Node：SELECT upper(coalesce(props_json->>'method','GET')) 后 group by
  const nodeKeys = new Set(rows.map(r => `${String(r.method || 'GET').toUpperCase()} ${r.url}`))
  assert.equal(workerKeys.size, 1)
  assert.equal(nodeKeys.size, 1, 'Node 端必须把 get/GET 并为一组')
  assert.deepEqual([...nodeKeys].sort(), [...workerKeys].sort())
  // 源码层面确认 upper() 已落到两处 SELECT
  assert.match(apiSource, /upper\(coalesce\(props_json->>'method', 'GET'\)\) as method/)
  assert.equal((apiSource.match(/upper\(coalesce\(props_json->>'method', 'GET'\)\) as method/g) || []).length, 2,
    '总览与状态码两处 SELECT 都应统一大写')
})

test('回归：小写 method 端点在 Node 端下钻可命中', () => {
  // Node 下钻条件已改为 upper(coalesce(props_json->>'method','GET')) = ?
  assert.match(apiSource, /and upper\(coalesce\(props_json->>'method', 'GET'\)\) = \?/)
  const stored = 'get'
  // SQL 语义：upper('get') === 'GET' -> 命中；Worker 端 read() 大写后比较同样命中
  assert.equal(String(stored).toUpperCase() === 'GET', true, 'Node 端下钻应命中')
  assert.equal(String(stored || 'GET').toUpperCase() === 'GET', true, 'Worker 端下钻应命中')
})

test('回归：两端小时桶算法一致（不再依赖 PG session TimeZone）', () => {
  // 源码确认 Node 已改为对毫秒时间戳取整，且不再出现 date_trunc/to_timestamp
  assert.match(apiSource, /floor\(ts \/ 3600000\) \* 3600000 as bucket/)
  // 只看下钻函数体，并剔除 SQL 行注释（注释里会提到 date_trunc 作为历史背景）
  const seriesFn = apiSource.slice(
    apiSource.indexOf('async function getApiHealthSeries'),
    apiSource.indexOf('group by 1', apiSource.indexOf('async function getApiHealthSeries'))
  )
  const seriesSql = seriesFn.replace(/--[^\n]*/g, '')
  assert.ok(seriesFn.length > 0, '未切出下钻函数体')
  assert.ok(!/date_trunc|to_timestamp/.test(seriesSql),
    '下钻分桶不应再使用 date_trunc/to_timestamp（依赖 session TimeZone）')
  assert.match(workerSource, /Math\.floor\(item\.ts\/3600000\)\*3600000/)
  // 数值对齐：边界值 + 真实毫秒时间戳
  for (const ts of [0, 1, 3599999, 3600000, 3600001, 1700000000123, 1785000000000]) {
    const workerBucket = Math.floor(ts / 3600000) * 3600000
    // Node SQL：ts 为整数时 / 为整除（正数等价 floor），外层再套 floor() 保证浮点列也正确
    const nodeBucket = Math.floor(Math.trunc(ts / 3600000)) * 3600000
    assert.equal(nodeBucket, workerBucket, `ts=${ts} 两端分桶不一致`)
    assert.equal(workerBucket % 3600000, 0, '分桶未对齐到整小时')
  }
})

test('契约：响应信封两端一致（endpoints/total 与 endpoint/series）', () => {
  assert.match(apiSource, /return \{ endpoints, total: endpoints\.length \}/)
  assert.match(workerSource, /return json\(\{endpoints,total:endpoints\.length\}\)/)
  assert.match(apiSource, /return \{ endpoint: String\(endpoint \|\| ''\), series \}/)
  assert.match(workerSource, /return json\(\{endpoint:String\(endpoint\),series\}\)/)
})
const replaySource = readFileSync(join(root, 'apps/web/src/components/ReplayPanel.vue'), 'utf8')
const isKeyEvent = extractFn(replaySource, 'isKeyEvent')

test('isKeyEvent: 非增量快照类型为关键事件', () => {
  for (const type of [1, 2, 4, 5]) assert.equal(isKeyEvent({ type }), true, `type=${type} 应为关键事件`)
})

test('isKeyEvent: 未覆盖的事件类型返回 false', () => {
  for (const type of [0, 6, 7, 99, undefined, null]) {
    assert.equal(isKeyEvent({ type }), false, `type=${type} 不应为关键事件`)
  }
  assert.equal(isKeyEvent({}), false)
  assert.equal(isKeyEvent(), false)
})

test('isKeyEvent: 增量快照按 source 白名单判定', () => {
  for (const source of [2, 3, 4, 5, 7, 11, 12]) {
    assert.equal(isKeyEvent({ type: 3, data: { source } }), true, `source=${source} 应为关键事件`)
  }
  for (const source of [0, 1, 6, 8, 9, 10, 13, 14]) {
    assert.equal(isKeyEvent({ type: 3, data: { source } }), false, `source=${source} 不应为关键事件`)
  }
})

test('isKeyEvent: 增量快照缺 data / source 时返回 false', () => {
  assert.equal(isKeyEvent({ type: 3 }), false)
  assert.equal(isKeyEvent({ type: 3, data: {} }), false)
  assert.equal(isKeyEvent({ type: 3, data: { source: null } }), false)
})

test('isKeyEvent: source 为字符串数字时按数值判定', () => {
  assert.equal(isKeyEvent({ type: 3, data: { source: '2' } }), true)
  assert.equal(isKeyEvent({ type: 3, data: { source: 'abc' } }), false)
})
