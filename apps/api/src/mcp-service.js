/**
 * @file MCP (Model Context Protocol) 容器服务扩展模块
 * 在 Express 中挂载原生 /mcp 端点，使容器化/私有化部署的自托管实例
 * 也能直接支持 Claude Desktop、Cursor、Windsurf 等第三方 AI Agent 客户端连接。
 */

import { createHash } from 'node:crypto'
import { all } from './db.js'
import { createMcpNodeHandler } from '../../mcp/dist/index.js'

function hashKey(key) {
  return createHash('sha256').update(String(key || '')).digest('hex')
}

/**
 * 创建挂载在 Express /mcp 路由下的中间件处理函数
 * @param {object} options
 * @param {number|string} options.port
 * @returns {Function} Express 中间件
 */
export function createMcpRouter({ port = 8787 } = {}) {
  const handler = createMcpNodeHandler({
    getBackendUrl: () => process.env.BACKEND_BASE_URL || `http://127.0.0.1:${port}`,
    verifyCollectKey: async (collectKey) => {
      const key = String(collectKey || '').trim()
      if (!key) return null
      const keyHash = hashKey(key)

      // 1) 优先按 SHA-256(collectKey) 匹配 applications.collect_key_hash
      const rows = await all('select app_id, enabled, collect_key_hash from applications where collect_key_hash = ? limit 1', [keyHash])
      if (rows.length > 0) {
        return { appId: rows[0].app_id, enabled: rows[0].enabled !== false }
      }

      // 2) 容错兜底：若直接使用 app_id 作为 token（且该 app 未设置 collect_key_hash）
      const fallbackRows = await all('select app_id, enabled, collect_key_hash from applications where app_id = ? limit 1', [key])
      if (fallbackRows.length > 0) {
        const row = fallbackRows[0]
        if (!row.collect_key_hash) {
          return { appId: row.app_id, enabled: row.enabled !== false }
        }
      }

      return null
    }
  })

  return async (req, res, next) => {
    try {
      await handler(req, res, next)
    } catch (err) {
      next(err)
    }
  }
}
