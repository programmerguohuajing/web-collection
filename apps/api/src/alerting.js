import {
  alertContext,
  channelMatches,
  decryptSecrets,
  encryptSecrets,
  normalizeChannel,
  publicChannel,
  publishDelivery,
  sendChannel,
  verifyQStash
} from '../../../packages/alerting.js'
import { all, run, scalar } from './db.js'

const masterKey = () => process.env.ALERT_SECRET_MASTER_KEY || ''
const qstashToken = () => process.env.QSTASH_TOKEN || ''
const publicBaseUrl = () => process.env.ALERT_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || ''

export async function listAlertChannels(filters = {}) {
  const { page, pageSize } = pageOf(filters)
  const [items, total] = await Promise.all([
    all('select * from alert_channels order by updated_at desc limit ? offset ?', [pageSize, (page - 1) * pageSize]),
    scalar('select count(*) count from alert_channels')
  ])
  return { items: items.map(publicChannel), total, page, pageSize }
}

export async function saveAlertChannel(id, input) {
  const value = normalizeChannel(input)
  const now = Date.now()
  const existing = id ? (await all('select * from alert_channels where id=?', [id]))[0] : null
  if (id && !existing) throw new Error('告警渠道不存在')
  const secrets = Object.keys(value.secrets).length
    ? await encryptSecrets({ ...await decryptSecrets(existing?.secret_ciphertext, masterKey()), ...value.secrets }, masterKey())
    : existing?.secret_ciphertext || null
  const params = [
    value.name, value.type, value.enabled, JSON.stringify(value.config), secrets,
    JSON.stringify(value.appIds), JSON.stringify(value.levels), JSON.stringify(value.metrics), now
  ]
  const result = id
    ? await run(
      `update alert_channels set name=?,type=?,enabled=?,config_json=?::jsonb,secret_ciphertext=?,
       app_ids_json=?::jsonb,levels_json=?::jsonb,metrics_json=?::jsonb,updated_at=? where id=? returning *`,
      [...params, id]
    )
    : await run(
      `insert into alert_channels(name,type,enabled,config_json,secret_ciphertext,app_ids_json,levels_json,metrics_json,created_at,updated_at)
       values(?,?,?,?::jsonb,?,?::jsonb,?::jsonb,?::jsonb,?,?) returning *`,
      [...params, now]
    )
  return publicChannel(result.rows[0])
}

export async function deleteAlertChannel(id) {
  const now = Date.now()
  await run(`update alert_deliveries set status='cancelled',last_error='渠道已删除',updated_at=? where channel_id=? and status in ('pending','sending','failed')`, [now, id])
  await run('delete from alert_channels where id=?', [id])
  return { ok: true }
}

export async function testAlertChannel(id) {
  const channel = (await all('select * from alert_channels where id=?', [id]))[0]
  if (!channel) throw new Error('告警渠道不存在')
  const now = Date.now()
  try {
    await sendChannel(channel, await decryptSecrets(channel.secret_ciphertext, masterKey()), {
      id: 'test',
      appId: 'test-app',
      metric: 'error',
      level: 'error',
      value: 1,
      message: '[测试告警] Web Collection 告警渠道配置验证',
      page: '/governance',
      release: 'test',
      traceId: 'test',
      createdAt: now
    })
    await run(`update alert_channels set last_test_status='sent',last_test_error=null,last_test_at=?,updated_at=? where id=?`, [now, now, id])
    return { ok: true }
  } catch (error) {
    const message = errorMessage(error)
    await run(`update alert_channels set last_test_status='failed',last_test_error=?,last_test_at=?,updated_at=? where id=?`, [message, now, now, id])
    throw new Error(message)
  }
}

export async function createAlertDeliveries(alertId) {
  const alert = await getAlert(alertId)
  if (!alert) return
  const channels = await all('select * from alert_channels where enabled=true')
  const matched = channels.filter(channel => channelMatches(channel, alert))
  if (!channels.length && process.env.FEISHU_WEBHOOK_URL) {
    try {
      await sendChannel({ type: 'feishu', config_json: '{}' }, { url: process.env.FEISHU_WEBHOOK_URL }, alert)
      await run('update alert_history set notified=true,notify_error=null where id=?', [alertId])
    } catch (error) {
      await run('update alert_history set notified=false,notify_error=? where id=?', [errorMessage(error), alertId])
    }
    return
  }
  for (const channel of matched) {
    const now = Date.now()
    const result = await run(
      `insert into alert_deliveries(alert_id,channel_id,channel_name,channel_type,status,created_at,updated_at)
       values(?,?,?,?, 'pending', ?, ?) returning id`,
      [alertId, channel.id, channel.name, channel.type, now, now]
    )
    await queueOrDeliver(Number(result.rows[0].id))
  }
  await updateAlertStatus(alertId)
}

export async function listAlertDeliveries(filters = {}) {
  const { page, pageSize } = pageOf(filters)
  const conditions = []
  const values = []
  if (filters.alertId) { conditions.push('alert_id=?'); values.push(Number(filters.alertId)) }
  if (filters.status) { conditions.push('status=?'); values.push(String(filters.status)) }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : ''
  const [items, total] = await Promise.all([
    all(`select * from alert_deliveries ${where} order by created_at desc limit ? offset ?`, [...values, pageSize, (page - 1) * pageSize]),
    scalar(`select count(*) count from alert_deliveries ${where}`, values)
  ])
  return { items, total, page, pageSize }
}

export async function retryAlertDelivery(id) {
  const row = (await all('select alert_id from alert_deliveries where id=?', [id]))[0]
  if (!row) throw new Error('投递记录不存在')
  await run(`update alert_deliveries set status='pending',last_error=null,queue_message_id=null,updated_at=? where id=?`, [Date.now(), id])
  await queueOrDeliver(Number(id))
  return (await all('select * from alert_deliveries where id=?', [id]))[0]
}

export async function consumeAlertDelivery({ body, signature, url, retried = 0 }) {
  const valid = await verifyQStash({
    body,
    signature,
    url,
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY
  })
  if (!valid) return { status: 401, body: { error: 'invalid QStash signature' } }
  const deliveryId = Number(JSON.parse(body).deliveryId)
  try {
    await deliverAlertDelivery(deliveryId, retried)
    return { status: 200, body: { ok: true } }
  } catch (error) {
    const dead = Number(retried) >= 5
    return {
      status: dead ? 489 : 500,
      body: { error: errorMessage(error) },
      headers: dead ? { 'Upstash-NonRetryable-Error': 'true' } : {}
    }
  }
}

export async function retryPendingDeliveries() {
  const rows = await all(`select id from alert_deliveries where status='pending' and queue_message_id is null and updated_at<? order by updated_at limit 100`, [Date.now() - 60000])
  for (const row of rows) await queueOrDeliver(Number(row.id))
  return rows.length
}

export async function deliverAlertDelivery(id, retried = 0) {
  const rows = await all(
    `select d.*,c.config_json,c.secret_ciphertext,a.app_id,a.metric,a.level,a.value,a.message,a.context_json,a.created_at alert_created_at
     from alert_deliveries d left join alert_channels c on c.id=d.channel_id
     join alert_history a on a.id=d.alert_id where d.id=?`,
    [id]
  )
  const row = rows[0]
  if (!row || ['sent', 'cancelled'].includes(row.status)) return
  if (!row.channel_id) {
    await run(`update alert_deliveries set status='cancelled',last_error='渠道不存在',updated_at=? where id=?`, [Date.now(), id])
    return
  }
  const claimed = await run(
    `update alert_deliveries set status='sending',attempts=attempts+1,updated_at=?
     where id=? and (status in ('pending','failed','dead') or (status='sending' and updated_at<?)) returning id`,
    [Date.now(), id, Date.now() - 10000]
  )
  if (!claimed.rows.length) {
    if (row.status === 'sending') throw new Error('投递正在处理中')
    return
  }
  try {
    const result = await sendChannel(
      { type: row.channel_type, config_json: row.config_json },
      await decryptSecrets(row.secret_ciphertext, masterKey()),
      mapAlert(row)
    )
    const now = Date.now()
    await run(`update alert_deliveries set status='sent',provider_message_id=?,last_error=null,sent_at=?,updated_at=? where id=?`, [result.providerMessageId, now, now, id])
  } catch (error) {
    await run(`update alert_deliveries set status=?,last_error=?,updated_at=? where id=?`, [Number(retried) >= 5 ? 'dead' : 'failed', errorMessage(error), Date.now(), id])
    await updateAlertStatus(row.alert_id)
    throw error
  }
  await updateAlertStatus(row.alert_id)
}

async function queueOrDeliver(id) {
  if (!qstashToken() || !publicBaseUrl()) {
    try { await deliverAlertDelivery(id) } catch {}
    return
  }
  try {
    const messageId = await publishDelivery({ token: qstashToken(), baseUrl: publicBaseUrl(), deliveryId: id })
    await run('update alert_deliveries set queue_message_id=?,last_error=null,updated_at=? where id=?', [messageId, Date.now(), id])
  } catch (error) {
    await run('update alert_deliveries set last_error=?,updated_at=? where id=?', [errorMessage(error), Date.now(), id])
  }
}

async function getAlert(id) {
  const row = (await all('select * from alert_history where id=?', [id]))[0]
  return row ? mapAlert({ ...row, alert_created_at: row.created_at }) : null
}

function mapAlert(row) {
  const context = parse(row.context_json, {})
  return {
    id: Number(row.alert_id || row.id),
    appId: row.app_id,
    metric: row.metric,
    level: row.level,
    value: row.value,
    message: row.message,
    createdAt: Number(row.alert_created_at),
    ...context
  }
}

async function updateAlertStatus(alertId) {
  const stats = (await all(
    `select count(*) total,sum(case when status='sent' then 1 else 0 end) sent,
     sum(case when status in ('failed','dead') then 1 else 0 end) failed
     from alert_deliveries where alert_id=?`,
    [alertId]
  ))[0]
  const error = Number(stats.failed) ? `${Number(stats.failed)}/${Number(stats.total)} 个渠道发送失败` : null
  await run('update alert_history set notified=?,notify_error=? where id=?', [Number(stats.sent) > 0, error, alertId])
}

export function buildAlertContext(event, threshold) {
  return alertContext(event, threshold)
}

function pageOf(filters) {
  return { page: Math.max(1, Number(filters.page || 1)), pageSize: Math.max(1, Math.min(100, Number(filters.pageSize || 10))) }
}

function parse(value, fallback) {
  if (value == null) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function errorMessage(error) {
  return String(error?.message || error).slice(0, 1000)
}
