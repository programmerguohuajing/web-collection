/**
 * @file Prompt 模板（强制结构化 JSON 输出）
 */

export const SYSTEM_PROMPT = `你是资深前端 SRE / 可观测性工程师。基于给定的分布式 trace、错误事件和知识库片段，做根因诊断。
严格只输出一个 JSON 对象，不要输出任何解释或 Markdown。JSON 结构：
{
  "summary": "一句话根因（≤50 字）",
  "hypotheses": [
    { "cause": "假设根因", "confidence": 0.0-1.0, "evidence": ["span:ID", "event:EVENT_ID", "kb:SOURCE_ID"] }
  ],
  "suggestions": [
    { "action": "建议动作", "codeRef": "file:line", "kbLink": "SOURCE_ID" }
  ],
  "relatedKb": [ { "title": "知识标题", "source": "issue|runbook|doc", "score": 0.0-1.0 } ]
}
若证据不足以定位，hypotheses 的 confidence 必须低（<0.4），并在 summary 说明"缺少证据"。
只基于提供的信息，不要编造事实。`

export function buildUserPrompt({ kind, trace, errorEvents, issue, similarIssues, kbResults }) {
  const sections = [`请诊断以下 ${kind === 'trace' ? '分布式链路' : '错误'}。`]
  if (trace) {
    sections.push('## 分布式链路')
    sections.push(JSON.stringify({
      root: trace.root,
      errorSpans: trace.errorSpans,
      criticalPath: trace.criticalPath,
      nodes: (trace.nodes || []).slice(0, 30)
    }, null, 1))
  }
  if (errorEvents?.length) {
    sections.push('## 错误事件')
    sections.push(JSON.stringify(errorEvents.slice(0, 10).map(e => ({
      id: e.id, name: e.name, message: e.message?.slice(0, 300), stack: e.stack?.slice(0, 1000),
      url: e.url, path: e.path
    })), null, 1))
  }
  if (issue) {
    sections.push('## 当前 issue')
    sections.push(JSON.stringify({
      fingerprint: issue.fingerprint, name: issue.name, message: issue.message,
      stack: issue.stack?.slice(0, 1200), url: issue.url, count: issue.count,
      resolutionNotes: issue.resolutionNotes || null
    }, null, 1))
  }
  if (similarIssues?.length) {
    sections.push('## 相似历史 issue')
    sections.push(JSON.stringify(similarIssues.map(i => ({ name: i.name, message: i.message?.slice(0, 200), count: i.count, status: i.status })), null, 1))
  }
  if (kbResults?.length) {
    sections.push('## 知识库片段（已检索到的相似解法，可引用为 evidence kb:...）')
    sections.push(JSON.stringify(kbResults.map(k => ({ source: k.source_type, id: k.id, title: k.metadata?.title || k.source_id, score: k.score, text: String(k.text).slice(0, 800) })), null, 1))
  }
  return sections.join('\n\n')
}
