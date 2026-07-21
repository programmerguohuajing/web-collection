export type EventType = 'track' | 'perf' | 'performance' | 'behavior' | 'error' | 'replay'

export interface EysUser {
  id?: string
  name?: string
  phone?: string
  userId?: string
  userName?: string
  userPhone?: string
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
  requests?: boolean
  exposure?: boolean
  replay?: boolean
  replaySegmentByRoute?: boolean
  replayMaxDuration?: number
  replayBatchSize?: number
  replayOptions?: Record<string, unknown>
}

export interface EysClient {
  track(name: string, props?: Record<string, unknown>): void
  error(error: unknown, extra?: Record<string, unknown>): void
  metric(name: string, value: number, props?: Record<string, unknown>): void
  setUser(user: EysUser): void
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
