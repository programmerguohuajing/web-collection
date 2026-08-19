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

/**
 * 隐私策略档位。
 * 注意两级分类（见 ADR-007）：第一级凭据（password/token/secret/authorization/cookie/apikey/jwt…
 * 及对应请求头）在**所有档位（含 off）**常驻剥离，是有意的 carve-out、不违反"采集层不丢弃"原则；
 * 第二级通用 PII（自由文本邮箱/手机/身份证/银行卡/JWT、表单值、URL query、body PII）才受本档位控制。
 * - `off`：关闭第二级通用 PII 的采集层脱敏（全量采集）；凭据剥离仍生效。仅用于已具备下游查询层脱敏的应用。
 * - `balanced`（默认，刻意的隐私安全出厂默认）：对第二级 PII 做采集层脱敏。
 * - `strict`：在 balanced 基础上进一步收紧（丢弃整个 URL query、<select> 仅留索引/数量）。
 */
export type PrivacyMode = 'off' | 'balanced' | 'strict'

/** 同意分类（用于按分类门控高风险采集模块，并支持 GPC / DNT 映射） */
export type ConsentCategory = 'essential' | 'performance' | 'analytics' | 'replay' | 'diagnostics'

/** 数据采集分类（用于按类别控制采样率） */
export type CaptureCategory = 'error' | 'performance' | 'requests' | 'behavior' | 'exposure' | 'replay'

/**
 * Reliable Transport v2 诊断事件类型（SDK-215 / SDK-207）。
 * 通过 `onDiagnostic` 回调暴露，用于观测发送健康度；不含任何业务敏感数据。
 */
export type DiagnosticType =
  | 'queue_full' // 本地队列溢出，丢弃最旧事件
  | 'rate_limited' // 收到 429，进入退避重试
  | 'timeout' // 单次发送超过超时阈值被中止
  | 'invalid_payload' // 服务端判定载荷非法（4xx 契约错误）
  | 'storage_quota' // 持久化队列写入失败（IndexedDB / storage 配额）
  | 'dropped_by_sampling' // 被采样策略丢弃
  | 'beacon_rejected' // navigator.sendBeacon 返回 false
  | 'beacon_oversize' // 单条事件超过 Beacon 字节上限，无法发送
  | 'beacon_fallback' // Beacon 不可用或需鉴权，回退 fetch keepalive
  | 'beacon_queued' // Beacon 已接受排队（不代表服务端已入库）
  | 'beacon_attempted' // 尝试走 Beacon 通道
  | 'next_session_recovered' // 下一会话从持久队列恢复的事件数
  | 'flush_attempt' // 发起一次在线发送
  | 'flush_success' // 在线发送成功入库
  | 'flush_failed' // 在线发送失败（不可重试被丢弃）
  | 'retry' // 可重试错误（429/5xx/超时），保留并重试
  | 'dropped_non_retryable' // 超过最大重试次数或 4xx 契约错误，永久丢弃
  | 'offline' // 处于离线状态，暂缓发送
  | 'capability_missing' // 模块需要某平台能力但该环境未支持，已静默跳过（P1-4）
  | 'pending_replayed' // 采集就绪前缓冲的事件在 ready 后回放的数量（P2-5 启动排队）

/** 传输诊断事件对象（随 `onDiagnostic` 回调派发） */
export interface EysDiagnosticEvent {
  /** 诊断事件类型 */
  type: DiagnosticType
  /** 关联状态码（如 HTTP 状态码） */
  status?: number
  /** 受影响事件计数 */
  count?: number
  /** 字节数（如 Beacon 批次） */
  bytes?: number
  /** 退避 / 重试延迟（毫秒） */
  retryAfter?: number
  /** 丢弃 / 重试原因补充 */
  reason?: string
  /** 事件时间戳（毫秒） */
  ts: number
  /** 采样决策单元：trace | session | global（仅 dropped_by_sampling 携带，Phase 6） */
  unit?: string
  /** 参与哈希的单元键（traceId / sessionId / 'global'，不含敏感数据） */
  key?: string
  /** 采样决策规则：priority | error_rate | remote | trace | session | session_category */
  rule?: string
  /** 命中的采样率 */
  rate?: number
  /** 命中分类（如 error / performance / requests …） */
  category?: string
  /** 扩展性诊断明细（不含业务敏感数据） */
  detail?: Record<string, unknown>
}

/**
 * 采样决策结果（Phase 6 · 确定性采样，可解释）。
 * 通过 `getSamplingDecision()` 自查最近一次决策，或随 `dropped_by_sampling` 诊断派发。
 */
export interface SamplingDecision {
  /** 是否保留该事件 / Span */
  sampled: boolean
  /** 应用的基础采样率 */
  rate: number
  /** 决策规则：priority（错误优先保留）| error_rate | remote（远端权重）| trace | session | session_category */
  rule: string
  /** 决策单元：trace | session | global */
  unit: string
  /** 实际参与哈希的单元键（traceId / sessionId / 'global'，不含敏感数据） */
  key: string
  /** 命中的事件分类 */
  category?: string
  /** 命中的分类采样率（rule === 'session_category' 时） */
  categoryRate?: number
}

/** 隐私保护配置（Privacy v2 统一 sanitizer） */
export interface EysPrivacyOptions {
  /**
   * 隐私策略档位。默认 'balanced'（刻意的隐私安全出厂默认）。
   * 仅控制**第二级通用 PII** 的采集层脱敏；**第一级凭据**（password/token/secret/authorization/cookie/apikey/jwt 及对应请求头）在所有档位（含 off）常驻剥离，属有意 carve-out。
   * - `off`：关闭第二级 PII 采集层脱敏（全量采集），仅用于已具备下游查询层脱敏的应用。
   * - `balanced`：对第二级 PII 做采集层脱敏（生产默认）。
   * - `strict`：在 balanced 基础上收紧。
   * 详见 ADR-007。
   */
  mode?: PrivacyMode
  /** 需要脱敏的字段名列表（在默认敏感字段基础上追加） */
  redactKeys?: string[]
  /** 需要屏蔽的 CSS 选择器（对应元素不上报） */
  blockSelectors?: string[]
  /** 需要遮盖的 CSS 选择器（对应元素内容替换为占位符） */
  maskSelectors?: string[]
  /** 网络请求上报白名单 */
  requestAllowlist?: string[]
  /** 请求 / 响应头黑名单：默认移除 Authorization / Cookie / Set-Cookie / Proxy-Authorization，可在此追加 */
  dropHeaders?: string[]
  /** URL query 中需要剥离的敏感参数名（在默认敏感参数基础上追加） */
  sensitiveQueryKeys?: string[]
  /** 是否对文本做 PII 脱敏（手机号 / 邮箱 / 身份证 / 银行卡 / JWT），默认 true */
  textRedaction?: boolean
  /** 按同意分类的开关，覆盖默认全开；与浏览器 GPC / DNT 信号合并后决定最终门控 */
  consentCategories?: Partial<Record<ConsentCategory, boolean>>
  /** 自定义请求 / 响应清洗钩子：接收并清洗 { url, requestHeaders, responseHeaders, requestBody, responseBody }，异常时回退默认清洗 */
  requestResponseSanitizer?: (pair: {
    url?: string
    requestHeaders?: Record<string, string>
    responseHeaders?: Record<string, string>
    requestBody?: unknown
    responseBody?: unknown
  }) => {
    url?: string
    requestHeaders?: Record<string, string>
    responseHeaders?: Record<string, string>
    requestBody?: unknown
    responseBody?: unknown
  }
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
  /** 两次非强制 collect 上报之间的最小间隔（毫秒）；用于抑制业务高频请求/点击/滚动期间 SDK 连续触发 collect，窗口内合并为 1 次延迟发送。force=true（页面退出/隐藏/错误）绕过。设为 0 关闭节流。默认 2000 */
  minFlushInterval?: number
  /** 最大队列长度 */
  maxQueue?: number
  /** 最大重试次数 */
  maxRetries?: number
  /** 全局采样率（0-1），作为 session / global 基础采样率（Phase 6 确定性采样） */
  sampleRate?: number
  /** 链路（traceId）基础采样率（0-1）；默认复用 sampleRate（Phase 6） */
  traceRate?: number
  /** 错误链路 / 事件的确定性子采样率（0-1）；默认不设置 = 错误始终保留（优先级，Phase 6） */
  errorSampleRate?: number
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
  /** 允许注入链路追踪头（traceparent/tracestate/baggage）的跨域 origin 规则；同源始终允许。
   *  支持精确字符串（如 'https://api.example.com'）、正则（测试 origin）、或自定义函数（接收 origin 返回 boolean）。 */
  traceOrigins?: Array<string | RegExp | ((origin: string) => boolean)>
  /** 是否采集网络请求 */
  requests?: boolean
  /** 是否将 Span（页面根 / 自动请求 / 自定义）经 Processor/Exporter 批量写入 /api/spans。
   *  默认 false：0.1.x 不破坏现有后端与存储成本；0.2.0-beta 起可默认开启（配合采样）。 */
  spanExport?: boolean
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
  /**
   * IIFE 自托管场景下 rrweb 脚本地址。ESM 构建由 Vite 自动拆分为独立 chunk，无需此配置；
   * IIFE 构建把 rrweb 外部化，replay 开启时若未通过 <script> 预注入 window.rrweb，
   * 则由此 URL 注入 rrweb 脚本后再录制（Phase 7 · SDK-209）。
   */
  replayLibUrl?: string
  /**
   * 压缩 Worker 脚本地址。提供则在 Worker 内完成 gzip（主线程零阻塞）；
   * 不提供则回退主线程 CompressionStream；两者皆不可用则降级压缩标记 none。
   */
  replayWorkerUrl?: string
  /** 是否对回放 payload 做 gzip 压缩（默认 true，无 CompressionStream 时自动降级） */
  replayCompression?: boolean
  /** 回放环形缓冲最大留存事件数（内存护栏，默认 1500） */
  replayBufferSize?: number
  /** 回放环形缓冲时间窗口（毫秒，默认 30000）：超出窗口的旧事件被惰性淘汰，保证错误前 30 秒可恢复 */
  replayWindowMs?: number
  /**
   * 强制刷新（错误/分段结束/页面卸载）时单页回放事件上限（默认 50，= replayBatchSize）。
   * 超出拆分为多页，每页独立记录并携带 page/pageCount，支撑回放「分页加载」（SDK-211）。
   */
  replayPageSize?: number
  /**
   * 常态回放增量采样率 [0,1]（默认 1，全保留）。<1 时对高频回放事件降采样以降本；
   * 发生错误时自动升至全采样（错误触发升采样），不影响错误前后上下文完整性。
   */
  replaySampleRate?: number
  /** 是否开启错误触发升采样（默认 true）：错误发生后扩展留存窗口至 replayWindowMsError 并全采样 */
  replayErrorTrigger?: boolean
  /** 错误升采样期间的留存窗口（毫秒，默认 60000，常态 30s 的两倍） */
  replayWindowMsError?: number
  /**
   * 是否开启 Canvas 录制（默认 false，显式 opt-in）。开启后透传 rrweb 的 recordCanvas。
   * 完整 Canvas 保真度需在 replayOptions.plugins 中提供 @rrweb/rrweb-plugin-canvas 实例。
   */
  replayCanvas?: boolean
  /**
   * 是否开启跨域 iframe 录制（默认 false，显式 opt-in）。开启后透传 rrweb 的
   * recordCrossOriginIframes 与 inlineIframes。
   */
  replayIframe?: boolean
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
  /** 是否监控 ReportingObserver（弃用/干预/CSP/崩溃报告），默认 true */
  reportingMonitoring?: boolean
  /** 是否监控页面生命周期与 bfcache（freeze/resume/pageshow.persisted），默认 true */
  lifecycleMonitoring?: boolean
  /** 是否监控 WebGL/WebGPU 上下文丢失，默认 false */
  graphicsMonitoring?: boolean
  /** 是否监控 video/audio 播放错误，默认 false */
  mediaMonitoring?: boolean
  /** 是否监控网络质量变化（connection change），默认 true */
  networkInfoMonitoring?: boolean
  /** 是否监控屏幕方向变化，默认 true */
  orientationMonitoring?: boolean
  /** 是否监控元素级性能（Element Timing），默认 false */
  elementTimingMonitoring?: boolean
  /** 是否监控 SharedWorker 错误，默认 false */
  sharedWorkerMonitoring?: boolean
  /** 是否生成探针采集 Worker 上下文（WorkerNavigator/WorkerLocation），默认 false */
  workerContextProbe?: boolean
  /** 是否监控 WebRTC 连接质量，默认 false */
  webrtcMonitoring?: boolean
  /** 是否监控计算压力（CPU/散热），默认 false */
  computePressureMonitoring?: boolean
  /** 是否监控全屏状态变化，默认 false */
  fullscreenMonitoring?: boolean
  /** 是否监控 Web Share 意图，默认 false */
  webShareMonitoring?: boolean
  /** 是否监控剪贴板操作（仅元数据，不记内容），默认 false */
  clipboardMonitoring?: boolean
  /** 是否采集存储配额用量，默认 false */
  storageEstimateMonitoring?: boolean
  /** 是否采集权限状态快照，默认 false */
  permissionsMonitoring?: boolean
  /** 传输层诊断回调（Reliable Transport v2）。暴露队列满 / 限流 / 超时 / 丢弃 / Beacon 等事件，不含业务敏感数据。 */
  onDiagnostic?: (event: EysDiagnosticEvent) => void
  /** 单次在线发送超时（毫秒），超时按网络错误重试。默认 10000。 */
  transportTimeout?: number
  /** 页面退出阶段单个 Beacon 批次的 UTF-8 字节上限。默认 61440（60 KiB）。 */
  beaconMaxBytes?: number
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
  /** 获取当前隐私策略档位（'off' | 'balanced' | 'strict'） */
  getPrivacyMode(): PrivacyMode
  /** 获取解析后的同意分类（已合并 GPC / DNT 信号），用于自查 SDK 当前门控 */
  getConsentCategories(): Record<ConsentCategory, boolean>
  /** 获取最近一次采样决策（含规则 / 采样率 / 单元 / 键），用于 SDK 自诊断与调试；无决策时返回 null */
  getSamplingDecision(): SamplingDecision | null
  /** 获取当前环境能力位（P1-4），用于自查 SDK 在本环境支持的采集能力 */
  getCapabilities(): Record<string, boolean>
  /** 双 ID 身份：设置已登录用户 ID（appUserId），并与匿名设备 ID 关联；已入队事件回填 userId */
  identify(userId: string, traits?: Record<string, unknown>): void
  /** 获取匿名设备 ID（anonymousId），与 identify 后的 userId 共同构成双 ID 模型（P2-5） */
  getAnonymousId(): string
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
  /** 立即冲刷 Span 导出管线缓冲（将已结束 Span 发送到 /api/spans） */
  flushSpans(): Promise<void> | void
  /** 销毁 SDK 实例，清理所有监听和资源 */
  destroy(): void
  /** 开始回放录制（异步懒加载 rrweb，SDK-209） */
  startReplay(): Promise<void>
  /** 停止回放录制并刷新缓冲区 */
  stopReplay(): Promise<void>
  /** 刷新回放缓冲区（异步，含压缩） */
  flushReplay(force?: boolean): Promise<void>
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

// ============================================================================
// Span Processor / Exporter（路线图 Phase 2 · SDK-202）
// 让页面根 Span、自动请求 Span、自定义 Span 经同一管线批量写入 /api/spans，
// 后端分布式调用树不再依赖 perf event「猜」Span。
// ============================================================================

/** 资源信息（随 Span 一起上报，标识来源服务） */
export interface SpanResource {
  /** 服务名，前端 Span 统一为 'frontend' */
  serviceName?: string
  /** SDK 名称 */
  sdkName?: string
  /** SDK 版本 */
  sdkVersion?: string
}

/** 后端 Span Envelope v2 中的单条 Span 记录（由 Span.toExport 生成） */
export interface ReadableSpan {
  /** 幂等去重键，通常为 `${traceId}-${spanId}` */
  id: string
  traceId: string
  spanId: string
  parentSpanId: string
  serviceName: string
  operationName: string
  kind: string
  /** epoch 毫秒 */
  startTime: number
  duration: number
  statusCode: string
  statusMessage: string
  attributes: Record<string, unknown>
}

/** Exporter 导出结果 */
export interface ExportResult {
  ok: boolean
  count: number
  error?: string
  result?: unknown
}

/** Span Processor 接口（Span 生命周期钩子） */
export abstract class SpanProcessor {
  onStart(span: Span): void
  onEnd(span: Span): void
  forceFlush(): Promise<void>
  shutdown(): Promise<void>
}

/** 批量 Span 处理器配置项 */
export interface BatchSpanProcessorOptions {
  /** 缓冲达到该数量立即触发导出（默认 64） */
  maxExportBatchSize?: number
  /** 定时刷新间隔（毫秒，默认 5000） */
  scheduledDelayMillis?: number
  /** 缓冲上限，超出丢弃最旧（默认 512） */
  maxQueueSize?: number
}

/** 批量 Span 处理器：缓冲 Span，达到批量上限或定时后批量导出 */
export class BatchSpanProcessor extends SpanProcessor {
  constructor(exporter: SpanExporter, options?: BatchSpanProcessorOptions)
}

/** Span Exporter 接口（抽象） */
export abstract class SpanExporter {
  export(spans: Span[]): Promise<ExportResult>
}

/** 前端 Span 统一资源信息（serviceName 默认为 'frontend'） */
export const DEFAULT_RESOURCE: Required<SpanResource>

/** Web Collection Span Exporter：批量写入本平台 /api/spans（Span Envelope v2） */
export class WebCollectionSpanExporter extends SpanExporter {
  constructor(options: { send?: (payload: { schemaVersion: number; resource: SpanResource; spans: ReadableSpan[] }) => Promise<unknown>; resource?: SpanResource })
}

// ============================================================================
// W3C 标准传播（路线图 Phase 3 · U03 / SDK-205）
// 标准单一 `baggage` Header + tracestate 规范化 + traceOrigins 匹配（string/RegExp/function）。
// 与 OpenTelemetry / Elastic / Grafana Faro 直接互通。
// ============================================================================

/** W3C Trace Context Header 名常量 */
export const TRACE_PARENT: 'traceparent'
export const TRACE_STATE: 'tracestate'
/** W3C 标准 baggage 单一 Header 名 */
export const BAGGAGE: 'baggage'
/** @deprecated 旧版多 header baggage 前缀，仅用于向后兼容提取 */
export const BAGGAGE_PREFIX: 'baggage-'

/** 将 baggage（Map 或普通对象）序列化为 W3C 标准 baggage Header 值（逗号分隔 `k=v`，值 URL 编码） */
export function serializeBaggage(baggage: Map<string, string> | Record<string, string>): string
/** 解析 W3C 标准 baggage Header 值为 Map（兼容 member 属性，只取 value） */
export function parseBaggage(headerValue: string): Map<string, string>
/** 规范化 tracestate 字符串（trim/去空 member/超过 512 截断） */
export function normalizeTraceState(value: string): string
/** 注入 traceparent + tracestate + 标准 baggage 到 headers */
export function injectHeaders(context: TraceContext, options?: { headers?: Headers }): Headers
/** 注入标准 baggage 单一 Header 到 headers */
export function injectBaggage(context: TraceContext, headers?: Headers): Headers
/** 从 headers 提取 baggage（兼容标准 baggage 与旧 baggage-* 多个头） */
export function extractBaggage(headers: Headers | Record<string, string>): Map<string, string>
/** 从 headers 提取完整 TraceContext（含 traceparent/tracestate/baggage） */
export function extractContext(headers: Headers | Record<string, string>, parentContext?: TraceContext): TraceContext | null
/** 判断 origin 是否匹配 traceOrigins 规则（string | RegExp | function） */
export function matchesTraceOrigin(origin: string, rule: string | RegExp | ((origin: string) => boolean) | null | undefined): boolean
/** 判断请求 URL 是否允许注入链路追踪头（同源恒真；跨域需命中 traceOrigins 规则）。baseHref 用于非浏览器环境测试。 */
export function canTrace(value: string, origins?: Array<string | RegExp | ((origin: string) => boolean)>, baseHref?: string): boolean

/** 扩展 Window 全局类型声明 */
declare global {
  interface Window {
    WebCollection?: typeof WebCollection
  }
}
