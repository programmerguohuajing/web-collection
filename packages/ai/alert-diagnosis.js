/**
 * @file 告警触发自动诊断（M5）
 *
 * 当产生 error/regression 告警时，异步触发一次 AI 诊断，并把诊断摘要写回
 * alert_history.context_json.diagnosis，供控制台与告警查看"为什么发生"。
 * 设计 §2.3：AI 诊断由独立 ai-worker 提供（绑定同一 D1），此处通过配置的
 * AI_WORKER_URL（ai-worker 的 URL）发起 HTTP 调用，隔离 LLM 故障不影响采集热路径。
 *
 * 关键：fire-and-forget + 静默降级——诊断失败 / 未配置 / 模型不可用都不阻塞告警主流程。
 */
export async function maybeAutoDiagnose({ env, db, alertId, appId, issueId, traceId, fetchFn = fetch }) {
  const workerUrl = env?.AI_WORKER_URL
  if (!workerUrl || !alertId) return null
  // 仅对 error/regression 告警触发（由调用方在 metric 判断）
  const body = { type: issueId ? 'error' : 'trace', issueId: issueId || undefined, traceId: traceId || undefined, appId }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number(env?.AI_DIAGNOSIS_TIMEOUT_MS || 8000))
    try {
      const res = await fetchFn(`${String(workerUrl).replace(/\/$/, '')}/api/ai/diagnose`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(env?.AI_API_KEY ? { 'x-ai-key': env.AI_API_KEY } : {})
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!res.ok) return { error: `diagnose http ${res.status}` }
      const diag = await res.json()
      // 回写 alert_history.context_json.diagnosis
      const row = await db.prepare('select context_json from alert_history where id=?').bind(alertId).first()
      const context = parseJson(row?.context_json, {})
      context.diagnosis = {
        summary: diag.summary || '',
        hypotheses: (diag.hypotheses || []).slice(0, 3).map(h => ({ cause: h.cause, confidence: h.confidence })),
        degraded: !!diag.degraded,
        refId: diag.refId || null,
        model: diag.model || null,
        at: Date.now()
      }
      await db.prepare('update alert_history set context_json=? where id=?').bind(JSON.stringify(context), alertId).run()
      return { ok: true, summary: context.diagnosis.summary }
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return { error: String(error?.message || error) }
  }
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}
