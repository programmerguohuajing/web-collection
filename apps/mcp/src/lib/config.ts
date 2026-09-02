import type { D1Database } from '@cloudflare/workers-types'

export interface McpEnv {
  BACKEND_BASE_URL?: string
  MCP_API_KEY?: string
  MCP_AUTH_TOKEN?: string
  MCP_APP_ID?: string
  MCP_DATASOURCE_KIND?: string
  DB?: D1Database
}

export interface McpConfig {
  backendBaseUrl: string
  apiKey: string
  authToken: string
  defaultAppId: string
  dataSourceKind: 'rest' | 'd1'
  db?: D1Database
}

export function getConfig(env: McpEnv): McpConfig {
  const backendBaseUrl = (env.BACKEND_BASE_URL || 'https://web-collection.jingguohua.cc.cd').replace(/\/+$/, '')
  return {
    backendBaseUrl,
    // MCP_API_KEY 作为调用后端 /api/* 的 x-app-key 鉴权凭据（即现有 appKey / collectKey）
    apiKey: env.MCP_API_KEY || '',
    // MCP_AUTH_TOKEN 用于保护本 MCP 端点本身（Bearer 鉴权）
    authToken: env.MCP_AUTH_TOKEN || '',
    defaultAppId: env.MCP_APP_ID || 'default',
    // 数据源类型：rest（包装现有 /api/*，默认）或 d1（直连 D1，需 DB 绑定）
    dataSourceKind: env.MCP_DATASOURCE_KIND === 'd1' ? 'd1' : 'rest',
    db: env.DB,
  }
}
