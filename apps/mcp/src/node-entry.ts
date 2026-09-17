import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { buildServer } from './server.js'
import type { McpConfig } from './lib/config.js'

export function parseBearerToken(auth: string | null): string | null {
  if (!auth) return null
  const m = /^bearer\s+(.+)$/i.exec(auth.trim())
  return m ? m[1].trim() : null
}

export function createMcpNodeHandler(options: {
  getBackendUrl: () => string
  verifyCollectKey: (collectKey: string) => Promise<{ appId: string; enabled: boolean } | null>
}) {
  return async function mcpExpressMiddleware(req: any, res: any, next: any) {
    // 1) CORS 预检处理
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
      res.setHeader('access-control-allow-headers', 'content-type, authorization, mcp-protocol-version, mcp-session-id')
      res.setHeader('access-control-max-age', '86400')
      return res.status(204).end()
    }

    // 2) 解析 Bearer 采集秘钥 (Collect Key)
    const authHeader = req.headers.authorization
    const bearer = parseBearerToken(authHeader)
    if (!bearer) {
      return res.status(401).json({ error: 'Unauthorized: missing bearer token (app collect key)' })
    }

    // 3) 校验采集秘钥并锁定 app_id
    let app: { appId: string; enabled: boolean } | null = null
    try {
      app = await options.verifyCollectKey(bearer)
    } catch (err: any) {
      return res.status(500).json({ error: `Verification error: ${err?.message || err}` })
    }

    if (!app) {
      return res.status(401).json({ error: 'Unauthorized: invalid collect key' })
    }
    if (!app.enabled) {
      return res.status(403).json({ error: 'Forbidden: application is disabled' })
    }

    // 4) 构造 MCP 配置（指向同源 REST 后端 API）
    const cfg: McpConfig = {
      dataSourceKind: 'rest',
      backendBaseUrl: options.getBackendUrl(),
      apiKey: bearer,
      defaultAppId: app.appId,
    }

    // 5) Express req 转化为 Web Standard Request
    const protocol = req.protocol || 'http'
    const host = req.get('host') || '127.0.0.1:8787'
    const fullUrl = new URL(req.originalUrl || req.url, `${protocol}://${host}`)

    const reqHeaders = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (v) {
        if (Array.isArray(v)) v.forEach((item) => reqHeaders.append(k, item))
        else reqHeaders.set(k, String(v))
      }
    }

    let requestBody: any = undefined
    if (!['GET', 'HEAD'].includes(req.method)) {
      requestBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {})
    }

    const webRequest = new Request(fullUrl.toString(), {
      method: req.method,
      headers: reqHeaders,
      body: requestBody,
    })

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })

    const server = buildServer(cfg)
    await server.connect(transport)

    try {
      const response = await transport.handleRequest(webRequest)
      res.status(response.status)
      response.headers.forEach((value, key) => {
        res.setHeader(key, value)
      })
      res.setHeader('access-control-allow-origin', '*')

      if (response.body) {
        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
        res.end()
      } else {
        res.end()
      }
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({ error: err?.message || 'MCP Error' })
      }
    } finally {
      await server.close().catch(() => {})
    }
  }
}
