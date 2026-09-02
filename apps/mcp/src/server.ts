import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTools } from './tools/registerTools.js'
import { createDataSource } from './datasource/index.js'
import type { McpConfig } from './lib/config.js'

export function buildServer(cfg: McpConfig): McpServer {
  const ds = createDataSource({
    kind: cfg.dataSourceKind,
    baseUrl: cfg.backendBaseUrl,
    apiKey: cfg.apiKey,
    db: cfg.db,
    defaultAppId: cfg.defaultAppId,
  })
  const server = new McpServer({
    name: 'web-collection-mcp',
    version: '0.1.0',
  })
  registerTools(server, ds)
  return server
}
