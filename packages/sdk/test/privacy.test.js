import assert from 'node:assert/strict'
import test from 'node:test'
import { createSanitizer, resolveConsent, hashIdentifier } from '../src/core/sanitizer.js'
import { sanitizeEvent } from '../src/core/event.js'
import { setupAdvancedBehaviorMonitor } from '../src/behavior/advanced.js'
import { setupClickMonitor } from '../src/behavior/click.js'

/** 安装一个可捕获监听器的 addEventListener 桩，便于在无 DOM 环境下驱动行为模块 */
function installListenerSpy() {
  const handlers = {}
  globalThis.addEventListener = (type, fn) => { (handlers[type] ||= []).push(fn) }
  globalThis.removeEventListener = () => {}
  return handlers
}

test('createSanitizer 默认档位为 balanced', () => {
  const s = createSanitizer()
  assert.equal(s.mode, 'balanced')
  // 未知档位回退到 balanced
  assert.equal(createSanitizer({ mode: 'weird' }).mode, 'balanced')
  assert.equal(createSanitizer({ mode: 'off' }).mode, 'off')
  assert.equal(createSanitizer({ mode: 'strict' }).mode, 'strict')
})

test('balanced 下 sanitizeEvent 脱敏字段键 + 值级 PII', () => {
  const s = createSanitizer({ mode: 'balanced' })
  const out = s.sanitizeEvent({
    type: 'track',
    name: 'checkout',
    props: {
      token: 'abc.def',
      contact: 'alice@example.com',
      mobile: '13800138000',
      idcard: '11010519491231002X',
      note: '正常文本',
      nested: { password: 'hunter2' }
    },
    context: { module: 'order' }
  })
  assert.equal(out.props.token, '[REDACTED]')
  assert.equal(out.props.nested.password, '[REDACTED]')
  // 值级 PII 被脱敏
  assert.ok(!out.props.contact.includes('alice@example.com'), '邮箱应被脱敏')
  assert.ok(!out.props.mobile.includes('13800138000'), '手机号应被脱敏')
  assert.ok(!out.props.idcard.includes('11010519491231002X'), '身份证应被脱敏')
  // 正常文本与无关字段保留
  assert.equal(out.props.note, '正常文本')
  assert.equal(out.context.module, 'order')
})

test('userPhone 在 balanced/strict 下不可逆 hash，off 下原样', () => {
  const balanced = createSanitizer({ mode: 'balanced' })
  const off = createSanitizer({ mode: 'off' })
  const phone = '13800138000'
  const hashed = balanced.userPhone(phone)
  assert.notEqual(hashed, phone)
  assert.ok(hashed.startsWith('h_'))
  // 不可逆：hash 中不包含明文手机号
  assert.ok(!hashed.includes('13800138000'))
  // 同一输入稳定
  assert.equal(hashed, balanced.userPhone(phone))
  // off 模式保留明文（业务显式关闭保护）
  assert.equal(off.userPhone(phone), phone)
})

test('hashIdentifier 稳定且不可逆', () => {
  const a = hashIdentifier('13800138000')
  const b = hashIdentifier('13800138000')
  assert.equal(a, b)
  assert.ok(!a.includes('13800138000'))
  // 不同输入大概率不同（长度不同也应不同）
  assert.notEqual(hashIdentifier('13800138000'), hashIdentifier('13800138001'))
})

test('sanitizeUrl 在 balanced 剥离敏感 query，strict 丢弃整个 query', () => {
  const balanced = createSanitizer({ mode: 'balanced' })
  const strict = createSanitizer({ mode: 'strict' })
  const url = 'https://shop.example.com/pay?order=1&token=abc&code=xyz#ok'
  const b = balanced.sanitizeEvent({ url }).url
  assert.ok(b.includes('order=1'), '普通参数保留')
  assert.ok(!b.includes('token=abc'), '敏感参数剥离')
  assert.ok(!b.includes('code=xyz'), '敏感参数剥离')
  assert.ok(b.includes('#ok'), 'hash 保留')
  const s = strict.sanitizeEvent({ url }).url
  assert.ok(!s.includes('order=1'), 'strict 丢弃整个 query')
  assert.ok(s.includes('#ok'))
})

test('sanitizeHeaders 默认丢弃 Authorization / Cookie / Set-Cookie / Proxy-Authorization', () => {
  const s = createSanitizer()
  const out = s.sanitizeHeaders({
    authorization: 'Bearer secret',
    cookie: 'sid=abc',
    'set-cookie': 'x=1',
    'proxy-authorization': 'Basic xxx',
    'content-type': 'application/json'
  })
  assert.equal(out.authorization, undefined)
  assert.equal(out.cookie, undefined)
  assert.equal(out['set-cookie'], undefined)
  assert.equal(out['proxy-authorization'], undefined)
  assert.equal(out['content-type'], 'application/json')
})

test('sanitizePair 默认脱敏请求/响应体，并支持自定义钩子', () => {
  const s = createSanitizer()
  const out = s.sanitizePair({
    url: 'https://api.example.com/login?token=abc',
    requestBody: JSON.stringify({ username: 'bob', password: 's3cret' }),
    responseBody: '欢迎 user@example.com 登录'
  })
  assert.ok(!out.requestBody.includes('s3cret'), 'body 中的 password 字段被脱敏')
  assert.ok(!out.responseBody.includes('user@example.com'), '文本 body 中的邮箱被脱敏')

  // 自定义钩子优先
  const custom = createSanitizer({
    mode: 'off',
    requestResponseSanitizer: pair => ({ ...pair, requestBody: 'REDACTED_BY_HOOK', responseBody: pair.responseBody })
  })
  const co = custom.sanitizePair({ requestBody: '{"a":1}', responseBody: 'x' })
  assert.equal(co.requestBody, 'REDACTED_BY_HOOK')
  assert.equal(co.responseBody, 'x')
})

test('resolveConsent：GPC / DNT 信号降级 analytics / replay / diagnostics', () => {
  const base = resolveConsent({}, { doNotTrack: '1' })
  assert.equal(base.analytics, false)
  assert.equal(base.replay, false)
  assert.equal(base.diagnostics, false)
  assert.equal(base.essential, true)
  assert.equal(base.performance, true)

  const gpc = resolveConsent({}, { globalPrivacyControl: true })
  assert.equal(gpc.analytics, false)
  assert.equal(gpc.replay, false)

  // 用户显式授权时不被信号覆盖
  const explicit = resolveConsent({ consentCategories: { replay: true } }, { doNotTrack: '1' })
  assert.equal(explicit.replay, true)

  // 全局 denied 覆盖一切（仅保留 essential）
  const denied = resolveConsent({ consent: 'denied' }, {})
  assert.deepEqual(denied, { essential: true, performance: false, analytics: false, replay: false, diagnostics: false })
})

test('select_change：balanced 仅采索引/数量/label hash，off 采原文，strict 仅索引/数量', () => {
  const handlers = installListenerSpy()

  const fakeSelect = {
    tagName: 'SELECT', id: 'city', className: '',
    getAttribute: () => null, attributes: [],
    value: 'bj', options: [{ text: '北京' }], selectedIndex: 0
  }

  function runSelect(mode) {
    handlers.change = []
    const pushed = []
    const sanitizer = createSanitizer({ mode })
    setupAdvancedBehaviorMonitor({ push: e => pushed.push(e), sanitizer, selectTracking: true })
    const onChange = handlers.change[0]
    onChange({ target: fakeSelect })
    return pushed[0].props
  }

  const balanced = runSelect('balanced')
  assert.equal(balanced.selectedIndex, 0)
  assert.equal(balanced.totalOptions, 1)
  assert.ok(typeof balanced.labelHash === 'string' && balanced.labelHash.startsWith('h_'), 'balanced 含 label hash')
  assert.equal(balanced.selectedValue, undefined, 'balanced 不采 selectedValue')
  assert.equal(balanced.selectedText, undefined, 'balanced 不采 selectedText')

  const off = runSelect('off')
  assert.equal(off.selectedValue, 'bj', 'off 采 selectedValue')
  assert.equal(off.selectedText, '北京', 'off 采 selectedText')

  const strict = runSelect('strict')
  assert.equal(strict.selectedIndex, 0)
  assert.equal(strict.totalOptions, 1)
  assert.equal(strict.labelHash, undefined, 'strict 不采 label hash')
  assert.equal(strict.selectedValue, undefined)
  assert.equal(strict.selectedText, undefined)
})

test('click：balanced 下点击文本中的 PII 被脱敏', () => {
  const handlers = installListenerSpy()
  const pushed = []
  const sanitizer = createSanitizer({ mode: 'balanced' })
  setupClickMonitor({ push: e => pushed.push(e), sanitizer })
  const onClick = handlers.click[0]
  const target = {
    nodeType: 1,
    tagName: 'BUTTON',
    id: '', className: '',
    getAttribute: () => null, attributes: [],
    innerText: '联系客服 13800138000',
    closest: () => target
  }
  onClick({ target, clientX: 10, clientY: 20 })
  const props = pushed[0].props
  assert.ok(!props.elementText.includes('13800138000'), '点击文本中的手机号被脱敏')
  assert.ok(!props.elementLabel.includes('13800138000'), '点击 label 中的手机号被脱敏')
})

test('隐私回归语料：序列化 payload 中不得出现明文敏感数据', () => {
  const s = createSanitizer({ mode: 'balanced' })
  const corpus = [
    // 自定义事件携带手机号 / 邮箱 / token
    s.sanitizeEvent({ type: 'track', name: 'signup', props: { phone: '13800138000', email: 'a@b.com', token: 'tk_123' } }),
    // 选择框变更
    { type: 'behavior', name: 'select_change', props: { selectedIndex: 2, totalOptions: 5, labelHash: s.hashIdentifier('选项C') } },
    // 点击文本
    { type: 'behavior', name: 'click', props: { elementText: s.sanitizeText('拨打 13800138000'), elementLabel: s.sanitizeText('客服 13912345678') } },
    // 请求 body
    s.sanitizePair({ requestBody: JSON.stringify({ password: 'p0ss', card: '6222021234567890123' }), responseBody: 'ok' }),
    // URL query
    s.sanitizeEvent({ type: 'perf', metric: 'xhr', props: {}, url: 'https://x.com/a?token=abc&id=1' })
  ]
  const serialized = JSON.stringify(corpus)
  for (const secret of ['13800138000', '13912345678', 'a@b.com', 'tk_123', 'p0ss', '6222021234567890123', 'token=abc']) {
    assert.ok(!serialized.includes(secret), `语料中不应出现明文敏感数据: ${secret}`)
  }
  // URL query 中的 token 参数被剥离
  assert.ok(!serialized.includes('token=abc'))
})
