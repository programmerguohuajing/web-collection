import assert from 'node:assert'
import test from 'node:test'
import {
  serializeBaggage,
  parseBaggage,
  injectBaggage,
  extractBaggage,
  injectHeaders,
  normalizeTraceState,
  matchesTraceOrigin,
  canTrace,
  TRACE_PARENT,
  BAGGAGE
} from '../src/trace/propagation.js'
import { TraceContext } from '../src/trace/context.js'

/** 一个「标准 W3C Baggage 解析器」——模拟 OpenTelemetry 的实现，用于互操作对拍 */
function otelParseBaggage(headerValue) {
  const out = new Map()
  if (!headerValue) return out
  for (const member of headerValue.split(',')) {
    const [pair] = member.split(';') // 忽略 member 属性
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    const key = pair.slice(0, idx).trim()
    if (!key) continue
    let value = pair.slice(idx + 1).trim()
    try { value = decodeURIComponent(value) } catch {}
    out.set(key, value)
  }
  return out
}

test('serializeBaggage 生成标准逗号分隔值，值被 URL 编码', () => {
  const map = new Map([
    ['userId', 'u-123'],
    ['tenant', 'acme corp'], // 含空格，需编码
    ['plan', 'pro']
  ])
  const header = serializeBaggage(map)
  assert.ok(header.includes('userId=u-123'))
  assert.ok(header.includes('plan=pro'))
  // 空格被编码为 %20
  assert.ok(header.includes('tenant=acme%20corp'))
  // 标准格式：逗号分隔，无 baggage- 前缀
  assert.ok(!header.includes('baggage-'))
})

test('serializeBaggage 对非法 key 字符做下划线替换', () => {
  const header = serializeBaggage(new Map([['a b=c', 'v']]))
  assert.ok(header.startsWith('a_b_c=')) // 空格与等号被替换
})

test('parseBaggage 往返一致（serialize -> parse）', () => {
  const original = new Map([['userId', 'u-123'], ['tenant', 'acme corp'], ['plan', 'pro']])
  const parsed = parseBaggage(serializeBaggage(original))
  assert.deepEqual([...parsed.entries()], [...original.entries()])
})

test('与 OpenTelemetry 风格解析器互操作：OTel 能读懂我们的输出', () => {
  const ctx = new TraceContext({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) })
  ctx.baggage.set('userId', 'u-123')
  ctx.baggage.set('tenant', 'acme corp')
  const headers = injectBaggage(ctx, new Headers())
  const headerValue = headers.get(BAGGAGE)
  // OTel 解析器（独立实现）应得到完全一致的结果
  assert.deepEqual(
    [...otelParseBaggage(headerValue).entries()],
    [['userId', 'u-123'], ['tenant', 'acme corp']]
  )
})

test('我们也能读懂 OTel 风格的标准 baggage 字符串', () => {
  const otelStyle = 'userId=u-123,tenant=acme%20corp,plan=pro;foo=bar'
  const parsed = parseBaggage(otelStyle)
  assert.equal(parsed.get('userId'), 'u-123')
  assert.equal(parsed.get('tenant'), 'acme corp')
  assert.equal(parsed.get('plan'), 'pro')
  assert.equal(parsed.size, 3) // member 属性 foo=bar 被忽略，仅取计划键
})

test('extractBaggage 向后兼容旧版多个 baggage-* Header', () => {
  const headers = {
    'baggage-userId': encodeURIComponent('u-123'),
    'baggage-tenant': encodeURIComponent('acme')
  }
  const parsed = extractBaggage(headers)
  assert.equal(parsed.get('userId'), 'u-123')
  assert.equal(parsed.get('tenant'), 'acme')
})

test('extractBaggage 优先读取标准 baggage，并与旧 baggage-* 合并', () => {
  const headers = new Headers()
  headers.set('baggage', 'userId=u-123')
  headers.set('baggage-legacy', 'oldval')
  const parsed = extractBaggage(headers)
  assert.equal(parsed.get('userId'), 'u-123')
  assert.equal(parsed.get('legacy'), 'oldval')
})

test('injectHeaders 注入 traceparent + 标准 baggage（无 baggage 时不写空头）', () => {
  const ctx = new TraceContext({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) })
  const headers = injectHeaders(ctx, { headers: new Headers() })
  assert.ok(headers.get(TRACE_PARENT))
  assert.equal(headers.get(BAGGAGE), null) // 无 baggage，不写

  ctx.baggage.set('k', 'v')
  const headers2 = injectHeaders(ctx, { headers: new Headers() })
  assert.equal(headers2.get(BAGGAGE), 'k=v')
})

test('normalizeTraceState 去除空白成员并截断超长', () => {
  assert.equal(normalizeTraceState('a=1,  b=2 ,, c=3'), 'a=1,b=2,c=3')
  const long = Array.from({ length: 100 }, (_, i) => `k${i}=v${i}`).join(',')
  const normalized = normalizeTraceState(long)
  assert.ok(normalized.length <= 512)
  // 截断点应是完整 member 边界
  assert.ok(!normalized.endsWith(','))
})

test('matchesTraceOrigin 支持 string / RegExp / function / 非法规则', () => {
  assert.equal(matchesTraceOrigin('https://api.example.com', 'https://api.example.com'), true)
  assert.equal(matchesTraceOrigin('https://api.example.com', 'https://other.com'), false)
  assert.equal(matchesTraceOrigin('https://x.example.com', /^https:\/\/.*\.example\.com$/), true)
  assert.equal(matchesTraceOrigin('https://evil.com', /^https:\/\/.*\.example\.com$/), false)
  assert.equal(matchesTraceOrigin('https://a.internal', (o) => o.endsWith('.internal')), true)
  assert.equal(matchesTraceOrigin('https://a.com', (o) => o.endsWith('.internal')), false)
  assert.equal(matchesTraceOrigin('https://a.com', null), false)
  assert.equal(matchesTraceOrigin('https://a.com', undefined), false)
})

test('canTrace 同源恒真', () => {
  const base = 'https://shop.example.com/page'
  assert.equal(canTrace('/api/x', [], base), true) // 相对路径，视为同源
  assert.equal(canTrace('https://shop.example.com/api', [], base), true)
})

test('canTrace 跨域命中 traceOrigins 规则才允许', () => {
  const base = 'https://shop.example.com/page'
  // 精确字符串
  assert.equal(canTrace('https://api.example.com/x', ['https://api.example.com'], base), true)
  assert.equal(canTrace('https://api.example.com/x', ['https://other.com'], base), false)
  // 正则
  assert.equal(canTrace('https://x.example.com/x', [/^https:\/\/.*\.example\.com$/], base), true)
  // 函数
  assert.equal(canTrace('https://a.internal', [(o) => o.endsWith('.internal')], base), true)
})

test('canTrace 非法 URL 一律拒绝（防止配置错误泄露 baggage）', () => {
  const base = 'https://shop.example.com/page'
  // 无 host 的绝对 URL 无法解析
  assert.equal(canTrace('https://', ['https://api.example.com'], base), false)
  // 含非法字符的 host 无法解析
  assert.equal(canTrace('http://exa mple.com', [], base), false)
})
