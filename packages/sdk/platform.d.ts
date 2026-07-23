import type { EysUser } from './index.js'

export interface PlatformContext {
  url?: string
  path?: string
  title?: string
  referrer?: string
  userAgent?: string
}

export interface PlatformAdapter {
  name: string
  rawRequest?: (options: Record<string, unknown>) => unknown
  request(options: { url: string; method: string; headers: Record<string, string>; data: unknown }): Promise<unknown>
  getStorage?(key: string): unknown | Promise<unknown>
  setStorage?(key: string, value: unknown): unknown | Promise<unknown>
  getContext?(): PlatformContext
  onError?(listener: (error: unknown) => void): void | (() => void)
  onUnhandledRejection?(listener: (event: unknown) => void): void | (() => void)
}

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
}

export interface PlatformEysClient {
  track(name: string, props?: Record<string, unknown>): void
  error(error: unknown, extra?: Record<string, unknown>): void
  metric(name: string, value: number, props?: Record<string, unknown>): void
  behavior(name: string, props?: Record<string, unknown>): void
  pageView(path: string, props?: Record<string, unknown>): void
  pageLeave(path: string, stayTime: number, props?: Record<string, unknown>): void
  markPageReady(): void
  setUser(user: EysUser): void
  flush(force?: boolean): Promise<void> | void
  destroy(): void
  wrapRequest<T extends (options: any) => any>(request?: T, kind?: string): T
  wrapFetch<T extends (...args: any[]) => Promise<any>>(fetchImpl?: T): T
  instrumentApp<T extends Record<string, any>>(config: T): T
  instrumentPage<T extends Record<string, any>>(config: T): T
}

export function createPlatformEys(options: PlatformEysOptions | undefined, adapter: PlatformAdapter): PlatformEysClient
export function createMiniProgramAdapter(api?: any): PlatformAdapter
export function createUniAppAdapter(api?: any): PlatformAdapter
export function createTaroAdapter(api: any): PlatformAdapter
export function createReactNativeAdapter(runtime?: Record<string, any>): PlatformAdapter
export function createMiniProgramEys(options?: PlatformEysOptions, api?: any): PlatformEysClient
export function createUniAppEys(options?: PlatformEysOptions, api?: any): PlatformEysClient
export function createTaroEys(options?: PlatformEysOptions, api?: any): PlatformEysClient
export function createReactNativeEys(options?: PlatformEysOptions, runtime?: Record<string, any>): PlatformEysClient
