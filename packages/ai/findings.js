/**
 * @file AI 主动诊断 · 洞察流（P1 产品化）
 *
 * 四类规则检测器 + 落库仓库 + 扫描编排。扫描为「廉价规则」（不调用 LLM），
 * 写入 ai_findings；用户点开某条洞察时再调用 /api/ai/diagnose 做深诊断（复用 P0 scope 引擎）。
 *
 * 检测器：
 *   1. error-cluster        错误簇突增（窗口内按错误名计数 top）
 *   2. release-regression   发布回归（新 release 对比上一版的错误率/性能变化）
 *   3. perf-regression      性能退化（最近窗口 vs 上一窗口的性能均值）
 *   4. metric-drop          关键指标骤降（最近窗口 vs 上一窗口的非错误事件量）
 */
import { hash } from './db-adapter.js'
import { getErrorClusters, getReleaseList, getReleaseStats, getPerfWindow, getVolumeWindow } from './queries.js'

const HOUR = 3600 * 1000
const FINDING_TTL = 7 * 24 * HOUR // 同类 open 洞察去重窗口

// ---------------- 仓库 ----------------

export function createFindingsRepo(db) {
  async function insert(finding) {
    const id = finding.id || hash(`${finding.scope}:${finding.object}:${finding.created_at}`)
    const now = finding.created_at || Date.now()
    await db.prepare(
      `insert into ai_findings (id,scope,object,app_id,summary,evidence_json,detail_json,confidence,status,created_at,updated_at)
       values (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id, finding.scope, finding.object, finding.appId || null, finding.summary,
      JSON.stringify(finding.evidence || []), JSON.stringify(finding.detail || {}),
      finding.confidence ?? null, finding.status || 'open', now, now
    ).run()
    return id
  }

  /** 查找同类 open 洞察（去重：扫描已存在则不重复写入） */
  async function findOpen(scope, object, sinceTs) {
    const rows = await db.prepare(
      'select id from ai_findings where scope=? and object=? and status=? and created_at>=? limit 1'
    ).bind(scope, object, 'open', sinceTs).all()
    return rows?.[0]?.id || null
  }

  async function list({ appId, scope, status, limit = 50 } = {}) {
    const where = []
    const params = []
    if (appId) { where.push('app_id = ?'); params.push(appId) }
    if (scope) { where.push('scope = ?'); params.push(scope) }
    if (status) { where.push('status = ?'); params.push(status) }
    const sql = `select * from ai_findings${where.length ? ' where ' + where.join(' and ') : ''} order by created_at desc limit ?`
    const rows = await db.prepare(sql).bind(...params, limit).all()
    return (rows || []).map(row => ({
      id: row.id, scope: row.scope, object: row.object, appId: row.app_id,
      summary: row.summary, evidence: safeParse(row.evidence_json, []), detail: safeParse(row.detail_json, {}),
      confidence: row.confidence, status: row.status, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at || row.created_at)
    }))
  }

  async function get(id) {
    const row = await db.prepare('select * from ai_findings where id=?').bind(id).first()
    if (!row) return null
    return {
      id: row.id, scope: row.scope, object: row.object, appId: row.app_id,
      summary: row.summary, evidence: safeParse(row.evidence_json, []), detail: safeParse(row.detail_json, {}),
      confidence: row.confidence, status: row.status, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at || row.created_at)
    }
  }

  async function updateStatus(id, status) {
    await db.prepare('update ai_findings set status=?, updated_at=? where id=?').bind(status, Date.now(), id).run()
    return get(id)
  }

  return { insert, findOpen, list, get, updateStatus }
}

// ---------------- 检测器 ----------------

/** 1. 错误簇突增 */
export async function detectErrorClusters(db, { appId, sinceTs, minCount = 5, topN = 5 } = {}) {
  const clusters = await getErrorClusters(db, { appId, sinceTs, limit: topN })
  return clusters
    .filter(c => c.count >= minCount)
    .map(c => ({
      scope: 'error-cluster',
      object: c.name || 'Error',
      appId,
      summary: `错误簇「${c.name || 'Error'}」近 ${Math.round((Date.now() - sinceTs) / HOUR)}h 出现 ${c.count} 次（影响 ${c.affected} 用户）`,
      evidence: [`error:${c.name}`, `count:${c.count}`, `affected:${c.affected}`],
      detail: { name: c.name, message: String(c.message || '').slice(0, 300), count: c.count, affected: c.affected },
      confidence: Math.min(0.95, 0.5 + c.count / 200)
    }))
}

/** 2. 发布回归：最新版 vs 上一版 */
export async function detectReleaseRegressions(db, { appId } = {}) {
  const list = await getReleaseList(db, appId)
  if (list.length < 2) return []
  const cur = list[list.length - 1]
  const prev = list[list.length - 2]
  const [curStats, prevStats] = await Promise.all([
    getReleaseStats(db, cur.release_name, appId),
    getReleaseStats(db, prev.release_name, appId)
  ])
  if (!curStats || !prevStats || !prevStats.total) return []
  const errRateCur = curStats.errors / curStats.total
  const errRatePrev = prevStats.errors / prevStats.total
  const findings = []
  const errDelta = pctDelta(errRateCur, errRatePrev)
  if (errDelta != null && errDelta >= 20) {
    findings.push({
      scope: 'release-regression', object: cur.release_name, appId,
      summary: `发布 ${cur.release_name} 错误率 ${fmtPct(errRateCur)}，较上一版 ${prev.release_name}（${fmtPct(errRatePrev)}）上升 ${errDelta}%`,
      evidence: [`release:${cur.release_name}`, `release:${prev.release_name}`, `errRate:${fmtPct(errRateCur)}`],
      detail: { current: curStats, previous: prevStats, errorRateDelta: errDelta },
      confidence: Math.min(0.95, 0.6 + errDelta / 200)
    })
  }
  if (curStats.perfAvg != null && prevStats.perfAvg != null && prevStats.perfAvg > 0) {
    const perfDelta = pctDelta(curStats.perfAvg, prevStats.perfAvg)
    if (perfDelta != null && perfDelta >= 15) {
      findings.push({
        scope: 'release-regression', object: cur.release_name, appId,
        summary: `发布 ${cur.release_name} 性能均值 ${curStats.perfAvg}ms，较上一版（${prevStats.perfAvg}ms）退化 ${perfDelta}%`,
        evidence: [`release:${cur.release_name}`, `perfAvg:${curStats.perfAvg}`],
        detail: { current: curStats, previous: prevStats, perfDelta },
        confidence: Math.min(0.95, 0.6 + perfDelta / 200)
      })
    }
  }
  return findings
}

/** 3. 性能退化：最近窗口 vs 上一窗口 */
export async function detectPerfRegressions(db, { appId, windowMs = HOUR } = {}) {
  const now = Date.now()
  const cur = await getPerfWindow(db, { appId, fromTs: now - windowMs, toTs: now })
  const prev = await getPerfWindow(db, { appId, fromTs: now - 2 * windowMs, toTs: now - windowMs })
  if (!cur.count || !prev.count || prev.avg == null || prev.avg === 0) return []
  const delta = pctDelta(cur.avg, prev.avg)
  if (delta == null || delta < 30) return []
  return [{
    scope: 'perf-regression', object: `last-${Math.round(windowMs / HOUR)}h`, appId,
    summary: `最近 ${Math.round(windowMs / HOUR)}h 性能均值 ${cur.avg.toFixed(1)}ms，较上一窗口（${prev.avg.toFixed(1)}ms）退化 ${delta}%`,
    evidence: [`perfAvg:${cur.avg.toFixed(1)}`, `perfAvgPrev:${prev.avg.toFixed(1)}`, `samples:${cur.count}`],
    detail: { current: cur, previous: prev, delta },
    confidence: Math.min(0.9, 0.5 + delta / 200)
  }]
}

/** 4. 关键指标骤降（流量/转化代理）：最近窗口 vs 上一窗口 */
export async function detectMetricDrops(db, { appId, windowMs = HOUR, type } = {}) {
  const now = Date.now()
  const cur = await getVolumeWindow(db, { appId, fromTs: now - windowMs, toTs: now, type })
  const prev = await getVolumeWindow(db, { appId, fromTs: now - 2 * windowMs, toTs: now - windowMs, type })
  if (prev === 0) return []
  const delta = pctDelta(cur, prev)
  if (delta == null || delta > -40) return [] // 仅关注明显下降（delta 为负表示下降）
  return [{
    scope: 'metric-drop', object: type ? `type:${type}` : 'all-non-error', appId,
    summary: `最近 ${Math.round(windowMs / HOUR)}h 事件量 ${cur}，较上一窗口（${prev}）下降 ${Math.abs(delta)}%`,
    evidence: [`volume:${cur}`, `volumePrev:${prev}`, `drop:${Math.abs(delta)}%`],
    detail: { current: cur, previous: prev, delta },
    confidence: Math.min(0.85, 0.5 + Math.abs(delta) / 200)
  }]
}

// ---------------- 扫描编排 ----------------

/**
 * 运行全部检测器，去重后写入新洞察。
 * @returns {{ inserted: string[], skipped: number, scannedAt: number }}
 */
export async function runScan(db, { appId, sinceHours = 24 } = {}) {
  const repo = createFindingsRepo(db)
  const sinceTs = Date.now() - sinceHours * HOUR
  const candidates = [
    ...await detectErrorClusters(db, { appId, sinceTs }),
    ...await detectReleaseRegressions(db, { appId }),
    ...await detectPerfRegressions(db, { appId }),
    ...await detectMetricDrops(db, { appId })
  ]

  const inserted = []
  let skipped = 0
  for (const f of candidates) {
    const dup = await repo.findOpen(f.scope, f.object, Date.now() - FINDING_TTL)
    if (dup) { skipped++; continue }
    const id = await repo.insert(f)
    inserted.push(id)
  }
  return { inserted, skipped, scannedAt: Date.now() }
}

// ---------------- 工具 ----------------

function pctDelta(cur, prev) {
  if (prev == null || prev === 0 || cur == null) return null
  return Number((((cur - prev) / prev) * 100).toFixed(1))
}
function fmtPct(v) { return `${(Number(v) * 100).toFixed(2)}%` }
function safeParse(v, fallback) { try { return typeof v === 'string' ? JSON.parse(v) : v ?? fallback } catch { return fallback } }
