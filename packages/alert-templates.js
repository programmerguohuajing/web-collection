export const channelMessageTypes = {
  email: ['text'],
  sms: ['sms'],
  feishu: ['text', 'interactive'],
  feishu_app: ['text', 'interactive'],
  wecom: ['text'],
  dingtalk: ['text', 'markdown'],
  webhook: ['json']
}

export const templateVariables = [
  { key: 'message', label: '告警内容', desc: '告警消息文本', example: '错误率超阈值', group: '基础', types: '*' },
  { key: 'level', label: '告警级别', desc: 'warning / error / critical', example: 'error', group: '基础', types: '*' },
  { key: 'metric', label: '指标', desc: '触发指标', example: 'error', group: '基础', types: '*' },
  { key: 'value', label: '当前值', desc: '指标当前值', example: '12.5', group: '基础', types: '*' },
  { key: 'threshold', label: '阈值', desc: '触发阈值', example: '10', group: '基础', types: '*' },
  { key: 'appId', label: '应用ID', desc: '来源应用', example: 'web-portal', group: '基础', types: '*' },
  { key: 'page', label: '页面路径', desc: '触发页面', example: '/checkout', group: '上下文', types: '*' },
  { key: 'release', label: '版本', desc: '应用版本', example: 'v1.2.3', group: '上下文', types: '*' },
  { key: 'traceId', label: '链路ID', desc: '关联追踪ID', example: 'a1b2c3', group: '上下文', types: '*' },
  { key: 'occurredAt', label: '发生时间', desc: 'ISO 8601 时间', example: '2026-08-18T04:00:00Z', group: '上下文', types: '*' },
  { key: 'alertId', label: '告警ID', desc: '告警唯一标识', example: '1024', group: '上下文', types: '*' },
  { key: 'recipients', label: '接收人', desc: '配置的接收人列表', example: 'a@b.com', group: '渠道', types: ['email', 'sms'] },
  { key: 'subject', label: '主题', desc: '邮件主题', example: '告警通知', group: '渠道', types: ['email'] }
]

export function renderTemplate(tpl, variables = {}, secrets = {}) {
  if (typeof tpl !== 'string') return tpl
  return tpl
    .replace(/\$\{\s*(secret\.)?([A-Za-z0-9_]+)\s*\}/g, (_, s, k) => String(s ? secrets[k] ?? '' : variables[k] ?? ''))
    .replace(/\{\{\s*(secret\.)?([A-Za-z0-9_]+)\s*\}\}/g, (_, s, k) => String(s ? secrets[k] ?? '' : variables[k] ?? ''))
}

export function variablesForChannel(type, config = {}) {
  return templateVariables.filter(v => v.types === '*' || (Array.isArray(v.types) && v.types.includes(type)))
}
