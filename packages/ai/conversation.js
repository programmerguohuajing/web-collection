/**
 * @file 对话式 AI 助手 · 会话仓库（P2 产品化）
 *
 * 多轮记忆落库 ai_conversations（0020 迁移）。messages 为完整 [{role, content}] 数组，
 * 由 diagnoser.ask 在调用模型前载入历史、调用后追加助手回复。
 */
import { hash } from './db-adapter.js'

export function createConversationStore(db) {
  async function create({ appId, title, messages }) {
    const id = hash(`conv:${Date.now()}:${Math.random()}`)
    const now = Date.now()
    await db.prepare(
      `insert into ai_conversations (id,app_id,title,messages_json,created_at,updated_at)
       values (?,?,?,?,?,?)`
    ).bind(id, appId || null, title || '', JSON.stringify(messages || []), now, now).run()
    return id
  }

  async function append(id, message) {
    const conv = await get(id)
    if (!conv) throw Object.assign(new Error('conversation 不存在'), { status: 404 })
    const messages = [...(conv.messages || []), message]
    await db.prepare('update ai_conversations set messages_json=?, updated_at=? where id=?')
      .bind(JSON.stringify(messages), Date.now(), id).run()
    return messages
  }

  async function get(id) {
    const row = await db.prepare('select * from ai_conversations where id=?').bind(id).first()
    if (!row) return null
    return {
      id: row.id, appId: row.app_id, title: row.title,
      messages: safeParse(row.messages_json, []),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at || row.created_at)
    }
  }

  async function list({ appId, limit = 30 } = {}) {
    const rows = appId
      ? await db.prepare('select * from ai_conversations where app_id=? order by updated_at desc limit ?').bind(appId, limit).all()
      : await db.prepare('select * from ai_conversations order by updated_at desc limit ?').bind(limit).all()
    return (rows || []).map(r => ({
      id: r.id, appId: r.app_id, title: r.title,
      messages: safeParse(r.messages_json, []),
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at || r.created_at)
    }))
  }

  return { create, append, get, list }
}

function safeParse(v, fallback) { try { return typeof v === 'string' ? JSON.parse(v) : v ?? fallback } catch { return fallback } }
