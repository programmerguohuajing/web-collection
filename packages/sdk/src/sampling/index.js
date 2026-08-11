/**
 * @fileoverview Sampling 模块入口（路线图 Phase 6 · U06 / SDK-208）
 *
 * 对外导出确定性采样能力：
 * - cyrb53 / foldUnit / hashUnit：确定性哈希原语
 * - DeterministicSampler / createDeterministicSampler：基于 traceId/sessionId 的
 *   一致性采样 + 优先级保留 + 可解释决策
 */

export { cyrb53, foldUnit, hashUnit } from './hash.js'
export { DeterministicSampler, createDeterministicSampler } from './deterministic-sampler.js'
