import { run } from '../db.js'
import { fingerprint } from '../utils/domain.js'
import { mapSentryIssue, mapSentryIssues } from '../../../../packages/sentry-import.js'

/**
 * Sentry issue 导入（C2 集成市场）。
 * 指纹对齐：使用与本栈采集事件完全相同的 fingerprint()（sha1(appId|name|source|stack8行)），
 * 使导入的 Sentry issue 与后续原生错误事件在同一指纹下合并去重。
 * PG issues 列名注意：版本列是 `release`（D1 侧为 release_name），此处仅服务 PG。
 */

/**
 * 批量导入 Sentry issues。
 * @param {{appId?: string, issues?: unknown[]}} body - { appId, issues: 数组或含 issues/items 键 }
 * @returns {Promise<{appId: string, imported: number, merged: number, skipped: number, results: Array<{fingerprint: string, action: string, name: string}>}>}
 */
export async function importSentryIssues(body = {}) {
  const appId = String(body.appId || '').trim()
  if (!appId) throw Object.assign(new Error('appId 必填'), { statusCode: 400 })
  const { mapped, skipped, invalid } = mapSentryIssues(body.issues)
  if (invalid) throw Object.assign(new Error(invalid), { statusCode: 400 })
  if (!mapped.length) return { appId, imported: 0, merged: 0, skipped, results: [] }

  const results = []
  let imported = 0
  let merged = 0
  for (const m of mapped) {
    // 复用采集侧指纹公式：props.source 参与 FetchError 家族判定
    const fp = fingerprint({ appId, name: m.name, message: m.message, stack: m.stack, props: { source: m.source } })
    const propsJson = JSON.stringify({ source: 'sentry', sentryIssueId: m.sentryIssueId || undefined, culprit: m.culprit || undefined })
    // 新增 open；命中已有指纹则只累加 count / 推进 last_seen，不改用户状态与既有 props
    const result = await run(
      `insert into issues (fingerprint, status, app_id, release, name, message, stack, url, props_json, count, first_seen, last_seen)
       values ($1, 'open', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (fingerprint) do update set
         count = issues.count + excluded.count,
         last_seen = greatest(issues.last_seen, excluded.last_seen)
       returning (xmax = 0) as inserted`,
      [fp, appId, m.release, m.name, m.message, m.stack, m.url, propsJson, m.count, m.firstSeen, m.lastSeen]
    )
    const wasInserted = result?.rows?.[0]?.inserted !== false
    if (wasInserted) imported++; else merged++
    results.push({ fingerprint: fp, action: wasInserted ? 'imported' : 'merged', name: m.name })
  }
  return { appId, imported, merged, skipped, results }
}

/** 单条预览（导入前校验映射效果，不入库） */
export function previewSentryIssue(entry = {}) {
  return mapSentryIssue(entry)
}
