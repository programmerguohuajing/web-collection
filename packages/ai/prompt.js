/**
 * @file Prompt 模板（强制结构化 JSON 输出，scope 感知）
 *
 * P0 产品化改造：去掉「只分析错误」的限定，支持 trace / perf / session / release / ask
 * 多类诊断对象的上下文组装。模型仍被强制「证据不足时低 confidence」。
 */

export const SYSTEM_PROMPT = `你是资深前端 SRE / 可观测性工程师。基于给定的遥测数据（分布式链路 trace、性能链路、用户会话 session、版本发布 release 等）做根因诊断或洞察。
严格只输出一个 JSON 对象，不要输出任何解释或 Markdown。JSON 结构：
{
  "summary": "一句话结论（≤50 字）",
  "hypotheses": [
    { "cause": "假设根因", "confidence": 0.0-1.0, "evidence": ["span:ID", "event:EVENT_ID", "session:ID", "release:NAME", "kb:SOURCE_ID"] }
  ],
  "suggestions": [
    { "action": "建议动作", "codeRef": "file:line", "kbLink": "SOURCE_ID" }
  ],
  "relatedKb": [ { "title": "知识标题", "source": "issue|runbook|doc", "score": 0.0-1.0 } ]
}
若证据不足以定位，hypotheses 的 confidence 必须低（<0.4），并在 summary 说明"缺少证据"。
只基于提供的信息，不要编造事实。`

/** P2 对话式助手系统提示：自然语言问答，给定自动聚合的上下文 */
export const ASK_SYSTEM_PROMPT = `你是前端遥测平台的 AI 助手。用户会用自然语言提问（如"为什么今天 iOS 支付转化率掉了""上周三的崩溃高峰是什么"）。
你会收到一份「可观测上下文（自动聚合）」与「知识库片段」，请基于这些真实数据回答，给出有证据支撑的结论。
要求：
- 不要编造数据；数据不足时明确说明"当前数据不足"。
- 回答简洁（≤200 字），必要时用条目列出关键发现。
- 若问题与错误/性能/发布相关，给出可操作的排查建议。`

const SCOPE_LABEL = {
  trace: '分布式链路',
  perf: '性能链路',
  session: '用户会话',
  release: '版本发布',
  ask: '自然语言问题'
}

export function buildUserPrompt({ scope = 'trace', trace, perfContext, errorEvents, sessionContext, releaseContext, issue, similarIssues, kbResults }) {
  const scopeLabel = SCOPE_LABEL[scope] || '遥测数据'
  const sections = [`请诊断以下${scopeLabel}：`]

  if (trace) {
    sections.push('## 分布式链路')
    sections.push(JSON.stringify({
      root: trace.root,
      errorSpans: trace.errorSpans,
      criticalPath: trace.criticalPath,
      nodes: (trace.nodes || []).slice(0, 30)
    }, null, 1))
    if (perfContext?.slowNodes?.length) {
      sections.push('## 性能热点（慢节点，按耗时降序）')
      sections.push(JSON.stringify(perfContext.slowNodes, null, 1))
    }
  }

  if (sessionContext) {
    sections.push('## 会话聚合')
    sections.push(JSON.stringify(sessionContext, null, 1))
  }

  if (releaseContext) {
    sections.push('## 版本发布对比')
    sections.push(JSON.stringify(releaseContext, null, 1))
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
