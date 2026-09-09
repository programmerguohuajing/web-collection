/**
 * @file Next Horizon E4/E1 补齐：SDK 端交付自监控 + SDK 体积开销（Node / Postgres，与 Cloudflare D1 同构）。
 *
 * 与 Worker（cloudflare/worker.js 的 reportSdkMonitoring / getSdkMonitoring / reportSdkSize / getSdkSize）对齐：
 * - 存储表 sdk_monitoring / sdk_size 由 db.js 的 ensureSchema 幂等创建（migrations 0036/0037 的 PG 版本）。
 * - 查询全部用 `=?` 占位符（经 toPgSql 转 $n），与项目 PG SQL 红线一致。
 * - 无数据时返回 hasData=false，前端据此显示「待 SDK 上报 / CI 未上报」空态，绝不编造数字。
 */
import { all, first, run } from '../db.js'
import { sha256Hex } from '../../../../packages/auth-crypto.js'

const num = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0)

/** #1：SDK 端自监控快照上报（认证同 /api/collect：appId + x-app-key）。 */
export async function reportSdkMonitoring({ appId, appKey, body }) {
  if (!appId) throw new Error('missing appId')
  const app = await first('select collect_key_hash from applications where app_id = ? limit 1', [appId])
  if (app?.collect_key_hash && sha256Hex(appKey || '') !== app.collect_key_hash) {
    const err = new Error('bad app key')
    err.status = 401
    throw err
  }
  if (!body || typeof body !== 'object') throw new Error('invalid body')
  await run(
    `insert into sdk_monitoring(app_id, sdk_version, session_id, ts, sent, dropped, retried, timeouts, rate_limited, queue_full, storage_quota, health, payload)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      appId, body.sdkVersion?.toString().slice(0, 32) || null, body.sessionId?.toString().slice(0, 64) || null, Date.now(),
      num(body.sent), num(body.dropped), num(body.retried), num(body.timeouts),
      num(body.rateLimited), num(body.queueFull), num(body.storageQuota),
      body.health?.toString().slice(0, 16) || null,
      (body.payload && typeof body.payload === 'object') ? JSON.stringify(body.payload).slice(0, 4000) : null
    ]
  )
  return { ok: true }
}

/** #1：读取某 appId 在窗口内的自监控聚合。 */
export async function getSdkMonitoring({ appId, hours = 24 }) {
  const windowHours = Math.max(1, Math.min(720, Number(hours) || 24))
  const since = Date.now() - windowHours * 3600 * 1000
  if (!appId) return { appId: '', windowHours, since, hasData: false, totals: {}, latest: null, samples: 0 }
  const agg = await first(
    `select count(*) as samples,
            coalesce(sum(sent),0) as sent, coalesce(sum(dropped),0) as dropped,
            coalesce(sum(retried),0) as retried, coalesce(sum(timeouts),0) as timeouts,
            coalesce(sum(rate_limited),0) as rate_limited, coalesce(sum(queue_full),0) as queue_full,
            coalesce(sum(storage_quota),0) as storage_quota, max(ts) as last_ts
     from sdk_monitoring where app_id = ? and ts >= ?`,
    [appId, since]
  )
  if (!agg || Number(agg.samples) === 0) {
    return { appId, windowHours, since, hasData: false, totals: {}, latest: null, samples: 0 }
  }
  const latest = await first(
    'select sdk_version, health, ts from sdk_monitoring where app_id = ? and ts >= ? order by ts desc limit 1',
    [appId, since]
  )
  return {
    appId,
    windowHours,
    since,
    hasData: true,
    samples: Number(agg.samples),
    totals: {
      sent: Number(agg.sent), dropped: Number(agg.dropped), retried: Number(agg.retried),
      timeouts: Number(agg.timeouts), rateLimited: Number(agg.rate_limited),
      queueFull: Number(agg.queue_full), storageQuota: Number(agg.storage_quota)
    },
    latest: latest ? { sdkVersion: latest.sdk_version, health: latest.health, ts: Number(latest.ts) } : null
  }
}

/** #2：SDK 体积开销上报（CI 发版步骤；可选 x-ci-token 校验）。 */
export async function reportSdkSize({ ciToken, expectToken, body }) {
  if (expectToken && ciToken !== expectToken) {
    const err = new Error('bad ci token')
    err.status = 401
    throw err
  }
  if (!body || typeof body !== 'object' || !body.version) throw new Error('missing version')
  await run(
    `insert into sdk_size(version, gz_bytes, raw_bytes, min_bytes, runtime_mem, reported_at, ci_run)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      body.version.toString().slice(0, 32),
      num(body.gzBytes) || null, num(body.rawBytes) || null, num(body.minBytes) || null,
      (body.runtimeMem && typeof body.runtimeMem === 'object') ? JSON.stringify(body.runtimeMem).slice(0, 2000) : null,
      Date.now(), body.ciRun?.toString().slice(0, 64) || null
    ]
  )
  return { ok: true }
}

/** #2：读取体积开销（按版本；不传 version 返回各版本最新一条）。 */
export async function getSdkSize({ version } = {}) {
  const rows = version
    ? await all('select version, gz_bytes, raw_bytes, min_bytes, runtime_mem, reported_at, ci_run from sdk_size where version = ? order by reported_at desc limit 1', [version])
    : await all('select version, gz_bytes, raw_bytes, min_bytes, runtime_mem, reported_at, ci_run from sdk_size order by reported_at desc')
  const list = (rows || []).map(r => ({
    version: r.version,
    gzBytes: r.gz_bytes != null ? Number(r.gz_bytes) : null,
    rawBytes: r.raw_bytes != null ? Number(r.raw_bytes) : null,
    minBytes: r.min_bytes != null ? Number(r.min_bytes) : null,
    runtimeMem: r.runtime_mem ? safeParse(r.runtime_mem) : null,
    reportedAt: Number(r.reported_at),
    ciRun: r.ci_run || null
  }))
  return { hasData: list.length > 0, list }
}

function safeParse(s) { try { return JSON.parse(s) } catch { return null } }
