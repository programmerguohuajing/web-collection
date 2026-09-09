/**
 * 可调用工具名集合。
 *
 * 这里的名字必须与 `src/tools/registerTools.ts` 中 `server.registerTool(name, ...)` 的名字
 * 完全一致——技能模板只允许编排既有工具，不允许引入新的数据出口。
 * `test/skills.contract.test.mjs` 会用静态方式校验二者不漂移。
 */
export const TOOL_NAMES = [
  'list_events',
  'list_logs',
  'get_summary',
  'list_issues',
  'list_replays',
  'list_traces',
  'get_analytics_sessions',
  'get_analytics_paths',
  'get_analytics_click_paths',
  'get_analytics_heatmap',
  'get_analytics_live',
  'list_alerts',
  'list_alert_channels',
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

/** 类型守卫：运行期判断任意字符串是否是已注册的工具名。 */
export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value)
}
