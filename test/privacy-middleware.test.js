import assert from 'node:assert/strict'
import test from 'node:test'
import { createMaskingMiddleware, MASK_SKIP_PREFIXES, queryMaskingEnabled } from '../apps/api/src/privacy.js'

function mockRes() {
  const res = { _body: undefined, json(body) { this._body = body; return this } }
  return res
}

// 在每个测试体内设置 EYS_QUERY_MASKING=on 并还原，避免跨测试 env 串扰
function runWithMasking(body) {
  const prev = process.env.EYS_QUERY_MASKING
  process.env.EYS_QUERY_MASKING = 'on'
  try { body() } finally {
    if (prev !== undefined) process.env.EYS_QUERY_MASKING = prev
    else delete process.env.EYS_QUERY_MASKING
  }
}

test('queryMaskingEnabled is false by default (access = view raw)', () => {
  const prev = process.env.EYS_QUERY_MASKING
  delete process.env.EYS_QUERY_MASKING
  try { assert.equal(queryMaskingEnabled(), false) } finally {
    if (prev !== undefined) process.env.EYS_QUERY_MASKING = prev
  }
})

test('masking middleware is pass-through by default (no permission control)', () => {
  const prev = process.env.EYS_QUERY_MASKING
  delete process.env.EYS_QUERY_MASKING
  try {
    const mw = createMaskingMiddleware()
    const req = { path: '/api/events', get: () => '' }
    const res = mockRes()
    mw(req, res, () => {})
    res.json({ items: [{ message: 'contact a@b.com' }] })
    assert.equal(res._body.items[0].message, 'contact a@b.com') // 默认不掩码：访问即原文
  } finally {
    if (prev !== undefined) process.env.EYS_QUERY_MASKING = prev
  }
})

test('masking middleware masks PII on a query route (when enabled)', () => {
  runWithMasking(() => {
    const mw = createMaskingMiddleware()
    const req = { path: '/api/events', get: () => '' }
    const res = mockRes()
    mw(req, res, () => {})
    res.json({ items: [{ message: 'contact a@b.com' }] })
    assert.equal(res._body.items[0].message, 'contact [REDACTED]')
  })
})

test('masking middleware does not wrap res.json for a skip prefix', () => {
  runWithMasking(() => {
    const mw = createMaskingMiddleware()
    const req = { path: '/api/applications', get: () => '' }
    const res = mockRes()
    mw(req, res, () => {})
    res.json({ owner: 'ops@corp.com' })
    assert.equal(res._body.owner, 'ops@corp.com') // config route: not masked
  })
})

test('masking middleware skips when authorized raw viewer', () => {
  const prevMask = process.env.EYS_QUERY_MASKING
  const prevTok = process.env.EYS_RAW_ACCESS_TOKEN
  process.env.EYS_QUERY_MASKING = 'on'
  process.env.EYS_RAW_ACCESS_TOKEN = 'raw-tok'
  try {
    const mw = createMaskingMiddleware()
    const req = { path: '/api/events', get: () => 'raw-tok' }
    const res = mockRes()
    mw(req, res, () => {})
    res.json({ message: 'secret@corp.com' })
    assert.equal(res._body.message, 'secret@corp.com') // raw visible to authorized
  } finally {
    if (prevMask !== undefined) process.env.EYS_QUERY_MASKING = prevMask
    else delete process.env.EYS_QUERY_MASKING
    if (prevTok !== undefined) process.env.EYS_RAW_ACCESS_TOKEN = prevTok
    else delete process.env.EYS_RAW_ACCESS_TOKEN
  }
})

test('masking middleware does not wrap for non-api paths', () => {
  runWithMasking(() => {
    const mw = createMaskingMiddleware()
    const req = { path: '/web/index.html', get: () => '' }
    const res = mockRes()
    mw(req, res, () => {})
    res.json({ message: 'a@b.com' })
    assert.equal(res._body.message, 'a@b.com')
  })
})

test('MASK_SKIP_PREFIXES covers ingest, config and static routes', () => {
  for (const p of [
    '/api/collect', '/api/collect.gif', '/api/spans', '/api/sourcemaps',
    '/api/internal/alerts/deliver', '/api/settings', '/api/applications',
    '/api/alert-channels', '/api/alert-deliveries', '/api/maintenance/cleanup', '/api/sdk/foo.js'
  ]) {
    assert.ok(MASK_SKIP_PREFIXES.some(prefix => p.startsWith(prefix)), `expected skip: ${p}`)
  }
})
