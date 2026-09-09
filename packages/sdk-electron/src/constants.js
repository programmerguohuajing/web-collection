/**
 * @file Electron 端常量（诊断事件名 / 熔断阈值 / 默认配置）
 *
 * 事件类型红线：本包不新增任何事件 type —— 全部复用后端白名单
 * ['track','perf','performance','behavior','error','replay','log','trace']。
 * Electron 场景语义全部表达在 name / metric / props 上：
 *   - 应用生命周期 → behavior('app_start' | 'app_foreground' | 'app_background')
 *   - 冷启动耗时   → perf(metric='app_ready')
 *   - 崩溃         → error(crash_source='main_uncaughtException' | 'main_unhandledRejection'
 *                            | 'renderer_gone' | 'preload_error')
 */

/** 诊断事件名（经 options.onDiagnostic 出口，不含业务敏感数据） */
export const DIAGNOSTIC = Object.freeze({
  /** 内核缺失（@web-collection/sdk/platform 未安装或未构建）→ 降级 noop */
  CORE_MISSING: 'core_missing',
  /** fetch 能力缺失（Electron < 22 / Node < 18 主进程）→ 降级 noop */
  FETCH_MISSING: 'fetch_missing',
  /** 本包内部异常（L2 吞掉后记录） */
  SDK_INTERNAL_ERROR: 'sdk_internal_error',
  /** 模块熔断关闭（L3） */
  MODULE_DISABLED: 'module_disabled',
  /** 渲染进程 IPC 事件载荷不合法被丢弃 */
  IPC_PAYLOAD_INVALID: 'ipc_payload_invalid',
  /** IPC 桥代理上报失败（主进程 → 服务端） */
  IPC_PROXY_FAILED: 'ipc_proxy_failed'
})

/** L3 模块熔断默认阈值：同一模块连续 N 次异常即永久关闭 */
export const CIRCUIT_BREAKER_THRESHOLD = 5

/** 渲染进程事件转发默认 IPC 通道名 */
export const DEFAULT_IPC_CHANNEL = 'eys:events'

/** 应用冷启动 metric 名（perf 维度，后端事件表 metric 字段） */
export const METRIC_APP_READY = 'app_ready'
