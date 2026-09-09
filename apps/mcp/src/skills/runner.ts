import { z } from 'zod'
import type { DataSource, ListParams } from '../datasource/index.js'
import type { SkillRegistry } from './registry.js'
import { TOOL_INVOKERS } from './toolBridge.js'
import type { SkillRunResult, SkillTemplate, StepTrace } from './types.js'

/** 运行选项。`now` 可注入，便于测试与「按固定基准时间重放」。 */
export interface RunSkillOptions {
  readonly now?: number
}

/** 归一化后的时间窗口。 */
export interface TimeWindow {
  readonly startTime: number
  readonly endTime: number
}

const ONE_HOUR_MS = 60 * 60 * 1000

/**
 * 推导模板实际生效的时间窗口：
 * - 显式传入 startTime/endTime：尊重调用方；
 * - 只传其一：按 defaultWindowMs 补齐另一端；
 * - 都不传：以 `now` 为结束时间，回看 defaultWindowMs。
 * 非数字/非法值一律忽略（视为未传），避免把脏参数透传给后端 SQL。
 */
export function resolveTimeWindow(
  input: Record<string, unknown>,
  now: number,
  defaultWindowMs: number,
): TimeWindow {
  const rawStart = toTimestamp(input.startTime)
  const rawEnd = toTimestamp(input.endTime)
  const window = defaultWindowMs > 0 ? defaultWindowMs : ONE_HOUR_MS
  let endTime = rawEnd ?? now
  let startTime = rawStart ?? endTime - window
  if (rawStart !== null && rawEnd === null) endTime = rawStart + window
  if (startTime > endTime) {
    const swap = startTime
    startTime = endTime
    endTime = swap
  }
  return { startTime, endTime }
}

function toTimestamp(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 执行一个技能模板：校验入参 → 顺序执行编排步骤 → 合成结构化结论。
 *
 * 设计要点：
 * - 必选步骤失败即中止（status='failed'），绝不产出半截结论误导调用方；
 * - 可选步骤失败只降级（status='partial' + warnings），保证报告类模板在部分数据源异常时仍可用；
 * - 全程不抛异常：错误以结构化字段返回，方便第三方 Agent 直接消费。
 */
export async function runSkillTemplate(
  ds: DataSource,
  template: SkillTemplate,
  rawInput: Record<string, unknown> | undefined,
  options: RunSkillOptions = {},
): Promise<SkillRunResult> {
  const now = options.now ?? Date.now()
  const startedAt = Date.now()
  const warnings: string[] = []

  const parsed = z.object(template.inputSchema).safeParse(rawInput ?? {})
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    return baseResult(template, now, 0, {}, [], `入参校验失败：${detail}`, [], ds.kind)
  }
  const input = parsed.data as Record<string, unknown>

  const stepData: Record<string, unknown> = {}
  const traces: StepTrace[] = []
  let fatalError: string | undefined
  let failedIndex = -1

  for (let i = 0; i < template.steps.length; i += 1) {
    const step = template.steps[i]
    const stepStartedAt = Date.now()
    let params: ListParams = {}
    try {
      params = normalizeParams(step.params({ input, steps: stepData, now }))
      const data = await TOOL_INVOKERS[step.tool](ds, params)
      stepData[step.id] = data
      traces.push({
        id: step.id,
        tool: step.tool,
        title: step.title,
        status: 'ok',
        durationMs: Date.now() - stepStartedAt,
        params,
      })
      continue
    } catch (err) {
      const message = errorMessageOf(err)
      traces.push({
        id: step.id,
        tool: step.tool,
        title: step.title,
        status: 'failed',
        durationMs: Date.now() - stepStartedAt,
        params,
        error: message,
      })
      if (step.optional === true) {
        warnings.push(`可选步骤 ${step.id}(${step.tool}) 失败，已降级：${message}`)
        continue
      }
      fatalError = `步骤 ${step.id}(${step.tool}) 失败：${message}`
      failedIndex = i
      break
    }
  }

  // 因前序必选步骤失败而未执行的步骤，显式标记 skipped，便于调用方看出中断位置。
  if (failedIndex >= 0) {
    for (let i = failedIndex + 1; i < template.steps.length; i += 1) {
      const step = template.steps[i]
      traces.push({
        id: step.id,
        tool: step.tool,
        title: step.title,
        status: 'skipped',
        durationMs: 0,
        params: {},
      })
    }
  }

  if (fatalError) {
    return baseResult(
      template,
      now,
      Date.now() - startedAt,
      input,
      traces,
      fatalError,
      warnings,
      ds.kind,
    )
  }

  let result: unknown = null
  try {
    result = template.synthesize({ input, steps: stepData, now, dataSourceKind: ds.kind })
  } catch (err) {
    return baseResult(
      template,
      now,
      Date.now() - startedAt,
      input,
      traces,
      `结论合成失败：${errorMessageOf(err)}`,
      warnings,
      ds.kind,
    )
  }

  const status = warnings.length > 0 ? 'partial' : 'ok'
  const runResult: SkillRunResult = {
    templateId: template.id,
    templateVersion: template.version,
    title: template.title,
    status,
    generatedAt: now,
    durationMs: Date.now() - startedAt,
    dataSourceKind: ds.kind,
    input,
    steps: traces,
    result,
    warnings,
    ...nextRunOf(template, input, now),
  }
  return runResult
}

/** 按模板 id 执行；未注册时返回结构化失败结果（不抛异常）。 */
export async function runSkillById(
  registry: SkillRegistry,
  ds: DataSource,
  templateId: string,
  rawInput: Record<string, unknown> | undefined,
  options: RunSkillOptions = {},
): Promise<SkillRunResult> {
  const template = registry.get(templateId)
  if (!template) {
    const available = registry.list().map((item) => item.id).join(', ')
    const now = options.now ?? Date.now()
    return {
      templateId,
      templateVersion: 'n/a',
      title: templateId,
      status: 'failed',
      generatedAt: now,
      durationMs: 0,
      dataSourceKind: ds.kind,
      input: (rawInput ?? {}) as Record<string, unknown>,
      steps: [],
      result: null,
      warnings: [],
      error: `未找到技能模板 "${templateId}"，可用模板：${available || '(空)'}`,
    }
  }
  return runSkillTemplate(ds, template, rawInput, options)
}

function baseResult(
  template: SkillTemplate,
  now: number,
  durationMs: number,
  input: Record<string, unknown>,
  traces: readonly StepTrace[],
  error: string,
  warnings: readonly string[] = [],
  dataSourceKind: string,
): SkillRunResult {
  return {
    templateId: template.id,
    templateVersion: template.version,
    title: template.title,
    status: 'failed',
    generatedAt: now,
    durationMs,
    dataSourceKind,
    input,
    steps: traces,
    result: null,
    warnings,
    error,
  }
}

/** 定时调度占位：按模板声明的默认窗口，给出下一次建议执行窗口。 */
function nextRunOf(
  template: SkillTemplate,
  input: Record<string, unknown>,
  now: number,
): Pick<SkillRunResult, 'nextRun'> {
  if (!template.scheduleHint) return {}
  const window = resolveTimeWindow(input, now, template.scheduleHint.defaultWindowMs)
  const span = Math.max(window.endTime - window.startTime, ONE_HOUR_MS)
  return {
    nextRun: {
      startTime: window.endTime,
      endTime: window.endTime + span,
      ...(template.scheduleHint.cron ? { cron: template.scheduleHint.cron } : {}),
    },
  }
}

/** 过滤掉 undefined 值，避免把 `undefined` 透传进 query 构建逻辑。 */
function normalizeParams(params: ListParams): ListParams {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) out[key] = value
  }
  return out as ListParams
}
