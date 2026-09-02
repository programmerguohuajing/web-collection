import type { D1Database } from '@cloudflare/workers-types'
import type { DataSource, ListParams, PagedResult } from './datasource.js'
import { RestDataSource } from './rest.js'
import { D1DataSource } from './d1.js'

export type { DataSource, ListParams, PagedResult }

// 扩展点：未来新增 'postgres' 直连实现时，在这里加 case 即可。
export type DataSourceKind = 'rest' | 'd1' // | 'postgres' (future)

export interface DataSourceOptions {
  kind: DataSourceKind
  baseUrl?: string
  apiKey?: string
  db?: D1Database
  defaultAppId: string
}

export function createDataSource(opts: DataSourceOptions): DataSource {
  switch (opts.kind) {
    case 'd1':
      if (!opts.db) throw new Error('D1DataSource requires a D1 binding (env.DB)')
      return new D1DataSource(opts.db, opts.defaultAppId)
    case 'rest':
    default:
      if (!opts.baseUrl) throw new Error('RestDataSource requires BACKEND_BASE_URL')
      return new RestDataSource(opts.baseUrl, opts.apiKey || '', opts.defaultAppId)
  }
}
