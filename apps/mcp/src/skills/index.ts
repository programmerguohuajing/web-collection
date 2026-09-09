import { SkillRegistry } from './registry.js'
import { healthWeeklyReportTemplate } from './templates/healthWeeklyReport.js'
import { incidentTriageTemplate } from './templates/incidentTriage.js'

export * from './types.js'
export * from './registry.js'
export * from './toolNames.js'
export * from './toolBridge.js'
export * from './runner.js'
export * from './schemaDoc.js'
export * from './support.js'

/**
 * 构建内置技能模板注册表。
 * 新增模板：实现 `SkillTemplate` 后在此处 `registry.register(...)` 即可，
 * 无需改动 MCP 工具层或 `DataSource`。
 */
export function createSkillRegistry(): SkillRegistry {
  const registry = new SkillRegistry()
  registry.register(healthWeeklyReportTemplate)
  registry.register(incidentTriageTemplate)
  return registry
}
