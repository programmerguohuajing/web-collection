/**
 * @file 报表汇总服务
 * 将事件、错误聚合和回放数据组装为仪表盘所需的完整报表。
 * 包含性能 P75 计算、Top API/资源排行、告警生成等逻辑。
 */

import { percentile, scorePerf } from '../utils/domain.js'

/**
 * 构建仪表盘汇总报表。
 *
 * @param {Array} events - 最近事件列表
 * @param {Record<string, object>} issuesById - 以指纹为键的 issue 映射
 * @param {Array} replays - 回放摘要列表
 * @returns {object} 完整报表对象，包含：
 *   - totalEvents / issueCount / regressionCount：核心计数
 *   - perf：各性能指标的 P75 值
 *   - perfScore：性能评分与等级
 *   - byType / behavior：事件类型和行为排行
 *   - api / resources：慢接口和慢资源 Top 10
 *   - alerts：性能和回归告警列表
 *   - issues：错误列表
 */
export function buildSummary(events, issuesById, replays, performanceEvents = events) {
  const perfEvents = performanceEvents.filter(e => e.type === 'perf' && Number.isFinite(Number(e.value)) && !(e.metric === 'page_load' && Number(e.value) <= 0))
  const perfCounts = countBy(perfEvents, 'metric')
  const perf = {}
  for (const metric of ['lcp', 'inp', 'fid', 'cls', 'fcp', 'fp', 'ttfb', 'longtask', 'white_screen', 'blank_screen_rate', 'first_screen', 'route_render', 'data_ready', 'dom_ready', 'page_load', 'js_boot', 'tbt', 'resource_failure_rate', 'slow_api_rate', 'dns', 'tcp', 'tls', 'request', 'download', 'cache_hit_rate', 'redirect', 'redirect_count']) {
    const values = perfEvents.filter(e => e.metric === metric).map(e => Number(e.value))
    const value = metric.endsWith('_rate') && values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : percentile(values, 75)
    if (value !== null) perf[metric] = Number(value.toFixed(metric === 'cls' ? 4 : 0))
  }
  const issues = Object.values(issuesById).sort((a, b) => b.lastSeen - a.lastSeen)
  return {
    totalEvents: events.length,
    issueCount: issues.filter(i => i.status !== 'resolved').length,
    regressionCount: issues.filter(i => i.status === 'regression').length,
    lastSeen: events[0]?.ts || null,
    perf,
    perfCounts,
    perfScore: scorePerf(perf),
    byType: countBy(events, 'type'),
    behavior: countBy(events.filter(e => e.type === 'behavior' || e.type === 'track'), 'name'),
    api: topApi(perfEvents),
    resources: topResources(perfEvents),
    replays,
    alerts: alerts(perf, issues),
    issues
  }
}

/** 按指定字段对事件进行分组计数 */
function countBy(items, field) {
  return items.reduce((acc, item) => {
    const key = item[field] || 'unknown'
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
}

/** 聚合 Fetch/XHR 请求，按 URL 分组统计次数、平均值和 P75，取 Top 10 */
function topApi(events) {
  return aggregate(events.filter(e => e.metric === 'fetch' || e.metric === 'xhr'), e => e.props?.url || e.name || 'unknown')
}

/** 聚合资源加载事件，按资源名称分组统计，取 Top 10 */
function topResources(events) {
  return aggregate(events.filter(e => e.metric === 'resource'), e => e.props?.name || e.name || 'unknown')
}

/**
 * 通用聚合函数：按 keyFn 提取键，统计 count、avg、p75，按 P75 降序取前 10。
 * @param {Array} events - 事件数组
 * @param {Function} keyFn - 提取分组键的函数
 * @returns {Array} 聚合结果数组
 */
function aggregate(events, keyFn) {
  const map = new Map()
  for (const event of events) {
    const key = keyFn(event)
    const item = map.get(key) || { name: key, count: 0, total: 0, p75: 0 }
    item.count++
    item.total += Number(event.value) || 0
    item.values = [...(item.values || []), Number(event.value) || 0]
    map.set(key, item)
  }
  return [...map.values()]
    .map(item => ({ name: item.name, count: item.count, avg: Math.round(item.total / item.count), p75: percentile(item.values, 75) }))
    .sort((a, b) => b.p75 - a.p75)
    .slice(0, 10)
}

/**
 * 生成告警列表。
 * LCP > 4s / INP > 500ms → error 级别
 * CLS > 0.25 / LongTask P75 > 200ms → warning 级别
 * 存在回归错误 → error 级别
 */
function alerts(perf, issues) {
  const list = []
  if (perf.lcp > 4000) list.push({ level: 'error', metric: 'LCP', message: `LCP ${perf.lcp}ms is poor` })
  if (perf.inp > 500) list.push({ level: 'error', metric: 'INP', message: `INP ${perf.inp}ms is poor` })
  if (perf.cls > 0.25) list.push({ level: 'warning', metric: 'CLS', message: `CLS ${perf.cls} is unstable` })
  if (perf.longtask > 200) list.push({ level: 'warning', metric: 'LongTask', message: `Long task P75 ${perf.longtask}ms` })
  const regressions = issues.filter(i => i.status === 'regression').length
  if (regressions) list.push({ level: 'error', metric: 'Regression', message: `${regressions} resolved issue(s) regressed` })
  return list
}
