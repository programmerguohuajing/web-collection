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
    // 顶栏快速范围默认显示“24 小时”，查询状态也必须保持同一口径。
    // 此前 UI 显示 24h、实际却查询 7d，一次首屏会把 D1 扫描量无声放大约 7 倍。
    range: [Date.now() - 24 * 3600000, Date.now()]
  })
})
