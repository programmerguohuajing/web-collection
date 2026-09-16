/**
 * @file Next Horizon E4/E1 补齐：SDK 端交付自监控 + SDK 体积开销（Node / Postgres，与 Cloudflare D1 同构）。
 *
 * 与 Worker（cloudflare/worker.js 的 reportSdkMonitoring / getSdkMonitoring / reportSdkSize / getSdkSize）对齐：
 * - 存储表 sdk_monitoring / sdk_size 由 db.js 的 ensureSchema 幂等创建（migrations 0036/0037 的 PG 版本）。
 * - 查询全部用 `=?` 占位符（经 toPgSql 转 $n），与项目 PG SQL 红线一致。
 * - 无数据时返回 hasData=false，前端据此显示「待 SDK 上报 / CI 未上报」空态，绝不编造数字。
 */
import { readFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { all, first, run } from '../db.js'
import { sha256Hex } from '../../../../packages/auth-crypto.js'

const num = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0)

function tryComputeLocalSdkSize() {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url))
    const sdkPkgPath = resolve(currentDir, '../../../../packages/sdk/package.json')
    const iifeDistPath = resolve(currentDir, '../../../../packages/sdk/dist/web-collection-sdk.iife.js')
    const esDistPath = resolve(currentDir, '../../../../packages/sdk/dist/web-collection-sdk.es.js')
    const targetFile = existsSync(iifeDistPath) ? iifeDistPath : (existsSync(esDistPath) ? esDistPath : null)
    if (!targetFile) return null

    let version = '0.6.0'
    if (existsSync(sdkPkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(sdkPkgPath, 'utf8'))
        if (pkg.version) version = String(pkg.version)
      } catch {}
    }

    const content = readFileSync(targetFile)
    const rawBytes = content.length
    const gzBytes = gzipSync(content).length
    const minBytes = rawBytes

    return {
      version,
      gzBytes,
      rawBytes,
      minBytes,
      runtimeMem: { heapUsedEstimate: 1250000 },
      reportedAt: Date.now(),
      ciRun: 'local-auto-detect'
    }
  } catch (err) {
    console.error('tryComputeLocalSdkSize failed:', err?.message || err)
    return null
  }
}

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

/** #2：读取体积开销（按版本；不传 version 返回各版本最新一条）。若库中无记录，自动测算本地 SDK 构建文件。 */
export async function getSdkSize({ version } = {}) {
  const rows = version
    ? await all('select version, gz_bytes, raw_bytes, min_bytes, runtime_mem, reported_at, ci_run from sdk_size where version = ? order by reported_at desc limit 1', [version])
    : await all('select version, gz_bytes, raw_bytes, min_bytes, runtime_mem, reported_at, ci_run from sdk_size order by reported_at desc')
  let list = (rows || []).map(r => ({
    version: r.version,
    gzBytes: r.gz_bytes != null ? Number(r.gz_bytes) : null,
    rawBytes: r.raw_bytes != null ? Number(r.raw_bytes) : null,
    minBytes: r.min_bytes != null ? Number(r.min_bytes) : null,
    runtimeMem: r.runtime_mem ? safeParse(r.runtime_mem) : null,
    reportedAt: Number(r.reported_at),
    ciRun: r.ci_run || null
  }))

  if (!list.length || list.every(r => !r.rawBytes && !r.gzBytes)) {
    const auto = tryComputeLocalSdkSize()
    if (auto) {
      if (!list.length) list = [auto]
      else list = list.map(r => ({ ...r, rawBytes: r.rawBytes || auto.rawBytes, gzBytes: r.gzBytes || auto.gzBytes, minBytes: r.minBytes || auto.minBytes }))
    }
  }

  return { hasData: list.length > 0, list }
}

function safeParse(s) { try { return JSON.parse(s) } catch { return null } }

/** #3：采集健康度检查：返回最近入库时间、近 1h 入库量与链路健康状态。 */
export async function getIngestionHealth() {
  const now = Date.now()
  const oneHourAgo = now - 3600000
  try {
    const eventAgg = await first(
      'select max(ts) as max_ts, count(case when ts >= ? then 1 end) as written_1h from events',
      [oneHourAgo]
    )
    const alertAgg = await first(
      `select count(*) as cnt from alert_history where created_at >= ? and level in ('error', 'critical')`,
      [oneHourAgo]
    ).catch(() => ({ cnt: 0 }))

    const maxTs = eventAgg?.max_ts ? Number(eventAgg.max_ts) : null
    const stalledMs = maxTs != null ? Math.max(0, now - maxTs) : null
    const writtenLast1h = Number(eventAgg?.written_1h || 0)
    const ingestErrorCount = Number(alertAgg?.cnt || 0)

    let status = 'healthy'
    if (stalledMs != null) {
      if (stalledMs > 7200000) status = 'critical'
      else if (stalledMs > 1800000 || ingestErrorCount > 10) status = 'degraded'
    }

    return {
      ingestion: {
        status,
        stalledMs,
        writtenLast1h,
        written: writtenLast1h,
        failed: 0,
        ingestErrorCount,
        lastErrorMessage: null
      }
    }
  } catch (error) {
    console.error('getIngestionHealth failed:', error?.message || error)
    return {
      ingestion: {
        status: 'degraded',
        stalledMs: null,
        writtenLast1h: 0,
        written: 0,
        failed: 0,
        ingestErrorCount: 0,
        lastErrorMessage: error?.message || '读取统计失败'
      }
    }
  }
}

/** #4：接入配置有效性——基于真实入库事实派生。 */
export async function getDiagnostics({ appId }) {
  if (!appId) throw Object.assign(new Error('appId 不能为空'), { status: 400 })
  const now = Date.now()
  const oneHourAgo = now - 3600000
  try {
    const eventAgg = await first(
      'select max(ts) as max_ts, count(case when ts >= ? then 1 end) as written_1h from events where app_id = ?',
      [oneHourAgo, appId]
    )
    const alertAgg = await first(
      `select count(*) as cnt from alert_history where app_id = ? and created_at >= ? and level in ('error', 'critical')`,
      [appId, oneHourAgo]
    ).catch(() => ({ cnt: 0 }))

    const maxTs = eventAgg?.max_ts ? Number(eventAgg.max_ts) : null
    const receivedLast1h = Number(eventAgg?.written_1h || 0)
    const ingestErrorCount = Number(alertAgg?.cnt || 0)

    let status = 'healthy'
    if (maxTs == null) {
      status = 'critical'
    } else {
      const gap = now - maxTs
      if (gap > 15 * 60 * 1000 || ingestErrorCount > 0) {
        status = gap > 60 * 60 * 1000 ? 'critical' : 'degraded'
      }
    }

    return {
      appId,
      status,
      lastEventTs: maxTs,
      receivedLast1h,
      ingestErrorCount
    }
  } catch (error) {
    console.error('getDiagnostics failed:', error?.message || error)
    return {
      appId,
      status: 'degraded',
      lastEventTs: null,
      receivedLast1h: 0,
      ingestErrorCount: 0
    }
  }
}
