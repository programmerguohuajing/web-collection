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

/** 扩展 Window 全局类型声明 */
declare global {
  interface Window {
    WebCollection?: typeof WebCollection
  }
}
