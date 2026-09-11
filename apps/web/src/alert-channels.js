// 品牌告警主题前缀：惰性读取 window.__BRAND__（/brand.js 同步注入，白标未启用时回落内置名）。
// 不再 import useBrand.ts：纯 JS 工具模块依赖 .ts + Vue 响应式会让 node --test 原生 ESM 无法解析（无扩展名 .ts 导入），
// 且每次调用读最新值，与 computed 语义一致。
function alertSubjectPrefix() {
  const brand = typeof window !== 'undefined' && window.__BRAND__
  return `${(brand && brand.name) || 'Web Collection'} 告警`
}

const DEFAULT_LEVELS = ['error', 'critical']
const DEFAULT_METRICS = ['error', 'log_error', 'regression']

export function createAlertChannelForm(row = {}) {
  const config = isObject(row.config) ? row.config : {}
  return {
    id: row.id || '',
    name: row.name || '',
    type: row.type || 'email',
    enabled: row.enabled ?? true,
    endpoint: '',
    endpointConfigured: Boolean(row.configured),
    recipients: config.recipients || '',
    appIds: list(row.appIds),
    levels: list(row.levels, DEFAULT_LEVELS),
    metrics: list(row.metrics, DEFAULT_METRICS),
    method: config.method || 'POST',
    headers: headersToText(config.headers),
    bodyTemplate: config.bodyTemplate || '',
    messageTemplate: config.messageTemplate || '',
    subjectTemplate: config.subjectTemplate || config.subject || '',
    titleTemplate: config.titleTemplate || '',
    messageType: config.messageType || '',
    subject: config.subject || alertSubjectPrefix(),
    templateId: config.templateId || '',
    authType: config.authType || 'none',
    token: '',
    username: '',
    password: '',
    appId: config.appId || '',
    appSecret: '',
    routingKey: '',
    chatId: config.chatId || '',
    receiveIdType: config.receiveIdType || 'chat_id'
  }
}

export function buildAlertChannelPayload(form) {
  const endpoint = String(form.endpoint || '').trim()
  const recipients = String(form.recipients || '').trim()
  const type = String(form.type || '')
  const isFeishuApp = type === 'feishu_app'
  const isPagerDuty = type === 'pagerduty'
  const routingKey = String(form.routingKey || '').trim()
  if (!form.id && !endpoint && !isFeishuApp && !isPagerDuty) throw new Error('新渠道必须填写 HTTPS 服务地址或 Webhook 地址')
  if (!form.id && isFeishuApp && !String(form.appSecret || '').trim()) throw new Error('飞书智能体渠道必须填写 App Secret')
  if (!form.id && isFeishuApp && !String(form.chatId || '').trim()) throw new Error('飞书智能体渠道必须填写目标群组/用户 ID')
  if (!form.id && isPagerDuty && !routingKey) throw new Error('PagerDuty 渠道必须填写 Routing Key')
  if (type === 'sms' && !recipients) throw new Error('短信渠道必须填写接收人')
  if (type === 'email' && !recipients && !String(form.bodyTemplate || '').trim()) throw new Error('邮件渠道必须填写接收人或请求体模板')

  const secrets = {}
  if (endpoint) secrets.url = endpoint
  if (String(form.token || '').trim()) secrets.token = String(form.token).trim()
  if (String(form.username || '').trim()) secrets.username = String(form.username).trim()
  if (String(form.password || '')) secrets.password = String(form.password)
  if (isFeishuApp && String(form.appSecret || '').trim()) secrets.appSecret = String(form.appSecret).trim()
  if (isPagerDuty && routingKey) secrets.routingKey = routingKey

  return {
    id: form.id || undefined,
    name: String(form.name || '').trim(),
    type,
    enabled: form.enabled !== false,
    config: {
      method: form.method || 'POST',
      headers: parseHeaders(form.headers),
      bodyTemplate: String(form.bodyTemplate || '').trim(),
      messageTemplate: String(form.messageTemplate || '').trim(),
      subjectTemplate: String(form.subjectTemplate || '').trim(),
      titleTemplate: String(form.titleTemplate || '').trim(),
      messageType: form.messageType || undefined,
      recipients,
      subject: String(form.subject || '').trim(),
      templateId: String(form.templateId || '').trim(),
      authType: form.authType || 'none',
      appId: isFeishuApp ? String(form.appId || '').trim() : undefined,
      chatId: isFeishuApp ? String(form.chatId || '').trim() : undefined,
      receiveIdType: isFeishuApp ? String(form.receiveIdType || 'chat_id').trim() : undefined
    },
    appIds: list(form.appIds),
    levels: list(form.levels),
    metrics: list(form.metrics),
    secrets
  }
}

export function channelScope(row) {
  return list(row.appIds).join(', ') || '全部应用'
}

export function channelFilters(value) {
  return list(value).join(', ') || '全部'
}

export function channelEndpointStatus(row) {
  return row.configured ? '已安全配置' : '未配置'
}

function parseHeaders(value) {
  if (isObject(value)) return value
  const headers = {}
  for (const line of String(value || '').split('\n').map(item => item.trim()).filter(Boolean)) {
    const separator = line.indexOf(':')
    if (separator <= 0) throw new Error(`请求头格式无效：${line}`)
    const key = line.slice(0, separator).trim()
    const item = line.slice(separator + 1).trim()
    if (!key) throw new Error(`请求头格式无效：${line}`)
    headers[key] = item
  }
  return headers
}

function headersToText(value) {
  if (!isObject(value)) return ''
  return Object.entries(value).map(([key, item]) => `${key}: ${item}`).join('\n')
}

function list(value, fallback = []) {
  if (Array.isArray(value)) return [...value]
  if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean)
  return [...fallback]
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
