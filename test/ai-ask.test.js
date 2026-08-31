import assert from 'node:assert/strict'
import test from 'node:test'
import { createDiagnoser } from '../packages/ai/diagnoser.js'

function memDb() {
  const convs = []
  const db = {
    convs,
    prepare(sql) {
      const stmt = {
        _v: null,
        bind(...v) { this._v = v; return this },
        async all() {
          if (sql.includes("type = 'error'") && sql.includes('group by name, message')) return []
          if (sql.includes("type = 'perf'")) return [{ cnt: 0, avgv: null }]
          if (sql.includes("type <> 'error'")) return [{ cnt: 0 }]
          if (sql.includes("from ai_conversations where app_id=")) return convs.filter(r => r.app_id === this._v[0]).sort((a, b) => b.updated_at - a.updated_at).slice(0, this._v[1] || 30)
          if (sql.includes('from ai_conversations order by')) return [...convs].sort((a, b) => b.updated_at - a.updated_at).slice(0, this._v[0] || 30)
          return []
        },
        async first() {
          if (sql.includes('from ai_conversations where id=')) return convs.find(r => r.id === this._v[0]) || null
          return null
        },
        async run() {
          if (sql.includes('insert into ai_conversations')) {
            const [id, appId, title, messages_json, created_at, updated_at] = this._v
            convs.push({ id, app_id: appId, title, messages_json, created_at, updated_at })
          } else if (sql.includes('update ai_conversations set messages_json')) {
            const [messages_json, updated_at, id] = this._v
            const r = convs.find(x => x.id === id)
            if (r) { r.messages_json = messages_json; r.updated_at = updated_at }
          }
          return { changes: 1 }
        }
      }
      return stmt
    }
  }
  return db
}

test('ask：自然语言问题 → 聚合上下文 + 多轮会话落库', async () => {
  const db = memDb()
  let routeCalls = 0
  const gateway = { route: async () => { routeCalls++; return { model: 'm', provider: 'p', content: 'iOS 转化下降 12%，建议检查支付链路。' } } }
  const diagnoser = createDiagnoser({ db, gateway, kb: { search: async () => [] }, embedder: {} })

  const res = await diagnoser.ask({ question: '为什么今天 iOS 支付转化率掉了？', appId: 'a' })
  assert.equal(routeCalls, 1)
  assert.ok(res.answer.includes('iOS'))
  assert.ok(res.conversationId)
  assert.equal(res.messages.length, 2)
  assert.equal(res.messages[0].role, 'user')
  assert.equal(res.messages[1].role, 'assistant')

  // 多轮：带 conversationId 追问，历史应被载入
  let capturedUser = ''
  const gateway2 = { route: async (sys, user) => { capturedUser = user; return { model: 'm', provider: 'p', content: '进一步分析...' } } }
  const d2 = createDiagnoser({ db, gateway: gateway2, kb: { search: async () => [] }, embedder: {} })
  await d2.ask({ question: '看下具体哪个步骤流失最多', appId: 'a', conversationId: res.conversationId })
  assert.ok(capturedUser.includes('对话历史'), '应把历史注入 prompt')
})
