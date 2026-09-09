import type { ZodRawShape, ZodTypeAny } from 'zod'

/** 单个入参字段的说明，用于把模板能力暴露给第三方 Agent（人类与 LLM 都可读）。 */
export interface InputFieldDoc {
  readonly name: string
  /** 归一化后的可读类型名（string / number / boolean / enum / array / record / unknown）。 */
  readonly type: string
  readonly required: boolean
  readonly description?: string
  /** 默认值（若 zod schema 声明了 default）。 */
  readonly defaultValue?: unknown
}

interface ZodDefLike {
  typeName?: string
  description?: string
  innerType?: ZodTypeAny
  values?: unknown[]
  default?: unknown
}

function defOf(schema: ZodTypeAny): ZodDefLike {
  return (schema as unknown as { _def?: ZodDefLike })._def ?? {}
}

function unwrap(schema: ZodTypeAny): { inner: ZodTypeAny; optional: boolean; defaultValue?: unknown } {
  let inner = schema
  let optional = false
  let defaultValue: unknown
  // 最多剥 4 层：Optional / Nullable / Default / Effects 嵌套组合足够覆盖本项目用法。
  for (let i = 0; i < 4; i += 1) {
    const def = defOf(inner)
    if (def.typeName === 'ZodOptional' || def.typeName === 'ZodNullable') {
      optional = def.typeName === 'ZodOptional'
      inner = def.innerType ?? inner
      continue
    }
    if (def.typeName === 'ZodDefault') {
      optional = true
      defaultValue = typeof def.default === 'function' ? (def.default as () => unknown)() : def.default
      inner = def.innerType ?? inner
      continue
    }
    break
  }
  return { inner, optional, defaultValue }
}

function typeNameOf(schema: ZodTypeAny): string {
  const def = defOf(schema)
  switch (def.typeName) {
    case 'ZodString':
      return 'string'
    case 'ZodNumber':
      return 'number'
    case 'ZodBoolean':
      return 'boolean'
    case 'ZodEnum':
      return `enum(${Array.isArray(def.values) ? def.values.join('|') : '?'})`
    case 'ZodArray':
      return 'array'
    case 'ZodRecord':
      return 'record'
    case 'ZodObject':
      return 'object'
    default:
      return 'unknown'
  }
}

/**
 * 把 zod raw shape 转换为可序列化的入参说明。
 * 仅做「尽力而为」的读取：任何非预期结构都退化为 `unknown`，绝不抛错，
 * 避免能力发现接口（list_skill_templates）因 schema 细节变化而整体失败。
 */
export function describeInputSchema(shape: ZodRawShape): InputFieldDoc[] {
  return Object.entries(shape).map(([name, raw]) => {
    const schema = raw as ZodTypeAny
    const { inner, optional, defaultValue } = unwrap(schema)
    const description = defOf(schema).description || defOf(inner).description || undefined
    const doc: {
      name: string
      type: string
      required: boolean
      description?: string
      defaultValue?: unknown
    } = { name, type: typeNameOf(inner), required: !optional }
    if (description) doc.description = description
    if (defaultValue !== undefined) doc.defaultValue = defaultValue
    return doc
  })
}
