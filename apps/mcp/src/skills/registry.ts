import type { SkillTemplate } from './types.js'
import { isToolName } from './toolNames.js'
import { describeInputSchema, type InputFieldDoc } from './schemaDoc.js'

/** 面向第三方 Agent 的能力摘要（不含任何执行逻辑/私密信息）。 */
export interface SkillSummary {
  readonly id: string
  readonly title: string
  readonly version: string
  readonly description: string
  readonly category: 'report' | 'triage' | 'diagnosis'
  readonly tags: readonly string[]
  readonly inputFields: readonly InputFieldDoc[]
  readonly outputFields: Readonly<Record<string, string>>
  readonly scheduleHint?: { readonly interval: string; readonly cron?: string }
}

/**
 * 技能模板注册表：单例式收集内置模板，供 MCP 工具做「能力发现」与「按 id 执行」。
 * 注册时会静态校验：id 不重复、每个步骤引用的工具名都是既有 MCP 工具，
 * 从而保证模板不会在运行期触达不存在的数据出口。
 */
export class SkillRegistry {
  private readonly templates = new Map<string, SkillTemplate>()

  register(template: SkillTemplate): this {
    if (this.templates.has(template.id)) {
      throw new Error(`Skill template "${template.id}" already registered`)
    }
    for (const step of template.steps) {
      if (!isToolName(step.tool)) {
        throw new Error(`Skill "${template.id}" step "${step.id}" references unknown tool "${step.tool}"`)
      }
    }
    this.templates.set(template.id, template)
    return this
  }

  has(id: string): boolean {
    return this.templates.has(id)
  }

  get(id: string): SkillTemplate | undefined {
    return this.templates.get(id)
  }

  list(): SkillTemplate[] {
    return [...this.templates.values()]
  }

  summarize(id: string): SkillSummary | undefined {
    const template = this.templates.get(id)
    return template ? summarize(template) : undefined
  }

  summarizeAll(): SkillSummary[] {
    return this.list().map(summarize)
  }
}

function summarize(template: SkillTemplate): SkillSummary {
  return {
    id: template.id,
    title: template.title,
    version: template.version,
    description: template.description,
    category: template.category,
    tags: template.tags,
    inputFields: describeInputSchema(template.inputSchema),
    outputFields: template.outputContract.fields,
    ...(template.scheduleHint
      ? { scheduleHint: { interval: template.scheduleHint.interval, ...(template.scheduleHint.cron ? { cron: template.scheduleHint.cron } : {}) } }
      : {}),
  }
}
