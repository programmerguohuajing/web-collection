/** 事件类型 */
export type EventType = 'track' | 'perf' | 'performance' | 'behavior' | 'error' | 'replay' | 'log' | 'trace'

/** 行为事件名称枚举 */
export type BehaviorEventName =
  | 'pv' | 'page_leave' | 'click' | 'scroll' | 'route_change' | 'hashchange' | 'popstate' | 'pushState' | 'replaceState'
  | 'form_submit' | 'rage_click' | 'dead_click' | 'copy' | 'paste' | 'download'
  | 'input_focus' | 'input_blur' | 'input_change'
  | 'select_change' | 'keyboard' | 'touch_tap' | 'touch_swipe'
  | 'app_start' | 'app_foreground' | 'app_background' | 'network_change'

/** 用户信息 */
export interface EysUser {
  /** 用户唯一标识 */
  id?: string
  /** 用户名称 */
  name?: string
  /** 用户手机号 */
  phone?: string
  /** 用户 ID（别名） */
  userId?: string
  /** 用户名（别名） */
  userName?: string
  /** 用户手机号（别名） */
  userPhone?: string
}

/** 隐私同意状态 */
export type ConsentStatus = 'granted' | 'denied'

/** 数据采集分类（用于按类别控制采样率） */
export type CaptureCategory = 'error' | 'performance' | 'requests' | 'behavior' | 'exposure' | 'replay'

/** 隐私保护配置 */
export interface EysPrivacyOptions {
  /** 需要脱敏的字段名列表 */
  redactKeys?: string[]
  /** 需要屏蔽的 CSS 选择器（对应元素不上报） */
  blockSelectors?: string[]
  /** 需要遮盖的 CSS 选择器（对应元素内容替换为占位符） */
  maskSelectors?: string[]
  /** 网络请求上报白名单 */
  requestAllowlist?: string[]
}

/** 事务对象：用于追踪一个完整业务流程的开始和结束 */
export interface EysTransaction {
  /** 设置事务过程中的附加数据 */
  setData(data: Record<string, unknown>): void
  /** 结束事务，可选择传入最终结果 */
  finish(result?: Record<string, unknown>): void
}

/** SDK 初始化配置项 */
export interface EysOptions {
  /** 数据上报端点地址 */
  endpoint?: string
  /** 应用 ID */
  appId?: string
  /** 发布版本号 */
  release?: string
  /** 用户 ID */
  userId?: string
  /** 用户名称 */
  userName?: string
  /** 用户手机号 */
  userPhone?: string
  /** 批量上报大小 */
  batchSize?: number
  /** 上报间隔（毫秒） */
  flushInterval?: number
  /** 最大队列长度 */
  maxQueue?: number
  /** 最大重试次数 */
  maxRetries?: number
  /** 全局采样率（0-1） */
  sampleRate?: number
  /** 是否采集用户行为 */
  behavior?: boolean
  /** 是否采集 console 日志 */
  console?: boolean
  /** 采集的 console 日志级别 */
  consoleLevels?: Array<'log' | 'info' | 'warn' | 'error'>
  /** 自定义采集键，用于标识接入方 */
  collectKey?: string
  /** 是否开启链路追踪（Trace） */
  tracing?: boolean
  /** 链路追踪的域名白名单 */
  traceOrigins?: string[]
  /** 是否采集网络请求 */
  requests?: boolean
  /** 是否采集曝光埋点 */
  exposure?: boolean
  /** 是否开启回放录制 */
  replay?: boolean
  /** 是否按路由分段录制回放 */
  replaySegmentByRoute?: boolean
  /** 单段回放最大时长（毫秒） */
  replayMaxDuration?: number
  /** 回放批量上报大小 */
  replayBatchSize?: number
  /** 回放额外配置项 */
  replayOptions?: Record<string, unknown>
  /** 白屏检测的 DOM 选择器 */
  whiteScreenSelector?: string
  /** 白屏检测超时时间（毫秒） */
  whiteScreenTimeout?: number
  /** 是否启用 SDK */
  enabled?: boolean
  /** 隐私同意状态 */
  consent?: ConsentStatus
  /** 环境标识（如 production / staging） */
  environment?: string
  /** 按分类的采样率配置 */
  categorySampleRates?: Partial<Record<CaptureCategory, number>>
  /** 事件发送前钩子，返回 false 可拦截该事件 */
  beforeSend?: (event: Record<string, unknown>) => Record<string, unknown> | false
  /** 隐私配置 */
  privacy?: EysPrivacyOptions
  /** 是否监听表单提交 */
  formTracking?: boolean
  /** 是否监听愤怒点击 */
  rageClick?: boolean
  /** 是否监听死点击 */
  deadClick?: boolean
  /** 是否监听用户交互（复制/粘贴/下载） */
  interactionTracking?: boolean
  /** 是否监听 select 选择框变更 */
  selectTracking?: boolean
  /** 是否监听输入框行为 */
  inputTracking?: boolean
  /** 是否采集运行环境信息 */
  environmentInfo?: boolean
  /** 运行时信息（构建 ID、时间等） */
  runtimeInfo?: boolean | {
    buildId?: string
    buildTime?: string
    commit?: string
    branch?: string
  }
  /** 内存采集间隔（毫秒） */
  memoryInterval?: number
  /** 请求体采样比例（0-1），用于控制请求体上报比例 */
  requestBodySampling?: number
  /** 是否启用打包产物体积监控 */
  bundleMonitoring?: boolean
  /** 是否监听键盘事件 */
  keyboardTracking?: boolean
  /** 需要采集的键盘按键 */
  keyboardTrackingKeys?: string[]
  /** 是否监听触摸手势 */
  touchTracking?: boolean
  /** 是否监控 Web Worker */
  workerMonitoring?: boolean
  /** 是否监控 Service Worker */
  serviceWorkerMonitoring?: boolean
}

/** SDK 客户端实例接口 */
export interface EysClient {
  /** 自定义埋点上报 */
  track(name: string, props?: Record<string, unknown>): void
  /** 手动上报错误 */
  error(error: unknown, extra?: Record<string, unknown>): void
  /** 上报性能指标 */
  metric(name: string, value: number, props?: Record<string, unknown>): void
  /** 上报日志 */
  log(level: 'log' | 'info' | 'warn' | 'error' | string, message: unknown, props?: Record<string, unknown>): void
  /** 设置用户信息 */
  setUser(user: EysUser): void
  /** 设置隐私同意状态 */
  setConsent(status: ConsentStatus): void
  /** 启用/禁用 SDK */
  setEnabled(enabled: boolean): void
  /** 设置全局上下文（会附加到所有上报事件中） */
  setContext(context: Record<string, unknown>): void
  /** 添加面包屑（用于错误追踪的上下文信息） */
  addBreadcrumb(name: string, data?: Record<string, unknown>): void
  /** 开始一个事务 */
  startTransaction(name: string, context?: Record<string, unknown>): EysTransaction
  /** 标记页面渲染完成（用于计算首屏时间等指标） */
  markPageReady(): void
  /** 立即刷新上报队列 */
  flush(force?: boolean): Promise<void> | void
  /** 销毁 SDK 实例，清理所有监听和资源 */
  destroy(): void
  /** 开始回放录制 */
  startReplay(): void
  /** 停止回放录制 */
  stopReplay(): void
  /** 刷新回放缓冲区 */
  flushReplay(force?: boolean): void
  /** 添加自定义回放事件 */
  addReplayEvent(name: string, props?: Record<string, unknown>): void
  /** 主动触发回放快照 */
  takeReplaySnapshot(): void
  /** 结束当前回放分段 */
  endReplaySegment(reason: 'error' | 'route' | 'max_duration' | 'page_unload' | string): void
}

/** 创建 SDK 客户端实例 */
export function createEys(options?: EysOptions): EysClient

/** Vue 插件安装方法 */
export function install(
  app: {
    config: {
      errorHandler?: (err: unknown, instance: unknown, info: string) => void
      globalProperties: Record<string, unknown>
    }
  },
  options?: EysOptions
): void

/** IIFE 模式下挂载到 window.WebCollection 的全局命名空间 */
declare const WebCollection: {
  createEys: typeof createEys
  install: typeof install
}

export default WebCollection

// ============================================================================
// Tracing 公共 API
// 以下类型与 `src/trace/index.js` 运行时导出的公共成员保持一致，
// 解决运行时可调但 TypeScript 不允许的契约漂移（路线图 U02）。
// ============================================================================

/** Span 状态码 */
export const SpanStatusCode: {
  /** 成功 */
  OK: string
  /** 错误 */
  ERROR: string
  /** 未设置 */
  UNSET: string
}

/** Span 类型（跨进程 / 内部） */
export const SpanKind: {
  /** 服务端接收请求 */
  SERVER: string
  /** 客户端发送请求 */
  CLIENT: string
  /** 消息生产者 */
  PRODUCER: string
  /** 消息消费者 */
  CONSUMER: string
  /** 内部操作 */
  INTERNAL: string
}

/** Span 事件（带时间戳的标注点） */
export interface SpanEvent {
  name: string
  timestamp: number
  attributes: Record<string, unknown>
}

/** Span 状态码对象 */
export interface SpanStatus {
  code: string
  message: string
}

/** Span 的可序列化上下文 */
export interface SpanContext {
  traceId: string
  spanId: string
  parentSpanId: string
  traceFlags: string
  traceState?: string
}

/** Span 对象：链路追踪最小工作单元 */
export class Span {
  constructor(options: { name: string; context: TraceContext; kind?: string; attributes?: Record<string, unknown> })
  /** 设置单个属性 */
  setAttribute(key: string, value: unknown): Span
  /** 批量设置属性 */
  setAttributes(attributes: Record<string, unknown>): Span
  /** 添加带时间戳的标注事件 */
  addEvent(name: string, attributes?: Record<string, unknown>): void
  /** 记录异常到 span */
  recordException(error: unknown, attributes?: Record<string, unknown>): void
  /** 设置 span 状态 */
  setStatus(code: string, message?: string): void
  /** 结束 span（幂等） */
  end(options?: { endTime?: number }): void
  /** 持续时间（ms），未结束返回 null */
  duration(): number | null
  /** 是否已结束 */
  isEnded(): boolean
  /** 获取上下文信息 */
  getContext(): SpanContext
  /** 转换为可序列化对象 */
  toJSON(): Record<string, unknown>
  /** span 名称 */
  name: string
  /** 当前状态 */
  status: SpanStatus
  /** 属性表 */
  attributes: Map<string, unknown>
  /** 事件列表 */
  events: SpanEvent[]
}

/** W3C Trace Context 封装 */
export class TraceContext {
  constructor(options?: {
    traceId?: string
    spanId?: string
    parentSpanId?: string
    traceFlags?: string
    traceState?: string
    baggage?: Map<string, string> | Record<string, string>
  })
  traceId: string
  spanId: string
  parentSpanId: string
  traceFlags: string
  traceState: string
  baggage: Map<string, string>
  /** 从 traceparent 字符串解析 */
  static fromTraceParent(traceparent: string): TraceContext | null
  /** 生成 traceparent 字符串 */
  toTraceParent(): string
  /** 设置 baggage 条目，返回新上下文（不可变） */
  setBaggage(key: string, value: string): TraceContext
  /** 获取 baggage 条目 */
  getBaggage(key: string): string | undefined
  /** baggage 对象 */
  getBaggageObject(): Record<string, string>
  /** 转为纯对象 */
  toObject(): Record<string, unknown>
  /** 是否根 span（无父） */
  isRoot(): boolean
  /** 创建子 span 上下文 */
  child(childSpanId?: string): TraceContext
}

/** Tracer 配置项 */
export interface TracerOptions {
  name?: string
  version?: string
  traceId?: string
  sampler?: Sampler
  baggage?: Record<string, string>
}

/** Tracer：链路追踪核心追踪器 */
export class Tracer {
  constructor(options?: TracerOptions)
  /** 创建根 span（页面加载时调用一次） */
  createRootSpan(name?: string, attributes?: Record<string, unknown>): Span
  /** 获取根 span */
  getRootSpan(): Span | null
  /** 创建并激活新 span（自动设置父子关系） */
  startSpan(name: string, options?: { parent?: Span; kind?: string; attributes?: Record<string, unknown>; traceFlags?: string }): Span
  /** 在 span 内执行函数，自动结束 span（同步 / 异步 / 异常均恢复父上下文） */
  withSpan<T>(name: string, fn: (span: Span) => T, options?: Record<string, unknown>): T
  /** 创建 HTTP CLIENT span 并注入 trace 头 */
  startSpanWithHeaders(name: string, options?: { requestInit?: RequestInit; method?: string; url?: string; attributes?: Record<string, unknown> }): { span: Span; requestInit: RequestInit }
  /** 从响应头提取并更新 span 上下文 */
  extractResponse(span: Span, headers: Headers | Record<string, string>): void
  /** 结束 span 并从活动栈弹出 */
  endSpan(span: Span): void
  /** 获取当前活动 span */
  getCurrentSpan(): Span | null
  /** 获取当前 trace 上下文 */
  getCurrentContext(): TraceContext | null
}

/** 采样器配置项 */
export interface SamplerOptions {
  sampleRate?: number
  categorySampleRates?: Record<string, number>
  traceState?: string
}

/** 采样器：head-based 采样决策 */
export class Sampler {
  constructor(options?: SamplerOptions)
  /** 决策是否采样 */
  shouldSample(category?: string): boolean
  /** 获取 traceFlags（'01' = sampled, '00' = not sampled） */
  getTraceFlags(category?: string): string
  /** 链式更新配置 */
  with(options: SamplerOptions): Sampler
}

/** 创建 Tracer 实例（同时注册为全局活跃 Tracer） */
export function createTracer(options?: TracerOptions): Tracer
/** 获取当前活动 span（委托给全局活跃 Tracer） */
export function getCurrentSpan(): Span | null
/** 获取当前 trace 上下文（委托给全局活跃 Tracer） */
export function getCurrentContext(): TraceContext | null
/** 创建采样器实例 */
export function createSampler(options?: SamplerOptions): Sampler
/** 给定采样率返回是否采样 */
export function isSampled(rate?: number): boolean

/** 扩展 Window 全局类型声明 */
declare global {
  interface Window {
    WebCollection?: typeof WebCollection
  }
}
