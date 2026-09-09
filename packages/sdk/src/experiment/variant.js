/**
 * A3 实验分析——SDK 通用消费原语（PRD 14 §4，业务契约不入核）。
 *
 * 范围红线：SDK 不知道「实验/对照组/转化」是什么，只提供两个通用原语——
 * ① 配置化变体消费（稳定分桶）：给定配置块 + 稳定 ID → 稳定变体（packages/experiment-bucket.js 同源实现）；
 * ② 曝光上报：首次命中非空变体时经现有 behavior/exposure 事件通道上报（复用采样与限流，无新增端点）。
 *
 * 失效安全契约（PRD 04 同款）：降级链任一环失败返回 null，业务走默认逻辑，绝不抛错。
 *
 * 降级链（架构 §4.2）：
 * 1. key 非法（非 string / 超 64 字符）→ null
 * 2. 远程配置缺失（getConfig() 为 null，即从未拉到）→ null
 * 3. 配置无 experiments.items 或按 key 查不到 → null
 * 4. bucketingId：deviceId（anonymousId，localStorage 持久）→ 降级 sessionId（sessionStorage）
 * 5. assignVariant 返回 variant:null（未命中流量段）→ null
 */

import { assignVariant } from '../../../experiment-bucket.js'

/**
 * 模块级去重 Map：Map<experimentKey, variant>（会话级内存，不持久化）。
 * 刷新后再次调用 getVariant 会重报一次，由服务端 (experiment_id, visitor_id)
 * 唯一索引兜底去重（双层去重的 SDK 内存层，架构 §4.3）。
 */
const reportedVariants = new Map()

/**
 * 创建 getVariant 通用原语（由 createEys 装配闭包依赖）。
 *
 * @param {object} deps
 * @param {() => object|null} deps.getConfig - 远程配置读取（remoteCtl.getConfig）
 * @param {() => {id: string, kind: 'anonymous'|'session'}} deps.getBucketingId - 分桶 ID 及其来源
 * @param {(event: object) => void} deps.push - 事件入队通道（复用 behavior/exposure 采样与限流）
 * @returns {(key: string) => string|null} getVariant(key)
 */
export function createGetVariant({ getConfig, getBucketingId, push }) {
  return function getVariant(key) {
    try {
      // 1) key 非法
      if (typeof key !== 'string' || !key || key.length > 64) return null
      // 2) 远程配置缺失（从未拉到）
      const config = typeof getConfig === 'function' ? getConfig() : null
      if (!config || typeof config !== 'object') return null
      // 3) 配置无 experiments 块或按 key 查不到
      const items = config.experiments && Array.isArray(config.experiments.items) ? config.experiments.items : []
      const item = items.find(entry => entry && entry.key === key)
      if (!item) return null
      // 4) 分桶 ID：anonymousId 优先，storage 不可用降级 sessionId（由 getBucketingId 决定）
      const bucketing = typeof getBucketingId === 'function' ? getBucketingId() : null
      if (!bucketing || !bucketing.id) return null
      // 5) 一致性分桶（未命中流量段返回 variant:null）
      const { variant } = assignVariant({
        salt: item.salt,
        key: item.key,
        trafficPct: item.traffic_pct,
        variants: item.variants,
        bucketingId: bucketing.id
      })
      if (!variant) return null
      // 内存去重：同一 key 重复调用（含变体相同）只在上报首次命中时发一条 exposure
      if (reportedVariants.get(key) === variant) return variant
      reportedVariants.set(key, variant)
      reportExposure(config, key, variant, bucketing.kind, push)
      return variant
    } catch {
      // 失效安全：任何异常都返回 null，业务走默认逻辑
      return null
    }
  }
}

/**
 * 曝光上报（经现有 behavior/exposure 事件通道，props 带 experiment_key/variant/bucketing）。
 * 前置条件：master_switch !== 'off' 且 plugins.exposure !== false；
 * 被采样率丢弃属平台决策（曝光 cohort 随采样缩小，监控闭环可接受）。
 * 事件自动落入 core/event.js 的 exposure 采样分类与 collect-config 的 plugins.exposure 门控。
 */
function reportExposure(config, experimentKey, variant, bucketingKind, push) {
  try {
    if (config.master_switch === 'off') return
    if (config.plugins && config.plugins.exposure === false) return
    if (typeof push !== 'function') return
    push({
      type: 'behavior',
      name: 'exposure',
      props: {
        experiment_key: String(experimentKey).slice(0, 64),
        variant: String(variant).slice(0, 32),
        bucketing: bucketingKind === 'session' ? 'session' : 'anonymous'
      }
    })
  } catch {
    // 曝光上报失败不影响 getVariant 返回值
  }
}

/** 重置内存去重状态（仅供 SDK 自诊断/测试使用；正常接入方无需调用）。 */
export function resetReportedVariants() {
  reportedVariants.clear()
}
