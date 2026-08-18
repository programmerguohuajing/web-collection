import assert from 'node:assert/strict'
import test from 'node:test'
import { channelMatches, decryptSecrets, encryptSecrets, normalizeChannel, publishDelivery, renderTemplate, sendChannel } from '../packages/alerting.js'
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

test('飞书智能体渠道提交 App 凭证并校验必填', () => {
  const form = createAlertChannelForm({
    name: '飞书智能体',
    type: 'feishu_app',
    config: { appId: 'cli-id', chatId: 'oc_abc', receiveIdType: 'chat_id' }
  })
  form.appSecret = 'cli-secret'
  const payload = buildAlertChannelPayload(form)
  assert.equal(payload.type, 'feishu_app')
  assert.equal(payload.config.appId, 'cli-id')
  assert.equal(payload.config.chatId, 'oc_abc')
  assert.equal(payload.secrets.appSecret, 'cli-secret')
  assert.equal(payload.secrets.url, undefined)
  assert.throws(() => buildAlertChannelPayload(createAlertChannelForm({ name: 'x', type: 'feishu_app' })), /App Secret/)
})

test('飞书智能体渠道 normalizeChannel 保留 appId/chatId/receiveIdType', () => {
  const channel = normalizeChannel({
    name: '飞书智能体',
    type: 'feishu_app',
    config: { appId: 'cli-id', chatId: 'oc_abc', receiveIdType: 'chat_id' },
    secrets: { appSecret: 'cli-secret' }
  })
  assert.equal(channel.config.appId, 'cli-id')
  assert.equal(channel.config.chatId, 'oc_abc')
  assert.equal(channel.config.receiveIdType, 'chat_id')
  assert.equal(channel.secrets.appSecret, 'cli-secret')
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

test('飞书智能体渠道通过 OpenAPI 获取 token 并发送文本消息', async () => {
  const requests = []
  const result = await sendChannel(
    { type: 'feishu_app', config: { appId: 'cli-app-id', chatId: 'oc_xyz' } },
    { appSecret: 'cli-secret' },
    { id: 1, appId: 'web', level: 'error', metric: 'error', message: '告警内容', createdAt: Date.now() },
    async (url, options) => {
      requests.push({ url, options })
      if (url.includes('/auth/v3/tenant_access_token')) {
        return new Response(JSON.stringify({ code: 0, msg: 'success', tenant_access_token: 't-abc', expire: 7200 }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'success', data: { message_id: 'om_123' } }), { status: 200 })
    }
  )
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/')
  assert.deepEqual(JSON.parse(requests[0].options.body), { app_id: 'cli-app-id', app_secret: 'cli-secret' })
  assert.equal(requests[1].url, 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id')
  assert.equal(requests[1].options.headers.authorization, 'Bearer t-abc')
  assert.equal(JSON.parse(requests[1].options.body).receive_id, 'oc_xyz')
  assert.equal(result.providerMessageId, 'om_123')
})

test('飞书智能体 tenant_access_token 在有效期内缓存复用', async () => {
  let tokenCalls = 0
  const fetcher = async (url) => {
    if (url.includes('/auth/v3/tenant_access_token')) {
      tokenCalls++
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-xyz', expire: 7200 }), { status: 200 })
    }
    return new Response(JSON.stringify({ code: 0, data: { message_id: 'm' } }), { status: 200 })
  }
  const channel = { type: 'feishu_app', config: { appId: 'cache-app-id', chatId: 'oc_c' } }
  const secrets = { appSecret: 's' }
  const alert = { id: 1, message: 'x', createdAt: Date.now() }
  await sendChannel(channel, secrets, alert, fetcher)
  await sendChannel(channel, secrets, alert, fetcher)
  assert.equal(tokenCalls, 1)
})

test('飞书智能体缺少 App Secret 或目标 ID 时报错', async () => {
  await assert.rejects(
    () => sendChannel({ type: 'feishu_app', config: { appId: 'a', chatId: 'c' } }, {}, { message: 'x', createdAt: Date.now() }, async () => new Response('{}')),
    /App ID \/ App Secret/
  )
  await assert.rejects(
    () => sendChannel({ type: 'feishu_app', config: { appId: 'a' } }, { appSecret: 's' }, { message: 'x', createdAt: Date.now() }, async () => new Response('{}')),
    /目标群组/
  )
})

test('飞书智能体接口返回非 0 code 时抛出错误', async () => {
  await assert.rejects(
    () => sendChannel(
      { type: 'feishu_app', config: { appId: 'a', chatId: 'c' } },
      { appSecret: 's' },
      { id: 1, message: 'x', createdAt: Date.now() },
      async (url) => url.includes('/auth')
        ? new Response(JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }), { status: 200 })
        : new Response(JSON.stringify({ code: 19001, msg: 'permission denied' }), { status: 200 })
    ),
    /permission denied/
  )
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

test('邮件渠道支持用请求体模板改写请求体并展开多收件人', async () => {
  let request
  const result = await sendChannel(
    {
      type: 'email',
      config: {
        method: 'POST',
        authType: 'bearer',
        recipients: 'a@ex.com, b@ex.com',
        subject: '告警',
        bodyTemplate: '{"from":"alert@ex.com","to":["{{recipients}}"],"subject":"{{subject}}","text":"{{message}}"}'
      }
    },
    { url: 'https://api.resend.com/emails', token: 'resend-key' },
    { id: 1, appId: 'web', level: 'error', metric: 'error', message: '服务异常', createdAt: Date.now() },
    async (url, options) => {
      request = { url, options }
      return new Response('{"messageId":"mail-1"}', { status: 200 })
    }
  )
  assert.equal(request.url, 'https://api.resend.com/emails')
  assert.equal(request.options.headers.authorization, 'Bearer resend-key')
  assert.deepEqual(JSON.parse(request.options.body), {
    from: 'alert@ex.com',
    to: ['a@ex.com', 'b@ex.com'],
    subject: '告警',
    text: '服务异常'
  })
  assert.equal(result.providerMessageId, 'mail-1')
})

test('renderTemplate 支持 ${var} 新语法并兼容旧 {{var}} 语法', () => {
  const vars = { message: '错误', level: 'error' }
  assert.equal(renderTemplate('${message} - ${level}', vars), '错误 - error')
  assert.equal(renderTemplate('{{message}} - {{level}}', vars), '错误 - error')
  assert.equal(renderTemplate('${secret.token}', {}, { token: 'tk' }), 'tk')
  assert.equal(renderTemplate('无变量文本', vars), '无变量文本')
  assert.equal(renderTemplate('${unknown}', vars), '')
})

test('飞书文本渠道用 messageTemplate 渲染消息内容', async () => {
  let request
  await sendChannel(
    { type: 'feishu', config: { messageType: 'text', messageTemplate: '【${level}】${message}' } },
    { url: 'https://open.feishu.cn/hook/x' },
    { id: 1, appId: 'web', level: 'error', metric: 'error', message: '服务异常', createdAt: Date.now() },
    async (url, options) => { request = { url, options }; return new Response('{}', { status: 200 }) }
  )
  assert.deepEqual(JSON.parse(request.options.body), { msg_type: 'text', content: { text: '【error】服务异常' } })
})

test('飞书 interactive 卡片用 messageTemplate JSON 渲染变量', async () => {
  let request
  await sendChannel(
    { type: 'feishu', config: { messageType: 'interactive', messageTemplate: '{"header":{"title":{"content":"【${level}】"}},"elements":[{"text":{"content":"${message}"}}]}' } },
    { url: 'https://open.feishu.cn/hook/x' },
    { id: 1, appId: 'web', level: 'critical', metric: 'error', message: '宕机', createdAt: Date.now() },
    async (url, options) => { request = { url, options }; return new Response('{}', { status: 200 }) }
  )
  const body = JSON.parse(request.options.body)
  assert.equal(body.msg_type, 'interactive')
  assert.equal(body.card.header.title.content, '【critical】')
  assert.equal(body.card.elements[0].text.content, '宕机')
})

test('钉钉 markdown 渠道用 titleTemplate + messageTemplate 渲染', async () => {
  let request
  await sendChannel(
    { type: 'dingtalk', config: { messageType: 'markdown', titleTemplate: '【${level}】告警', messageTemplate: '### ${message}\n页面：${page}' } },
    { url: 'https://oapi.dingtalk.com/robot/send' },
    { id: 1, appId: 'web', level: 'error', metric: 'error', message: '服务异常', page: '/checkout', createdAt: Date.now() },
    async (url, options) => { request = { url, options }; return new Response('{"msgid":"m1"}', { status: 200 }) }
  )
  assert.deepEqual(JSON.parse(request.options.body), { msgtype: 'markdown', markdown: { title: '【error】告警', text: '### 服务异常\n页面：/checkout' } })
})

test('企业微信渠道用 messageTemplate 渲染文本消息', async () => {
  let request
  await sendChannel(
    { type: 'wecom', config: { messageTemplate: '${level}: ${message}' } },
    { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send' },
    { id: 1, appId: 'web', level: 'warning', metric: 'error', message: '慢页面', createdAt: Date.now() },
    async (url, options) => { request = { url, options }; return new Response('{"msgid":"w1"}', { status: 200 }) }
  )
  assert.deepEqual(JSON.parse(request.options.body), { msgtype: 'text', text: { content: 'warning: 慢页面' } })
})

test('normalizeChannel 按渠道白名单校验 messageType', () => {
  const ch = normalizeChannel({ name: '飞书', type: 'feishu', config: { messageType: 'interactive', messageTemplate: '{}' } })
  assert.equal(ch.config.messageType, 'interactive')
  const ch2 = normalizeChannel({ name: '企微', type: 'wecom', config: { messageType: 'markdown' } })
  assert.equal(ch2.config.messageType, 'text')
})
