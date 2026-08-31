/**
 * @file AI 洞察推送（P3 开放集成）
 *
 * 复用告警通道（alert_channels 表）将主动诊断洞察推送到 IM / Webhook。
 * 支持 webhook（JSON）/ feishu（互动卡片）/ dingtalk（markdown）/ wecom（markdown）。
 * 纯函数 + 注入 fetchImpl，便于单测（不依赖真实网络）。
 */
const PUSH_TYPES = ['webhook', 'feishu', 'dingtalk', 'wecom']

export function formatFinding(finding) {
  const title = `【AI 洞察·${scopeLabel(finding.scope)}】${finding.summary || ''}`
  const text = [
    `范围：${scopeLabel(finding.scope)}`,
    `对象：${finding.object || '-'}`,
    `置信度：${finding.confidence != null ? Math.round(Number(finding.confidence) * 100) + '%' : '-'}`,
    `结论：${finding.summary || '-'}`,
    finding.evidence?.length ? `证据：${finding.evidence.join('，')}` : ''
  ].filter(Boolean).join('\n')
  return { title, text }
}

/** 读取并筛选可推送的告警通道（来自 alert_channels 表） */
export async function loadPushChannels(db) {
  const rows = await db.prepare(
    "select id, name, type, config_json from alert_channels where enabled=1 and type in ('webhook','feishu','dingtalk','wecom')"
  ).all()
  return (rows || []).map(r => {
    let config = {}
    try { config = JSON.parse(r.config_json || '{}') } catch { config = {} }
    return { id: r.id, name: r.name, type: r.type, config }
  })
}

/**
 * 将一条洞察推送到所有启用的 IM / webhook 通道。
 * @returns {Array<{channelId, type, ok:boolean, error?:string}>}
 */
export async function deliverFinding(finding, { channels, fetchImpl = fetch, appId } = {}) {
  const list = channels || []
  const { title, text } = formatFinding(finding)
  const results = []
  for (const ch of list) {
    try {
      const endpoint = (ch.config?.endpoint || '').trim()
      if (!endpoint) throw new Error('通道未配置 endpoint')
      const payload = buildPayload(ch.type, { title, text, finding })
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const ok = Number(res?.status ?? 0) >= 200 && Number(res?.status ?? 0) < 300
      results.push({ channelId: ch.id, type: ch.type, ok })
      if (!ok) results[results.length - 1].error = `HTTP ${res?.status}`
    } catch (e) {
      results.push({ channelId: ch.id, type: ch.type, ok: false, error: String(e?.message || e) })
    }
  }
  return results
}

function buildPayload(type, { title, text, finding }) {
  if (type === 'feishu') {
    return { msg_type: 'interactive', card: {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: title.slice(0, 100) }, template: 'orange' },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: text.replace(/\n/g, '\n\n') } }]
    } }
  }
  if (type === 'dingtalk') {
    return { msgtype: 'markdown', markdown: { title: title.slice(0, 100), text } }
  }
  if (type === 'wecom') {
    return { msgtype: 'markdown', markdown: { content: `**${title}**\n\n${text}` } }
  }
  // webhook 默认：原始 JSON，便于自建系统消费
  return { title, text, scope: finding.scope, object: finding.object, confidence: finding.confidence, evidence: finding.evidence }
}

function scopeLabel(scope) {
  return ({
    'error-cluster': '错误簇', 'release-regression': '发布回归',
    'perf-regression': '性能退化', 'metric-drop': '指标骤降'
  })[scope] || scope || '洞察'
}
