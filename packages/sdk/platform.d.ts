import type { CaptureCategory, ConsentStatus, EysPrivacyOptions, EysTransaction, EysUser } from './index.js'

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
  collectKey?: string
  enabled?: boolean
  consent?: ConsentStatus
  environment?: string
  categorySampleRates?: Partial<Record<CaptureCategory, number>>
  beforeSend?: (event: Record<string, unknown>) => Record<string, unknown> | false
  privacy?: EysPrivacyOptions
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
