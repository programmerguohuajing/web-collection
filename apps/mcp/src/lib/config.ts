import type { D1Database } from '@cloudflare/workers-types'

export interface McpEnv {
  BACKEND_BASE_URL?: string
  // 仅当 D1 解析失败时的兜底默认应用（正常鉴权流程由采集秘钥解析出 app_id 覆盖）
  MCP_APP_ID?: string
  // 数据源类型："rest"（默认，包装现有 /api/*）或 "d1"（直连本 worker 的 DB 绑定）
  MCP_DATASOURCE_KIND?: string
  DB?: D1Database
}

export interface McpConfig {
  backendBaseUrl: string
  // 请求级注入：来自调用方 Bearer 携带的采集秘钥（rest 模式透传为后端 x-app-key）。
  // 不来自部署密钥——部署 MCP 时不再需要任何 Actions Secrets。
  apiKey: string
  // 请求级注入：采集秘钥解析出的 app_id。数据源强制「锁定」此应用，忽略客户端传入的 appId。
  defaultAppId: string
  dataSourceKind: 'rest' | 'd1'
  db?: D1Database
}

export function getConfig(env: McpEnv): McpConfig {
  const backendBaseUrl = (env.BACKEND_BASE_URL || 'https://web-collection.jingguohua.cc.cd').replace(/\/+$/, '')
  return {
    backendBaseUrl,
    // apiKey / defaultAppId 由 index.ts 在鉴权后按请求注入，这里给空兜底值
    apiKey: '',
    defaultAppId: env.MCP_APP_ID || '',
    // 数据源类型：rest（包装现有 /api/*，默认）或 d1（直连 D1，需 DB 绑定）
    dataSourceKind: env.MCP_DATASOURCE_KIND === 'd1' ? 'd1' : 'rest',
    db: env.DB,
  }
}
