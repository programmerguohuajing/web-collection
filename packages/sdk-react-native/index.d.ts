/**
 * Type definitions for @web-collection/sdk-react-native
 */

/** 宿主注入的运行时能力对象（全部可选，缺失即降级）。 */
export interface RnRuntime {
  fetch?: typeof fetch
  storage?: {
    getItem(key: string): any
    setItem(key: string, value: string): any
    removeItem?(key: string): any
  }
  appState?: { addEventListener(type: string, cb: (state: string) => void): any }
  errorUtils?: { setGlobalHandler(h: Function): void; getGlobalHandler?(): Function | null }
  hermes?: { enablePromiseRejectionTracker(opts: object): void }
  netInfo?: { addEventListener(type: string, cb: (state: any) => void): any; fetch?(): Promise<any> }
  nativeCrash?: { getPending?(): Promise<any>; clear?(): Promise<void> }
  frameCallback?: (cb: (ts: number) => void) => () => void
  deviceInfo?: object | (() => object)
  getContext?: () => object
  version?: string
  routeName?: string
  onError?: Function
  onUnhandledRejection?: Function
  onNetworkStatusChange?: Function
  onNavigationStateChange?: Function
  [key: string]: any
}

/** 用户选项（移动端默认值已在包内覆盖，详见 PRD）。 */
export interface RnOptions {
  endpoint?: string
  appId?: string
  release?: string
  collectKey?: string
  environment?: string
  userId?: string
  enabled?: boolean
  consent?: 'granted' | 'denied'
  sampleRate?: number
  batchSize?: number
  flushInterval?: number
  maxQueue?: number
  sessionTimeoutMs?: number
  coldStartTimeoutMs?: number
  coldStart?: { enabled?: boolean }
  frameStats?: {
    enabled?: boolean
    sampleWindowMs?: number
    reportIntervalMs?: number
    fpsTarget?: number
    longTaskThresholdMs?: number
  }
  network?: { enabled?: boolean; autoWrapGlobalFetch?: boolean }
  crash?: { js?: boolean; rejection?: boolean; native?: boolean }
  deviceInfo?: object | null
  beforeSend?: ((item: any) => any) | null
  onDiagnostic?: ((event: { name: string; ts: number; [k: string]: any }) => void) | null
  [key: string]: any
}

/** React Native 客户端（内核直通 + RN 扩展）。 */
export interface ReactNativeEysClient {
  track(name: string, props?: object): void
  error(reason: unknown, extra?: object): void
  metric(name: string, value: number, props?: object): void
  behavior(name: string, props?: object): void
  setConsent(status: string): void
  setEnabled(enabled: boolean): void
  setContext(context: object): void
  addBreadcrumb(crumb: object): void
  startTransaction(name: string, options?: object): void
  pageView(path: string, options?: object): void
  pageLeave(path: string, options?: object): void
  markPageReady(): void
  setUser(user: object): void
  flush(force?: boolean): void | Promise<void>
  wrapRequest(impl?: Function): Function
  wrapFetch(impl?: Function): Function
  instrumentApp(options?: object): void
  instrumentPage(options?: object): void
  getPrivacyMode(): string
  getConsentCategories(): object
  getSamplingDecision(): object | null
  getCapabilities(): object
  identify(userId: string, traits?: object): void
  getAnonymousId(): string
  /** RN 扩展：显式校正冷启动终点（优先于首帧/超时）。 */
  markAppReady(): boolean
  /** RN 扩展：上报原生崩溃（占位通道，需 crash.native=true 且桥接就绪）。 */
  reportNativeCrash(payload?: object): boolean
  start(): void
  stop(): void
  destroy(): void
}

/**
 * 创建 React Native 客户端。
 * @param options 用户选项
 * @param runtime 宿主能力注入
 */
export function createReactNativeEys(options?: RnOptions, runtime?: RnRuntime): ReactNativeEysClient

/** createReactNativeEys 的别名。 */
export function createEysRN(options?: RnOptions, runtime?: RnRuntime): ReactNativeEysClient

/**
 * 可注入内核的装配函数（测试友好）。
 * @internal
 */
export function createReactNativeEysWithCore(
  options?: RnOptions,
  runtime?: RnRuntime,
  core?: any,
  moduleInitTs?: number
): ReactNativeEysClient

export default createReactNativeEys
