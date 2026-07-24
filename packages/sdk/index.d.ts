export type EventType = 'track' | 'perf' | 'performance' | 'behavior' | 'error' | 'replay' | 'log' | 'trace'

export interface EysUser {
  id?: string
  name?: string
  phone?: string
  userId?: string
  userName?: string
  userPhone?: string
}

export type ConsentStatus = 'granted' | 'denied'
export type CaptureCategory = 'error' | 'performance' | 'requests' | 'behavior' | 'exposure' | 'replay'
export interface EysPrivacyOptions {
  redactKeys?: string[]
  blockSelectors?: string[]
  maskSelectors?: string[]
  requestAllowlist?: string[]
}
export interface EysTransaction {
  setData(data: Record<string, unknown>): void
  finish(result?: Record<string, unknown>): void
}

export interface EysOptions {
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
  behavior?: boolean
  console?: boolean
  consoleLevels?: Array<'log' | 'info' | 'warn' | 'error'>
  collectKey?: string
  tracing?: boolean
  traceOrigins?: string[]
  requests?: boolean
  exposure?: boolean
  replay?: boolean
  replaySegmentByRoute?: boolean
  replayMaxDuration?: number
  replayBatchSize?: number
  replayOptions?: Record<string, unknown>
  whiteScreenSelector?: string
  whiteScreenTimeout?: number
  enabled?: boolean
  consent?: ConsentStatus
  environment?: string
  categorySampleRates?: Partial<Record<CaptureCategory, number>>
  beforeSend?: (event: Record<string, unknown>) => Record<string, unknown> | false
  privacy?: EysPrivacyOptions
  formTracking?: boolean
  rageClick?: boolean
  deadClick?: boolean
  interactionTracking?: boolean
}

export interface EysClient {
  track(name: string, props?: Record<string, unknown>): void
  error(error: unknown, extra?: Record<string, unknown>): void
  metric(name: string, value: number, props?: Record<string, unknown>): void
  log(level: 'log' | 'info' | 'warn' | 'error' | string, message: unknown, props?: Record<string, unknown>): void
  setUser(user: EysUser): void
  setConsent(status: ConsentStatus): void
  setEnabled(enabled: boolean): void
  setContext(context: Record<string, unknown>): void
  addBreadcrumb(name: string, data?: Record<string, unknown>): void
  startTransaction(name: string, context?: Record<string, unknown>): EysTransaction
  markPageReady(): void
  flush(force?: boolean): Promise<void> | void
  destroy(): void
  startReplay(): void
  stopReplay(): void
  flushReplay(force?: boolean): void
  addReplayEvent(name: string, props?: Record<string, unknown>): void
  takeReplaySnapshot(): void
  endReplaySegment(reason: 'error' | 'route' | 'max_duration' | 'page_unload' | string): void
}

export function createEys(options?: EysOptions): EysClient

export function install(
  app: {
    config: {
      errorHandler?: (err: unknown, instance: unknown, info: string) => void
      globalProperties: Record<string, unknown>
    }
  },
  options?: EysOptions
): void

declare const WebCollection: {
  createEys: typeof createEys
  install: typeof install
}

export default WebCollection

declare global {
  interface Window {
    WebCollection?: typeof WebCollection
  }
}
