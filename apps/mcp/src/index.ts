import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { buildServer } from './server.js'
import { getConfig, type McpConfig, type McpEnv } from './lib/config.js'
import type { D1Database } from '@cloudflare/workers-types'

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version, mcp-session-id',
}

export default {
  async fetch(request: Request, env: McpEnv, _ctx: unknown): Promise<Response> {
    const cfg = getConfig(env)

    // 1) CORS 预检必须先于一切返回：浏览器类 MCP 客户端的 OPTIONS 预检不带 Authorization，
    //    若先鉴权会被 401 挡死，导致后续真实请求无法发出。
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    // 2) 先校验路径，仅 /mcp 为 MCP 端点；未知路径直接 404，
    //    避免把鉴权 gate 暴露在非端点路径上（也避免无 token 请求误报 401）。
    const url = new URL(request.url)
    if (url.pathname !== '/mcp') {
      return jsonError(404, 'Not Found. MCP endpoint is at /mcp')
    }

    // 3) 调用时采集秘钥鉴权（call-time collect key）：
    //    客户端在 Authorization: Bearer 中携带目标应用的采集秘钥（collectKey）。
    //    MCP 服务端用同一个生产 D1 库校验 sha256(collectKey) == applications.collect_key_hash，
    //    解析出 app_id 并「锁定」：本次请求及数据源只能访问该应用数据。
    //    天然多应用隔离，且凭证与 SDK 写入同源——部署 MCP 时不再需要任何密钥 / Actions Secrets。
    const bearer = parseBearerToken(request.headers.get('authorization'))
    if (!bearer) {
      return jsonError(401, 'Unauthorized: missing bearer token (app collect key)')
    }

    // 解析并锁定 app_id。D1 绑定缺失时无法锁定隔离，直接拒绝，避免跨应用泄漏。
    if (!cfg.db) {
      return jsonError(503, 'Service Unavailable: MCP requires D1 binding to resolve app')
    }
    const keyHash = await sha256Hex(bearer)
    const app = await cfg.db
      .prepare('SELECT app_id, enabled FROM applications WHERE collect_key_hash = ? LIMIT 1')
      .bind(keyHash)
      .first<{ app_id: string; enabled: number }>()
    if (!app) {
      return jsonError(401, 'Unauthorized: invalid collect key')
    }
    if (!app.enabled) {
      return jsonError(403, 'Forbidden: application is disabled')
    }
    // 请求级作用域：数据源强制只访问解析出的 app_id（忽略客户端传入的 appId）。
    const scopedCfg: McpConfig = { ...cfg, apiKey: bearer, defaultAppId: app.app_id }

    // 4) 无状态模式：每次请求新建 transport + server（契合 Workers 冷启动，无 session 状态）
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    const server = buildServer(scopedCfg)
    await server.connect(transport)

    let response: Response
    try {
      response = await transport.handleRequest(request)
    } finally {
      // 请求结束即关闭 server，避免 Workers 实例资源泄漏
      await server.close().catch(() => {})
    }

    const headers = new Headers(response.headers)
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v)
    return new Response(response.body, { status: response.status, headers })
  },
}

// 安全解析 Bearer token：缺头 / 非 Bearer 方案 / 大小写不敏感方案均返回 null（不抛异常）。
// 此前用 `auth?.toLowerCase().startsWith('bearer ')` 在 auth 为 null 时会因
// `undefined.startsWith` 抛 TypeError，导致无 Authorization 头的请求 500 而非 401。
function parseBearerToken(auth: string | null): string | null {
  if (!auth) return null
  const m = /^bearer\s+(.+)$/i.exec(auth.trim())
  return m ? m[1].trim() : null
}

// sha256 十六进制摘要（与 cloudflare/worker.js 中采集秘钥的存储方式一致：
// applications.collect_key_hash = sha256(collectKey)）。
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  })
}
