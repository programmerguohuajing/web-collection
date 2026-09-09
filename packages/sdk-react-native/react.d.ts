/**
 * Type definitions for @web-collection/sdk-react-native/react
 */
import type { ReactNode } from 'react'
import type { ReactNativeEysClient, RnOptions, RnRuntime } from './index.d.ts'

export interface EysProviderProps {
  options?: RnOptions
  runtime?: RnRuntime
  client?: ReactNativeEysClient | null
  children?: ReactNode
}

/** 在子树内提供 React Native 客户端实例。 */
export function EysProvider(props: EysProviderProps): any

/** 取当前客户端实例（未初始化时为 null）。 */
export function useWebCollection(): ReactNativeEysClient | null

/** 稳定的 track 包装。 */
export function useTrack(): (name: string, props?: object) => void

export default EysProvider
