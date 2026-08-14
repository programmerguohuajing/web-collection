import assert from 'node:assert/strict'
import test from 'node:test'
import { CREDENTIAL_KEYS, isAuthorizedRaw, maskValue, redactPiiText } from '../apps/api/src/privacy.js'

test('redactPiiText masks email, phone, idcard, bankcard and jwt', () => {
  assert.equal(redactPiiText('contact me at alice@example.com'), 'contact me at [REDACTED]')
  assert.equal(redactPiiText('tel 13812345678 ok'), 'tel [REDACTED] ok')
  assert.equal(redactPiiText('id 11010519491231002X'), 'id [REDACTED]')
  assert.equal(redactPiiText('card 6222021234567890123'), 'card [REDACTED]')
  assert.equal(redactPiiText('auth eyJhbGciOiJIUzI1Ni.eyJzdWIiOiIxMj.abcdefghijklmnop'), 'auth [REDACTED]')
})

test('redactPiiText is idempotent on already masked text', () => {
  const once = redactPiiText('call 13812345678')
  assert.equal(redactPiiText(once), once)
})

test('redactPiiText leaves ordinary text untouched', () => {
  assert.equal(redactPiiText('lcp=1234ms, cls=0.01'), 'lcp=1234ms, cls=0.01')
})

test('maskValue recurses and redacts credential keys', () => {
  const input = {
    user: { email: 'bob@example.com', token: 's3cr3t-token-value', notes: 'normal text 13900001111' },
    items: [{ password: 'hunter2', label: 'ok' }]
  }
  const out = maskValue(input)
  assert.equal(out.user.email, '[REDACTED]')
  assert.equal(out.user.token, '[REDACTED]')
  assert.equal(out.user.notes, 'normal text [REDACTED]') // phone inside text
  assert.equal(out.user.password, undefined) // nested under items
  assert.equal(out.items[0].password, '[REDACTED]')
  assert.equal(out.items[0].label, 'ok')
})

test('maskValue respects depth and item limits', () => {
  const deep = { a: { b: { c: { d: { e: 'x@y.com' } } } } }
  assert.equal(maskValue(deep).a.b.c.d.e, 'x@y.com') // beyond MAX_DEPTH, untouched
})

test('isAuthorizedRaw requires token when env unset', () => {
  const prev = process.env.EYS_RAW_ACCESS_TOKEN
  delete process.env.EYS_RAW_ACCESS_TOKEN
  const req = { get: () => 'anything' }
  assert.equal(isAuthorizedRaw(req), false)
  if (prev !== undefined) process.env.EYS_RAW_ACCESS_TOKEN = prev
})

test('isAuthorizedRaw matches header against env token (constant time)', () => {
  const prev = process.env.EYS_RAW_ACCESS_TOKEN
  process.env.EYS_RAW_ACCESS_TOKEN = 'super-secret-raw-token'
  try {
    assert.equal(isAuthorizedRaw({ get: () => 'super-secret-raw-token' }), true)
    assert.equal(isAuthorizedRaw({ get: () => 'wrong' }), false)
    assert.equal(isAuthorizedRaw({ get: () => '' }), false)
  } finally {
    if (prev !== undefined) process.env.EYS_RAW_ACCESS_TOKEN = prev
    else delete process.env.EYS_RAW_ACCESS_TOKEN
  }
})

test('CREDENTIAL_KEYS matching is case-insensitive at lookup', () => {
  const out = maskValue({ TOKEN: 'x', Api_Key: 'y', normal: 'z' })
  assert.equal(out.TOKEN, '[REDACTED]')
  assert.equal(out.Api_Key, '[REDACTED]')
  assert.equal(out.normal, 'z')
})
