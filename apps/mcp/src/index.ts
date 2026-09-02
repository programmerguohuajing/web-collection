import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { buildServer } from './server.js'
import { getConfig, type McpEnv } from './lib/config.js'

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version, mcp-session-id',
}

export default {
  async fetch(request: Request, env: McpEnv, _ctx: unknown): Promise<Response> {
    const cfg = getConfig(env)

    // 1) CORS 预检必须先于鉴权返回：浏览器类 MCP 客户端的 OPTIONS 预检不带 Authorization，
    //    若先鉴权会被 401 挡死，导致后续真实请求无法发出。
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    // 2) MCP 端点自身鉴权（Bearer MCP_AUTH_TOKEN），避免采集数据裸暴露
    if (cfg.authToken) {
      const auth = request.headers.get('authorization')
      const token = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null
      if (token !== cfg.authToken) {
        return jsonError(401, 'Unauthorized')
      }
    }

    // 3) 仅暴露 /mcp 路径
    const url = new URL(request.url)
    if (url.pathname !== '/mcp') {
      return jsonError(404, 'Not Found. MCP endpoint is at /mcp')
    }

    // 4) 无状态模式：每次请求新建 transport + server（契合 Workers 冷启动，无 session 状态）
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    const server = buildServer(cfg)
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

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  })
}
