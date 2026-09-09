import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTools } from './tools/registerTools.js'
import { registerSkillTools } from './tools/registerSkillTools.js'
import { createDataSource } from './datasource/index.js'
import { createSkillRegistry } from './skills/index.js'
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
  // 既有 12 个工具：行为完全不变。
  registerTools(server, ds)
  // C3 技能模板库：注册 list_skill_templates / run_skill_template 两个 MCP 工具，
  // 通过既有工具编排对外暴露「诊断/报告」能力，供第三方 Agent 调用。
  registerSkillTools(server, ds, createSkillRegistry())
  return server
}
