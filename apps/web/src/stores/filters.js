import { defineStore } from 'pinia'

/**
 * 顶部条件切换的全局状态（应用 / 版本 / 时间范围）。
 * 通过 Pinia 管理，不再写入地址栏参数；跨页面共享，
 * 是全局筛选上下文的唯一来源。
 */

/**
 * 顶部时间范围预设：value 为小时数（字符串），'' 表示全部时间，'custom' 表示自定义区间。
 * 预设与 `rangeLabel` getter 同源，顶部选择器与各页「沿用全局筛选」提示共用，
 * 避免出现「顶部显示最近24小时、页面提示近 1 天」这类口径漂移。
 */
export const RANGE_PRESETS = [
  { label: '最近1小时', value: '1' },
  { label: '今日', value: 'today' },
  { label: '最近12小时', value: '12' },
  { label: '最近24小时', value: '24' },
  { label: '最近7天', value: '168' },
  { label: '最近30天', value: '720' },
  { label: '最近90天', value: '2160' },
  { label: '全部时间', value: '' },
  { label: '自定义', value: 'custom' }
]

/**
 * 根据预设标识计算当前时间范围 [startTimeMs, endTimeMs]。
 * - 'today': 当天 00:00:00 到当前时间
 * - '': 全部时间 []
 * - 'custom': 由外部自定义区间决定，此处返回 null
 * - 其他数值字符串 (如 '1', '12', '24', '168'): [now - hours * 3600000, now]
 */
export function rangeFromPreset(preset, now = Date.now()) {
  if (preset === 'custom') return null
  if (preset === '' || preset == null) return []
  if (preset === 'today') {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    return [start.getTime(), now]
  }
  const hours = Number(preset)
  if (Number.isFinite(hours) && hours > 0) {
    return [now - hours * 3600000, now]
  }
  return []
}

/** 时间戳 → `YYYY-MM-DD HH:mm`（本地时区），用于自定义区间的可读描述。 */
function formatRangeTime(ms) {
  const date = new Date(Number(ms))
  if (Number.isNaN(date.getTime())) return '-'
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export const useFilterStore = defineStore('filters', {
  state: () => ({
    appId: '',
    release: '',
    // 采集环境（prod/staging/trial/dev）。默认空：不写死“生产环境”，
    // 后续由全局上下文从真实应用配置或聚合查询填充；为空时顶栏不展示环境药丸。
    environment: '',
    // 顶栏时间预设（'1'|'24'|'168'|'720'|'2160'|''|'custom'）。
    // 与 range 保持同一口径：预设决定 range 的实际窗口，两者共同构成唯一时间上下文。
    // 顶栏快速范围默认显示“24 小时”，查询状态也必须保持同一口径。
    // 此前 UI 显示 24h、实际却查询 7d，一次首屏会把 D1 扫描量无声放大约 7 倍。
    rangePreset: '24',
    // 实际查询窗口 [startMs, endMs]；空数组表示「全部时间」。
    range: [Date.now() - 24 * 3600000, Date.now()]
  }),
  getters: {
    /**
     * 当前时间范围的可读描述，与顶部选择器同源、口径一致。
     * 预设直接回显预设名（如“最近24小时”）；自定义回显具体区间。
     */
    rangeLabel(state) {
      if (state.rangePreset === 'custom') {
        const [start, end] = state.range || []
        if (!start || !end) return '自定义时间'
        return `${formatRangeTime(start)} ~ ${formatRangeTime(end)}`
      }
      const preset = RANGE_PRESETS.find(item => item.value === state.rangePreset)
      return preset ? preset.label : '全部时间'
    }
  }
})
