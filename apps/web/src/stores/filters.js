import { defineStore } from 'pinia'

/**
 * 顶部条件切换的全局状态（应用 / 版本 / 时间范围）。
 * 通过 Pinia 管理，不再写入地址栏参数；跨页面共享，
 * 是全局筛选上下文的唯一来源。
 */
export const useFilterStore = defineStore('filters', {
  state: () => ({
    appId: '',
    release: '',
    // 采集环境（prod/staging/trial/dev）。默认空：不写死“生产环境”，
    // 后续由全局上下文从真实应用配置或聚合查询填充；为空时顶栏不展示环境药丸。
    environment: '',
    range: []
  })
})
