import type { CaptureCategory, ConsentStatus, EysDiagnosticEvent, EysPrivacyOptions, EysTransaction, EysUser, SamplingDecision } from './index.js'

/**
 * 平台能力位（P1-4 · 能力位 + 静默降级）。
 * 每个适配器声明自身宿主支持的能力；SDK 在装配模块时按能力位静默跳过不支持的能力，
 * 不抛错、不影响其他采集，并通过 `capability_missing` 诊断暴露（仅在 required 时）。
 * 未声明（或显式 false）即视为不支持。
 */
export interface PlatformCapabilities {
  /** DOM 元素 / 选择器查询能力（曝光、回放录制依赖） */
  dom?: boolean
  /** IntersectionObserver 曝光采集能力 */
  exposure?: boolean
  /** MutationObserver / rrweb 回放录制能力 */
  replay?: boolean
  /** 网络状态变化监听能力 */
  networkStatus?: boolean
  /** 路由 / 页面导航状态监听能力 */
  navigation?: boolean
  /** 本地持久化（storage）能力 */
  storage?: boolean
  /** navigator.sendBeacon 非阻塞上报能力 */
  beacon?: boolean
  /** 页面可见性（visibilitychange）监听能力 */
  visibility?: boolean
}

/** 平台上下文信息 */
export interface PlatformContext {
  /** 完整页面 URL */
  url?: string
  /** 页面路径 */
  path?: string
  /** 页面标题 */
  title?: string
  /** 来源页面 */
  referrer?: string
  /** User-Agent */
  userAgent?: string
  /** 运行环境 */
  environment?: string
  /** 网络类型 */
  network?: string
}

/**
 * 平台适配器接口
 * 不同宿主（小程序 / UniApp / Taro / React Native）需要实现此接口，
 * SDK 通过适配器完成网络请求、存储、错误监听等平台相关操作。
 */
export interface PlatformAdapter {
  /** 平台名称 */
  name: string
  /** 原生网络请求方法（可选） */
  rawRequest?: (options: Record<string, unknown>) => unknown
  /** HTTP 请求 */
  request(options: { url: string; method: string; headers: Record<string, string>; data: unknown }): Promise<unknown>
  /** 读取存储 */
  getStorage?(key: string): unknown | Promise<unknown>
  /** 写入存储 */
  setStorage?(key: string, value: unknown): unknown | Promise<unknown>
  /** 获取平台上下文（路径、标题等） */
  getContext?(): PlatformContext
  /** 注册错误监听（返回取消监听函数） */
  onError?(listener: (error: unknown) => void): void | (() => void)
  /** 注册未捕获 Promise 异常监听 */
  onUnhandledRejection?(listener: (event: unknown) => void): void | (() => void)
  /** 注册网络状态变化监听 */
  onNetworkStatusChange?(listener: (event: unknown) => void): void | (() => void)
  /** 注册页面路由变化监听 */
  onNavigationStateChange?(listener: (event: unknown) => void): void | (() => void)
  /** 平台能力位声明（P1-4）。未声明即视为不支持，SDK 据此静默降级。 */
  capabilities?: PlatformCapabilities
}

/** 平台 SDK 初始化配置项（精简版，仅包含平台层需要的配置） */
export interface PlatformEysOptions {
  endpoint?: string
  appId?: string
  release?: string
  userId?: string
  userName?: string
  userPhone?: string
  batchSize?: number
  flushInterval?: number
  maxQueue?: number
  maxRetries?: number
  sampleRate?: number
  /** 链路（traceId）基础采样率（0-1）；默认复用 sampleRate（Phase 6 确定性采样） */
  traceRate?: number
  /** 错误链路 / 事件的确定性子采样率（0-1）；默认不设置 = 错误始终保留（优先级，Phase 6） */
  errorSampleRate?: number
  collectKey?: string
  enabled?: boolean
  consent?: ConsentStatus
  environment?: string
  categorySampleRates?: Partial<Record<CaptureCategory, number>>
  beforeSend?: (event: Record<string, unknown>) => Record<string, unknown> | false
  privacy?: EysPrivacyOptions
  /** 传输层诊断回调（Reliable Transport v2）。暴露队列满 / 限流 / 超时 / 丢弃等事件，不含业务敏感数据。 */
  onDiagnostic?: (event: EysDiagnosticEvent) => void
}

/** 平台 SDK 客户端实例接口 */
export interface PlatformEysClient {
  /** 自定义埋点 */
  track(name: string, props?: Record<string, unknown>): void
  /** 手动上报错误 */
  error(error: unknown, extra?: Record<string, unknown>): void
  /** 上报性能指标 */
  metric(name: string, value: number, props?: Record<string, unknown>): void
  /** 上报行为事件 */
  behavior(name: string, props?: Record<string, unknown>): void
  /** 设置隐私同意状态 */
  setConsent(status: ConsentStatus): void
  /** 启用/禁用 SDK */
  setEnabled(enabled: boolean): void
  /** 设置全局上下文 */
  setContext(context: Record<string, unknown>): void
  /** 添加面包屑 */
  addBreadcrumb(name: string, data?: Record<string, unknown>): void
  /** 开始事务 */
  startTransaction(name: string, context?: Record<string, unknown>): EysTransaction
  /** 页面浏览事件 */
  pageView(path: string, props?: Record<string, unknown>): void
  /** 页面离开事件 */
  pageLeave(path: string, stayTime: number, props?: Record<string, unknown>): void
  /** 标记页面渲染完成 */
  markPageReady(): void
  /** 设置用户信息 */
  setUser(user: EysUser): void
  /** 刷新上报队列 */
  flush(force?: boolean): Promise<void> | void
  /** 销毁实例 */
  destroy(): void
  /** 包装平台原生 Request，自动注入性能埋点 */
  wrapRequest<T extends (options: any) => any>(request?: T, kind?: string): T
  /** 包装平台原生 Fetch，自动注入性能埋点 */
  wrapFetch<T extends (...args: any[]) => Promise<any>>(fetchImpl?: T): T
  /** 对 App 配置做插桩（小程序等平台特有） */
  instrumentApp<T extends Record<string, any>>(config: T): T
  /** 对 Page 配置做插桩（小程序等平台特有） */
  instrumentPage<T extends Record<string, any>>(config: T): T
  /** 获取最近一次采样决策（含规则 / 采样率 / 单元 / 键），用于 SDK 自诊断与调试；无决策时返回 null */
  getSamplingDecision(): SamplingDecision | null
  /** 获取当前平台适配器声明的能力位（P1-4），用于自查 SDK 在宿主环境的可用采集能力 */
  getCapabilities(): PlatformCapabilities
  /** 双 ID 身份：设置已登录用户 ID（appUserId），并与匿名设备 ID 关联；已入队事件回填 userId */
  identify(userId: string, traits?: Record<string, unknown>): void
  /** 获取匿名设备 ID（anonymousId），即设备级稳定标识，与 identify 后的 userId 共同构成双 ID 模型（P2-5） */
  getAnonymousId(): string
}

/** 创建通用平台 SDK 实例（需传入自定义适配器） */
export function createPlatformEys(options: PlatformEysOptions | undefined, adapter: PlatformAdapter): PlatformEysClient
/** 创建微信小程序适配器 */
export function createMiniProgramAdapter(api?: any): PlatformAdapter
/** 创建 UniApp 适配器 */
export function createUniAppAdapter(api?: any): PlatformAdapter
/** 创建 Taro 适配器 */
export function createTaroAdapter(api: any): PlatformAdapter
/** 创建 React Native 适配器 */
export function createReactNativeAdapter(runtime?: Record<string, any>): PlatformAdapter
/** 创建微信小程序 SDK 实例（便捷方法，自动传入适配器） */
export function createMiniProgramEys(options?: PlatformEysOptions, api?: any): PlatformEysClient
/** 创建 UniApp SDK 实例 */
export function createUniAppEys(options?: PlatformEysOptions, api?: any): PlatformEysClient
/** 创建 Taro SDK 实例 */
export function createTaroEys(options?: PlatformEysOptions, api?: any): PlatformEysClient
/** 创建 React Native SDK 实例 */
export function createReactNativeEys(options?: PlatformEysOptions, runtime?: Record<string, any>): PlatformEysClient
