import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationStore } from '../packages/ai/conversation.js'

function memDb() {
  const convs = []
  let seq = 0 // 单调递增序号，保证排序确定性（规避 Date.now() 同毫秒问题）
  return {
    convs,
    prepare(sql) {
      const stmt = {
        _v: null,
        bind(...v) { this._v = v; return this },
        async all() {
          if (sql.includes("from ai_conversations where app_id=")) {
            return convs.filter(r => r.app_id === this._v[0]).sort((a, b) => b.updated_at - a.updated_at).slice(0, this._v[1] || 30)
          }
          if (sql.includes('from ai_conversations order by')) {
            return [...convs].sort((a, b) => b.updated_at - a.updated_at).slice(0, this._v[0] || 30)
          }
          return []
        },
        async first() {
          if (sql.includes('where id=')) return convs.find(r => r.id === this._v[0]) || null
          return null
        },
        async run() {
          if (sql.includes('insert into ai_conversations')) {
            const [id, appId, title, messages_json] = this._v
            const t = ++seq
            convs.push({ id, app_id: appId, title, messages_json, created_at: t, updated_at: t })
          } else if (sql.includes('update ai_conversations set messages_json')) {
            const [messages_json, , id] = this._v
            const r = convs.find(x => x.id === id)
            if (r) { r.messages_json = messages_json; r.updated_at = ++seq }
          }
          return { changes: 1 }
        }
      }
      return stmt
    }
  }
}

test('conversation 创建 + 追加多轮 + 读取', async () => {
  const db = memDb()
  const store = createConversationStore(db)
  const id = await store.create({ appId: 'a', title: '为何转化下降', messages: [{ role: 'user', content: '为何转化下降' }, { role: 'assistant', content: '可能因...' }] })
  await store.append(id, { role: 'user', content: '看下 iOS' })
  await store.append(id, { role: 'assistant', content: 'iOS 转化下降 12%' })
  const conv = await store.get(id)
  assert.equal(conv.messages.length, 4)
  assert.equal(conv.messages[0].role, 'user')
  assert.equal(conv.messages[3].content, 'iOS 转化下降 12%')
})

test('conversation list 按 updated_at 倒序', async () => {
  const db = memDb()
  const store = createConversationStore(db)
  const a = await store.create({ appId: 'a', title: 'A', messages: [] })
  const b = await store.create({ appId: 'a', title: 'B', messages: [] })
  await store.append(b, { role: 'user', content: 'x' }) // 更新 b 的 updated_at
  const items = await store.list({ appId: 'a' })
  assert.equal(items.length, 2)
  assert.equal(items[0].id, b) // b 最近更新，排前面
})
