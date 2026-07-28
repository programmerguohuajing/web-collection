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
    range: []
  })
})
