import type { ZodRawShape } from 'zod'
import type { ListParams } from '../datasource/index.js'
import type { ToolName } from './toolNames.js'

/** 步骤执行状态：ok 成功 / failed 失败 / skipped 因前序步骤失败未执行。 */
export type StepStatus = 'ok' | 'failed' | 'skipped'

/** 模板整体执行状态：ok 全部成功 / partial 可选步骤失败但已出结论 / failed 未产出结论。 */
export type RunStatus = 'ok' | 'partial' | 'failed'

/**
 * 单个步骤的入参计算上下文。
 * `steps` 按执行顺序累积，允许后续步骤引用前序结果（例如用 issue 的 traceId 查链路）。
 */
export interface SkillStepContext {
  /** 已通过模板 inputSchema 校验的入参。 */
  readonly input: Record<string, unknown>
  /** 已执行步骤的产物；未执行或失败的步骤不在其中。 */
  readonly steps: Readonly<Record<string, unknown>>
  /** 本次运行的基准时间戳(ms)，便于模板做「最近 7 天」之类的相对时间推算，且可测试。 */
  readonly now: number
}

/** 单个步骤的执行轨迹，随结果一并返回，便于第三方 Agent 溯源与审计。 */
export interface StepTrace {
  readonly id: string
  readonly tool: ToolName
  readonly title: string
  readonly status: StepStatus
  readonly durationMs: number
  readonly params: ListParams
  readonly error?: string
}

/** 模板声明的一个编排步骤：调用哪个既有工具、传什么参数。 */
export interface SkillStep {
  /** 步骤唯一 id，供后续步骤引用与结果溯源。 */
  readonly id: string
  /** 要调用的既有 MCP 工具名。 */
  readonly tool: ToolName
  /** 步骤的人类可读说明。 */
  readonly title: string
  /**
   * 由上下文推导出该工具调用的入参（即 `ListParams` 子集）。
   * 必须是纯函数：同样的上下文产出同样的参数，保证模板可重放、可缓存。
   */
  readonly params: (ctx: SkillStepContext) => ListParams
  /**
   * 是否可容忍失败。true：步骤失败仅降级（记录 warning），不阻断整体结论；
   * false（默认）：步骤失败即中止整个模板执行。
   */
  readonly optional?: boolean
}

/** 结论合成阶段的上下文。 */
export interface SkillSynthesizeContext {
  /** 已校验的入参。 */
  readonly input: Record<string, unknown>
  /** 成功步骤的产物（key 为步骤 id）。 */
  readonly steps: Readonly<Record<string, unknown>>
  /** 本次运行的基准时间戳(ms)。 */
  readonly now: number
  /** 数据源类型（rest / d1），随结果透出，便于结果消费方识别数据口径。 */
  readonly dataSourceKind: string
}

/**
 * 定时任务编排的声明式占位（本期**不实现**调度，仅给出建议节奏）。
 * 真实调度需要外部触发器（Cloudflare Cron Triggers / QStash / 客户侧 cron）调用
 * `run_skill_template`；此处只负责把「建议频率 + 下一次窗口」算好交给调用方。
 */
export interface SkillScheduleHint {
  /** 建议的 cron 表达式（5 段，UTC）。 */
  readonly cron?: string
  /** 建议的执行间隔的人类可读描述。 */
  readonly interval: string
  /** 默认的回看窗口长度(ms)，用于未显式传时间范围时的兜底。 */
  readonly defaultWindowMs: number
}

/**
 * 工单回流的标准化占位结构（本期**不实现**真实建单）。
 * 字段与具体工单系统（Jira / 飞书 / GitHub Issues）解耦，后续接入方只需做一次字段映射。
 */
export interface TicketDraft {
  /** 工单标题（已脱敏、单行）。 */
  readonly title: string
  /** 严重级别：P0 阻断 / P1 严重 / P2 一般 / P3 轻微。 */
  readonly severity: 'P0' | 'P1' | 'P2' | 'P3'
  /** 结构化摘要，供工单正文渲染。 */
  readonly summary: string
  /** 去重键（指纹/聚合键），避免重复建单。 */
  readonly dedupeKey: string
  /** 建议标签。 */
  readonly labels: readonly string[]
  /** 证据清单（URL / traceId / 会话等，均为既有数据，不含 PII 新增字段）。 */
  readonly evidence: readonly Record<string, unknown>[]
  /** 负责方建议（当前仅按数据来源给出团队维度提示，无人员 PII）。 */
  readonly suggestedOwner?: string
}

/** 模板对外声明的输出结构说明（用于能力发现，非运行时强校验）。 */
export interface SkillOutputContract {
  /** 输出结构的一句话说明。 */
  readonly description: string
  /** 顶层字段说明：字段名 -> 说明。 */
  readonly fields: Readonly<Record<string, string>>
}

/**
 * 技能模板：一组既有工具调用的编排 + 入参声明 + 输出结构 + 结论合成函数。
 * 模板本身不触达数据，只描述「怎么调、怎么收敛」，数据一律经 `DataSource`。
 */
export interface SkillTemplate {
  /** 模板唯一 id（第三方 Agent 调用时用），建议小写下划线。 */
  readonly id: string
  /** 模板显示名。 */
  readonly title: string
  /** 语义化版本，输出结论会带上，便于下游做缓存/兼容判断。 */
  readonly version: string
  /** 模板用途说明（会进入 MCP 工具描述，面向 Agent）。 */
  readonly description: string
  /** 分类：report 周期性报告 / triage 故障定级 / diagnosis 通用诊断。 */
  readonly category: 'report' | 'triage' | 'diagnosis'
  /** 检索标签。 */
  readonly tags: readonly string[]
  /** 入参声明，与 `McpServer.registerTool` 的 inputSchema 同构（zod raw shape）。 */
  readonly inputSchema: ZodRawShape
  /** 输出结构声明。 */
  readonly outputContract: SkillOutputContract
  /** 编排步骤（顺序执行）。 */
  readonly steps: readonly SkillStep[]
  /** 定时调度建议（占位，不实现调度）。 */
  readonly scheduleHint?: SkillScheduleHint
  /** 结论合成：把各步骤产物收敛为结构化结论。 */
  synthesize(ctx: SkillSynthesizeContext): unknown
}

/** 模板执行结果：结构化、可序列化，便于回流工单或再加工。 */
export interface SkillRunResult {
  readonly templateId: string
  readonly templateVersion: string
  readonly title: string
  readonly status: RunStatus
  /** 结论生成时间戳(ms)。 */
  readonly generatedAt: number
  /** 整个模板执行耗时(ms)。 */
  readonly durationMs: number
  /** 数据源类型（rest / d1）。 */
  readonly dataSourceKind: string
  /** 实际生效的入参（已填默认值）。 */
  readonly input: Record<string, unknown>
  /** 步骤执行轨迹。 */
  readonly steps: readonly StepTrace[]
  /** 模板产出的结构化结论；失败时为 null。 */
  readonly result: unknown
  /** 降级/告警信息（如可选步骤失败）。 */
  readonly warnings: readonly string[]
  /** 失败原因；成功时为 undefined。 */
  readonly error?: string
  /** 定时调度占位：建议的下一次执行窗口（起点为本窗口结束时间）。 */
  readonly nextRun?: { readonly startTime: number; readonly endTime: number; readonly cron?: string }
}
