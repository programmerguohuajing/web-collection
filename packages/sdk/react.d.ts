import type { Component, Context, ReactElement, ReactNode } from 'react'
import type { EysClient, EysOptions } from './index.js'

/** SDK 实例 Context（由 WebCollectionProvider 注入）。 */
export const EysContext: Context<EysClient | null>

/** React 根组件 Provider：在应用根挂载一次，初始化 SDK 并通过 Context 下发实例（SSR 安全）。 */
export function WebCollectionProvider(props: {
  /** 与 createEys 一致的配置项 */
  options?: EysOptions
  /** 子组件 */
  children?: ReactNode
}): ReactElement

/** React 错误边界：捕获子树渲染错误并自动上报至 Web Collection（对标 Vue 的 app.config.errorHandler）。 */
export class ErrorBoundary extends Component<{
  /** 子组件 */
  children?: ReactNode
  /** 渲染出错时展示的兜底 UI */
  fallback?: ReactNode
  /** 显式传入 SDK 实例（不传则取 Context） */
  eys?: EysClient
  /** 错误回调 */
  onError?: (error: Error, info: { componentStack?: string }) => void
}> {
  constructor(props: {
    children?: ReactNode
    fallback?: ReactNode
    eys?: EysClient
    onError?: (error: Error, info: { componentStack?: string }) => void
  })
}

/** 获取 SDK 实例（需在 WebCollectionProvider 内使用）；初始化完成前返回 null。 */
export function useWebCollection(): EysClient | null

/** 便捷埋点 Hook：返回稳定的 track 函数（自动绑定当前 SDK 实例）。 */
export function useTrack(): (name: string, props?: Record<string, unknown>) => void

/** 重新导出核心 API。 */
export { createEys } from './index.js'
export type { EysClient, EysOptions } from './index.js'
