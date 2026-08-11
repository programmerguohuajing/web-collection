import assert from 'node:assert/strict'
import test from 'node:test'
import { channelMatches, decryptSecrets, encryptSecrets, normalizeChannel, publishDelivery, sendChannel } from '../packages/alerting.js'
import { buildAlertChannelPayload, createAlertChannelForm } from '../apps/web/src/alert-channels.js'

test('渠道路由按应用、级别和指标匹配', () => {
  const channel = normalizeChannel({
    name: '飞书错误群',
    type: 'feishu',
    appIds: ['web'],
    levels: ['error'],
    metrics: ['error']
  })
  assert.equal(channelMatches(channel, { appId: 'web', level: 'error', metric: 'error' }), true)
  assert.equal(channelMatches(channel, { appId: 'admin', level: 'error', metric: 'error' }), false)
  assert.equal(channelMatches({ ...channel, appIds: [] }, { appId: 'admin', level: 'error', metric: 'error' }), true)
  assert.throws(
    () => normalizeChannel({ name: '不安全渠道', type: 'webhook', config: { headers: { Authorization: 'Bearer plaintext' } } }),
    /必须使用/
  )
})

test('告警渠道页面按后端契约提交配置、范围和密钥', () => {
  const form = createAlertChannelForm({
    id: 8,
    name: '订单告警',
    type: 'webhook',
    enabled: true,
    configured: true,
    config: {
      method: 'POST',
      headers: { 'x-app': '{{appId}}' },
      bodyTemplate: '{"message":"{{message}}"}',
      authType: 'bearer'
    },
    appIds: ['shop-web'],
    levels: ['error'],
    metrics: ['error', 'regression']
  })
  assert.equal(form.endpoint, '')
  assert.equal(form.endpointConfigured, true)
  form.endpoint = 'https://example.com/alerts'
  form.token = 'new-token'
  const payload = buildAlertChannelPayload(form)
  assert.deepEqual(payload.appIds, ['shop-web'])
  assert.deepEqual(payload.levels, ['error'])
  assert.deepEqual(payload.metrics, ['error', 'regression'])
  assert.deepEqual(payload.config.headers, { 'x-app': '{{appId}}' })
  assert.deepEqual(payload.secrets, { url: 'https://example.com/alerts', token: 'new-token' })
})

test('编辑告警渠道留空密钥时不覆盖服务端已加密配置', () => {
  const form = createAlertChannelForm({ id: 9, name: '飞书群', type: 'feishu', configured: true })
  const payload = buildAlertChannelPayload(form)
  assert.deepEqual(payload.secrets, {})
})

test('后端兼容旧告警渠道扁平字段并转换为标准契约', () => {
  const value = normalizeChannel({
    name: '旧版 Webhook',
    type: 'webhook',
    endpoint: 'https://example.com/legacy',
    appId: 'web',
    levels: 'error,critical',
    metrics: 'error,regression',
    webhookSecret: 'legacy-token',
    webhookHeaders: { Authorization: 'Bearer {{secret.token}}' }
  })
  assert.deepEqual(value.appIds, ['web'])
  assert.deepEqual(value.levels, ['error', 'critical'])
  assert.deepEqual(value.metrics, ['error', 'regression'])
  assert.deepEqual(value.secrets, { url: 'https://example.com/legacy', token: 'legacy-token' })
  assert.deepEqual(value.config.headers, { Authorization: 'Bearer {{secret.token}}' })
})

test('渠道密钥 AES-GCM 加密后可解密且不包含明文', async () => {
  const ciphertext = await encryptSecrets({ url: 'https://example.com/hook', token: 'secret-token' }, 'master-key')
  assert.equal(ciphertext.includes('secret-token'), false)
  assert.deepEqual(await decryptSecrets(ciphertext, 'master-key'), { url: 'https://example.com/hook', token: 'secret-token' })
  await assert.rejects(() => decryptSecrets(ciphertext, 'wrong-key'))
})

test('通用 HTTP 渠道安全渲染变量并应用 Bearer 认证', async () => {
  let request
  const result = await sendChannel(
    {
      type: 'webhook',
      config: {
        method: 'POST',
        authType: 'bearer',
        headers: { 'x-app': '{{appId}}' },
        bodyTemplate: '{"message":"{{message}}","token":"{{secret.extra}}"}'
      }
    },
    { url: 'https://example.com/hook', token: 'bearer-token', extra: 'hidden' },
    { id: 1, appId: 'web', level: 'error', metric: 'error', message: '包含"引号"', createdAt: Date.now() },
    async (url, options) => {
      request = { url, options }
      return new Response('{"id":"provider-1"}', { status: 200 })
    }
  )
  assert.equal(request.url, 'https://example.com/hook')
  assert.equal(request.options.headers.authorization, 'Bearer bearer-token')
  assert.deepEqual(JSON.parse(request.options.body), { message: '包含"引号"', token: 'hidden' })
  assert.equal(result.providerMessageId, 'provider-1')
})

test('供应商错误不会写出渠道密钥', async () => {
  await assert.rejects(
    () => sendChannel(
      { type: 'webhook', config: {} },
      { url: 'https://example.com/hook', token: 'secret-token' },
      { message: 'test' },
      async () => new Response('invalid secret-token', { status: 401 })
    ),
    error => error.message.includes('[REDACTED]') && !error.message.includes('secret-token')
  )
})

test('QStash 发布配置重试与幂等键', async () => {
  let request
  const messageId = await publishDelivery({
    token: 'qstash-token',
    baseUrl: 'https://monitor.example.com',
    deliveryId: 42,
    fetcher: async (url, options) => {
      request = { url, options }
      return new Response('{"messageId":"msg-42"}', { status: 200 })
    }
  })
  assert.equal(messageId, 'msg-42')
  assert.equal(request.options.headers['upstash-retries'], '5')
  assert.equal(JSON.parse(request.options.body).deliveryId, 42)
})
