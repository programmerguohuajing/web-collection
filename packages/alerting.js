import { Receiver } from '@upstash/qstash'

export const channelTypes = ['email', 'sms', 'feishu', 'feishu_app', 'wecom', 'dingtalk', 'webhook']
export const alertLevels = ['warning', 'error', 'critical']
export const alertMetrics = ['error', 'log_error', 'regression', 'lcp', 'inp', 'cls', 'longtask']

const encoder = new TextEncoder()

export function normalizeChannel(input = {}) {
  const type = channelTypes.includes(input.type) ? input.type : ''
  const name = String(input.name || '').trim().slice(0, 128)
  if (!name || !type) throw new Error('渠道名称和类型不能为空')
  const legacyConfig = {
    method: input.method,
    headers: input.webhookHeaders,
    bodyTemplate: input.bodyTemplate,
    recipients: input.recipients || (type === 'email' || type === 'sms' ? input.endpoint : ''),
    subject: input.subject,
    templateId: input.templateId,
    authType: input.authType
  }
  const config = isPlainObject(input.config) ? input.config : legacyConfig
  if (config.headers != null && (!config.headers || typeof config.headers !== 'object' || Array.isArray(config.headers))) throw new Error('请求头必须是 JSON 对象')
  if (config.bodyTemplate) {
    try { JSON.parse(config.bodyTemplate) } catch { throw new Error('请求体模板必须是有效 JSON') }
  }
  for (const [key, value] of Object.entries(config.headers || {})) {
    if (/(authorization|api[-_]?key|token|secret)/i.test(key) && !String(value).includes('{{secret.')) {
      throw new Error(`敏感请求头 ${key} 必须使用 {{secret.KEY}} 变量`)
    }
  }
  const legacyUrl = input.webhookUrl || (type !== 'email' && type !== 'sms' ? input.endpoint : '')
  const secrets = {
    ...(legacyUrl ? { url: legacyUrl } : {}),
    ...(input.webhookSecret ? { token: input.webhookSecret } : {}),
    ...plainObject(input.secrets)
  }
  if (secrets.url) validateEndpoint(String(secrets.url))
  if (type === 'feishu_app' && !String(config.chatId || '').trim()) throw new Error('飞书智能体渠道必须填写目标群组/用户 ID')
  const method = String(config.method || 'POST').toUpperCase()
  if (!['POST', 'PUT', 'PATCH'].includes(method)) throw new Error('仅支持 POST、PUT、PATCH 请求')
  return {
    name,
    type,
    enabled: input.enabled !== false,
    config: {
      method,
      headers: plainObject(config.headers),
      bodyTemplate: String(config.bodyTemplate || '').slice(0, 20000),
      recipients: String(config.recipients || '').slice(0, 4000),
      subject: String(config.subject || 'Web Collection 告警').slice(0, 256),
      templateId: String(config.templateId || '').slice(0, 256),
      authType: ['none', 'bearer', 'basic'].includes(config.authType) ? config.authType : 'none'
    },
    appIds: strings(input.appIds ?? input.appId, 100, 64),
    levels: strings(input.levels, 3, 16).filter(value => alertLevels.includes(value)),
    metrics: strings(input.metrics, 20, 32).filter(value => alertMetrics.includes(value)),
    secrets
  }
}

export function channelMatches(channel, alert) {
  const appIds = parseValue(channel.app_ids_json ?? channel.appIds, [])
  const levels = parseValue(channel.levels_json ?? channel.levels, [])
  const metrics = parseValue(channel.metrics_json ?? channel.metrics, [])
  return (!appIds.length || appIds.includes(alert.appId))
    && (!levels.length || levels.includes(alert.level))
    && (!metrics.length || metrics.includes(alert.metric))
}

export function publicChannel(row) {
  return {
    id: Number(row.id),
    name: row.name,
    type: row.type,
    enabled: Boolean(row.enabled),
    config: parseValue(row.config_json, {}),
    appIds: parseValue(row.app_ids_json, []),
    levels: parseValue(row.levels_json, []),
    metrics: parseValue(row.metrics_json, []),
    configured: Boolean(row.secret_ciphertext),
    lastTestStatus: row.last_test_status || null,
    lastTestError: row.last_test_error || null,
    lastTestAt: row.last_test_at == null ? null : Number(row.last_test_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

export async function encryptSecrets(value, masterKey) {
  if (!Object.keys(value || {}).length) return null
  if (!masterKey) throw new Error('ALERT_SECRET_MASTER_KEY 未配置')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(masterKey),
    encoder.encode(JSON.stringify(value))
  ))
  return `${base64(iv)}.${base64(cipher)}`
}

export async function decryptSecrets(ciphertext, masterKey) {
  if (!ciphertext) return {}
  if (!masterKey) throw new Error('ALERT_SECRET_MASTER_KEY 未配置')
  const [iv, cipher] = String(ciphertext).split('.').map(unbase64)
  if (!iv || !cipher) throw new Error('渠道密钥格式无效')
  const value = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await encryptionKey(masterKey), cipher)
  return JSON.parse(new TextDecoder().decode(value))
}

export async function sendChannel(channel, secrets, alert, fetcher = fetch) {
  const config = parseValue(channel.config_json ?? channel.config, {})
  const variables = {
    message: alert.message,
    appId: alert.appId,
    level: alert.level,
    metric: alert.metric,
    value: alert.value ?? '',
    threshold: alert.threshold ?? '',
    page: alert.page || '-',
    release: alert.release || '-',
    traceId: alert.traceId || '-',
    occurredAt: new Date(Number(alert.createdAt || Date.now())).toISOString(),
    alertId: alert.id ?? '',
    recipients: config.recipients || '',
    subject: config.subject || 'Web Collection 告警',
    templateId: config.templateId || ''
  }
  const type = channel.type
  let targetUrl
  let headers
  let body
  if (type === 'feishu') {
    // 飞书自定义机器人：直接 POST 到群 webhook 地址
    const url = String(secrets.url || '').trim()
    validateEndpoint(url)
    targetUrl = url
    headers = { 'content-type': 'application/json' }
    body = { msg_type: 'text', content: { text: alert.message } }
  } else if (type === 'feishu_app') {
    // 飞书智能体/应用机器人：通过 OpenAPI 发送
    const resolved = await buildFeishuAppRequest(secrets, config, alert, fetcher)
    targetUrl = resolved.url
    headers = resolved.headers
    body = resolved.body
  } else {
    const url = String(secrets.url || '').trim()
    validateEndpoint(url)
    targetUrl = url
    headers = { 'content-type': 'application/json', ...renderObject(config.headers, variables, secrets) }
    if (config.authType === 'bearer') {
      if (!secrets.token) throw new Error('Bearer Token 未配置')
      headers.authorization = `Bearer ${secrets.token}`
    } else if (config.authType === 'basic') {
      if (!secrets.username || !secrets.password) throw new Error('Basic 用户名或密码未配置')
      headers.authorization = `Basic ${base64(encoder.encode(`${secrets.username}:${secrets.password}`))}`
    }
    body = type === 'wecom'
      ? { msgtype: 'text', text: { content: alert.message } }
      : type === 'dingtalk'
        ? { msgtype: 'text', text: { content: alert.message } }
        : config.bodyTemplate
          ? renderObject(JSON.parse(config.bodyTemplate), variables, secrets)
          : defaultBody(type, variables)
  }
  const response = await fetcher(targetUrl, {
    method: config.method || 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}${text ? `: ${redactSecrets(text.slice(0, 300), secrets)}` : ''}`)
  const result = parseValue(text, {})
  let providerMessageId
  if (type === 'feishu_app') {
    if (result.code !== 0 && result.code !== undefined) throw new Error(`飞书接口返回错误 code=${result.code}: ${result.msg || ''}`)
    providerMessageId = String(result.data?.message_id || result.message_id || '').slice(0, 256) || null
  } else {
    providerMessageId = String(result.messageId || result.msg_id || result.id || response.headers.get('x-request-id') || '').slice(0, 256) || null
  }
  return { providerMessageId }
}

export async function publishDelivery({ token, baseUrl, deliveryId, fetcher = fetch }) {
  if (!token || !baseUrl) return null
  const destination = new URL('/api/internal/alerts/deliver', baseUrl).toString()
  const response = await fetcher(`https://qstash.upstash.io/v2/publish/${destination}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'upstash-retries': '5',
      'upstash-retry-delay': 'pow(2, retried) * 1000'
    },
    body: JSON.stringify({ deliveryId })
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`QStash HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`)
  return parseValue(text, {}).messageId || null
}

export async function verifyQStash({ body, signature, url, currentSigningKey, nextSigningKey }) {
  if (!signature || !currentSigningKey || !nextSigningKey) return false
  const receiver = new Receiver({ currentSigningKey, nextSigningKey })
  return receiver.verify({ body, signature, url })
}

export function alertContext(event = {}, threshold) {
  return {
    page: event.path || event.url || '-',
    release: event.release || '-',
    traceId: event.traceId || '-',
    threshold: threshold !== null && threshold !== undefined && threshold !== '' && Number.isFinite(Number(threshold)) ? Number(threshold) : null
  }
}

function defaultBody(type, value) {
  if (type === 'email') return { to: value.recipients, subject: value.subject, text: value.message }
  if (type === 'sms') return { to: value.recipients, templateId: value.templateId, params: { message: value.message } }
  return { text: value.message, alert: value }
}

function renderObject(value, variables, secrets) {
  if (Array.isArray(value)) return value.map(item => renderObject(item, variables, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderObject(item, variables, secrets)]))
  if (typeof value !== 'string') return value
  return value.replace(/\{\{\s*(secret\.)?([A-Za-z0-9_]+)\s*\}\}/g, (_, secret, key) => String(secret ? secrets[key] ?? '' : variables[key] ?? ''))
}

async function buildFeishuAppRequest(secrets, config, alert, fetcher) {
  const appId = String(config.appId || '').trim()
  const appSecret = String(secrets.appSecret || '').trim()
  const chatId = String(config.chatId || '').trim()
  if (!appId || !appSecret) throw new Error('飞书应用 App ID / App Secret 未配置')
  if (!chatId) throw new Error('飞书目标群组/用户 ID 未配置')
  const domain = String(config.feishuDomain || 'https://open.feishu.cn').replace(/\/+$/, '')
  const receiveIdType = encodeURIComponent(String(config.receiveIdType || 'chat_id').trim() || 'chat_id')
  const token = await getFeishuTenantToken(appId, appSecret, fetcher)
  return {
    url: `${domain}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: alert.message }) }
  }
}

const feishuTokenCache = new Map()

async function getFeishuTenantToken(appId, appSecret, fetcher) {
  const cached = feishuTokenCache.get(appId)
  if (cached && cached.expire > Date.now()) return cached.token
  const response = await fetcher('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(8000)
  })
  const data = parseValue(await response.text(), {})
  if (!response.ok || data.code !== 0) throw new Error(`获取飞书 tenant_access_token 失败: ${data.msg || response.status}`)
  const expire = (Number(data.expire) || 7200) * 1000
  feishuTokenCache.set(appId, { token: data.tenant_access_token, expire: Date.now() + expire - 60000 })
  return data.tenant_access_token
}

function validateEndpoint(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('渠道 URL 无效') }
  if (url.protocol !== 'https:') throw new Error('渠道 URL 必须使用 HTTPS')
}

async function encryptionKey(masterKey) {
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(masterKey)), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [String(key).slice(0, 128), String(item).slice(0, 4000)]))
    : {}
}

function strings(value, max, size) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return [...new Set(items.map(item => String(item).trim().slice(0, size)).filter(Boolean))].slice(0, max)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseValue(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function base64(bytes) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

function unbase64(value) {
  try { return Uint8Array.from(atob(value), char => char.charCodeAt(0)) } catch { return null }
}

function redactSecrets(value, secrets) {
  let output = String(value)
  for (const secret of Object.values(secrets || {}).map(String).filter(item => item.length >= 4)) output = output.replaceAll(secret, '[REDACTED]')
  return output
}
