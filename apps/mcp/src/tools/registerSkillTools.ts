import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { DataSource } from '../datasource/index.js'
import type { SkillRegistry, SkillSummary } from '../skills/index.js'
import { runSkillById } from '../skills/runner.js'

function toResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  }
}

/**
 * 注册「技能模板」相关 MCP 工具：
 * - `list_skill_templates`：能力发现（第三方 Agent 枚举可用模板、入参与输出结构）。
 * - `run_skill_template`：按模板 id 执行一组既有工具编排，返回结构化结果（含 structuredContent 便于回流）。
 *
 * 选用「新增 MCP 工具」而非「新增 HTTP 端点」的理由：
 * 1) MCP 客户端经 tools/list 即可发现模板，无需额外路由/鉴权/CORS 适配；
 * 2) 复用现有 Bearer MCP_AUTH_TOKEN 鉴权与无状态传输，改动面最小、不引入新的攻击面；
 * 3) 结果天然落在 MCP 协议内，任何 MCP 客户端都能消费，契合「可被第三方 Agent 调用」目标。
 */
export function registerSkillTools(server: McpServer, ds: DataSource, registry: SkillRegistry): void {
  server.registerTool(
    'list_skill_templates',
    {
      title: '列出技能模板',
      description: '枚举可用的技能模板（Agent 诊断/报告编排）。可传 id 查看某个模板的入参、输出结构与调度建议。',
      inputSchema: {
        id: z.string().optional().describe('模板 id；省略则返回全部模板摘要'),
        detail: z.boolean().optional().default(false).describe('为 true 时附带输出字段说明与输入字段类型'),
      },
    },
    async (args) => {
      if (args.id) {
        const summary = registry.summarize(args.id)
        if (!summary) return noSuchTemplate(args.id, registry)
        return toResult(serializeSummary(summary, args.detail === true))
      }
      const all = registry.summarizeAll().map((item) => serializeSummary(item, args.detail === true))
      return toResult({ count: all.length, templates: all })
    },
  )

  server.registerTool(
    'run_skill_template',
    {
      title: '执行技能模板',
      description: '按模板 id 执行一组既有工具编排，产出结构化结论（含健康分/工单草案等）。模板不会触达任何既有 MCP 工具之外的数据出口。',
      inputSchema: {
        templateId: z.string().min(1).describe('技能模板 id，见 list_skill_templates'),
        arguments: z.record(z.unknown()).optional().describe('模板入参（与应用/时间窗口/关键词等）'),
      },
    },
    async (args) => {
      const result = await runSkillById(registry, ds, args.templateId, args.arguments as Record<string, unknown> | undefined)
      const failed = result.status === 'failed'
      return {
        ...toResult(result),
        isError: failed,
        structuredContent: result as unknown as Record<string, unknown>,
      }
    },
  )
}

function serializeSummary(summary: SkillSummary, detail: boolean) {
  const base = {
    id: summary!.id,
    title: summary!.title,
    version: summary!.version,
    description: summary!.description,
    category: summary!.category,
    tags: summary!.tags,
    schedule: summary!.scheduleHint,
  }
  return detail
    ? { ...base, inputFields: summary!.inputFields, outputFields: summary!.outputFields }
    : base
}

function noSuchTemplate(id: string, registry: SkillRegistry) {
  return {
    ...toResult({
      error: `未找到技能模板 "${id}"`,
      available: registry.list().map((item) => item.id),
    }),
    isError: true,
  }
}
