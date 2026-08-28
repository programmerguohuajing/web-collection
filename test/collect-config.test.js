/**
 * PRD 04 远程采集配置——共享匹配逻辑测试。
 *
 * 重点覆盖两个版本维度的独立性（2026-08-28 拆分）：
 * - sdkVersionMax 约束 **SDK 包版本**（context.sdkVersion）
 * - appVersionMax 约束 **接入方应用 release 版本**（context.release）
 * 并验证未声明新字段的存量配置行行为不变（向后兼容）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_COLLECT_CONFIG,
  resolveCollectConfig,
  scopeMatches,
  scopeSpecificity,
  versionLte,
  mergeConfig
} from '../packages/collect-config.js'

const row = (scope, config = {}, configVersion = 1) => ({
  scope_json: scope,
  config_json: config,
  config_version: configVersion
})

// ==================== versionLte ====================

test('versionLte：按点段数值比较，避免字符串错序（0.10.0 > 0.9.0）', () => {
  assert.equal(versionLte('0.9.0', '0.10.0'), true)
  assert.equal(versionLte('0.10.0', '0.9.0'), false)
  assert.equal(versionLte('0.3.0', '0.3.0'), true)
  assert.equal(versionLte('1.0.0', '0.9.9'), false)
  // 注意：预发布标识按点段解析，'0.1.0-alpha.12' → [0,1,0,12]，第四段使其大于 '0.1.0'。
  // 这是既有解析行为（本次拆分未改动），语义上等价于「带预发布号的预览版排在正式版之后」。
  assert.equal(versionLte('0.1.0-alpha.12', '0.1.0'), false)
  assert.equal(versionLte('0.1.0', '0.1.0-alpha.12'), true)
})

// ==================== scopeSpecificity ====================

test('scopeSpecificity：appVersionMax 与 sdkVersionMax 各计权重 2', () => {
  assert.equal(scopeSpecificity({}), 0)
  assert.equal(scopeSpecificity({ appId: 'a' }), 1)
  assert.equal(scopeSpecificity({ platform: 'production' }), 1)
  assert.equal(scopeSpecificity({ sdkVersionMax: '0.3.0' }), 2)
  assert.equal(scopeSpecificity({ appVersionMax: '1.2.0' }), 2)
  assert.equal(scopeSpecificity({ appId: 'a', platform: 'p', sdkVersionMax: '0.3.0', appVersionMax: '1.2.0' }), 6)
})

// ==================== scopeMatches：两个版本维度独立 ====================

test('scopeMatches：sdkVersionMax 只对 context.sdkVersion 生效，不受 release 影响', () => {
  const scope = { sdkVersionMax: '0.3.0' }
  assert.equal(scopeMatches(scope, { sdkVersion: '0.2.9', release: '9.9.9' }), true)
  assert.equal(scopeMatches(scope, { sdkVersion: '0.3.1', release: '1.0.0' }), false)
})

test('scopeMatches：appVersionMax 只对 context.release 生效，不受 sdkVersion 影响', () => {
  const scope = { appVersionMax: '1.2.0' }
  assert.equal(scopeMatches(scope, { release: '1.1.9', sdkVersion: '9.9.9' }), true)
  assert.equal(scopeMatches(scope, { release: '1.2.1', sdkVersion: '0.1.0' }), false)
})

test('scopeMatches：两个版本维度可同时约束，需全部满足', () => {
  const scope = { sdkVersionMax: '0.3.0', appVersionMax: '1.2.0' }
  assert.equal(scopeMatches(scope, { sdkVersion: '0.3.0', release: '1.2.0' }), true)
  assert.equal(scopeMatches(scope, { sdkVersion: '0.3.1', release: '1.2.0' }), false)
  assert.equal(scopeMatches(scope, { sdkVersion: '0.3.0', release: '1.2.1' }), false)
})

test('scopeMatches：维度缺失时按宽松语义命中（空版本视为 0.0.0 ≤ 任意上界）', () => {
  // 与 versionLte 既有语义保持一致：上下文未提供某版本维度时，视为最低版本，
  // 因此带该维度上界的配置仍会命中。这是历史既有行为，拆分维度后不做变更。
  assert.equal(versionLte(undefined, '0.3.0'), true)
  assert.equal(scopeMatches({ appVersionMax: '1.2.0' }, { sdkVersion: '0.3.0' }), true)
  assert.equal(scopeMatches({ sdkVersionMax: '0.3.0' }, { release: '1.0.0' }), true)
  // 但一旦提供了该维度的值，约束即严格生效
  assert.equal(scopeMatches({ appVersionMax: '1.2.0' }, { release: '2.0.0' }), false)
})

// ==================== 向后兼容 ====================

test('向后兼容：未声明 appVersionMax 的存量配置行行为不变', () => {
  const legacy = { appId: 'account-shop-nuxt', sdkVersionMax: '0.3.0' }
  // 存量行里 sdkVersionMax 历史上承载的是应用版本；此处只验证匹配函数语义未被新字段干扰
  assert.equal(scopeMatches(legacy, { appId: 'account-shop-nuxt', sdkVersion: '0.3.0' }), true)
  assert.equal(scopeMatches(legacy, { appId: 'account-shop-nuxt', sdkVersion: '0.4.0' }), false)
  assert.equal(scopeMatches(legacy, { appId: 'other', sdkVersion: '0.3.0' }), false)
  assert.equal(scopeSpecificity(legacy), 3)
})

// ==================== resolveCollectConfig ====================

test('resolveCollectConfig：按 SDK 版本与应用版本分别命中不同配置', () => {
  const rows = [
    row({ sdkVersionMax: '0.3.0' }, { sampling: { error: 0.5 } }, 1),
    row({ appVersionMax: '1.2.0' }, { sampling: { error: 0.25 } }, 2)
  ]
  const bySdk = resolveCollectConfig(rows, { sdkVersion: '0.2.0', release: '9.9.9' })
  assert.equal(bySdk.configVersion, 1)
  assert.equal(bySdk.config.sampling.error, 0.5)

  const byApp = resolveCollectConfig(rows, { sdkVersion: '9.9.9', release: '1.1.0' })
  assert.equal(byApp.configVersion, 2)
  assert.equal(byApp.config.sampling.error, 0.25)
})

test('resolveCollectConfig：双维度约束更具体，优先于单维度', () => {
  const rows = [
    row({ appId: 'app', sdkVersionMax: '0.3.0' }, { sampling: { error: 0.5 } }, 1),
    row({ appId: 'app', sdkVersionMax: '0.3.0', appVersionMax: '1.2.0' }, { sampling: { error: 0.1 } }, 2)
  ]
  const resolved = resolveCollectConfig(rows, { appId: 'app', sdkVersion: '0.2.0', release: '1.0.0' })
  assert.equal(resolved.configVersion, 2, '约束数更多者应胜出')
  assert.equal(resolved.config.sampling.error, 0.1)
})

test('resolveCollectConfig：无命中时返回 null（调用方回退默认配置）', () => {
  const rows = [row({ appId: 'app' }, {}, 1)]
  assert.equal(resolveCollectConfig(rows, { appId: 'other' }), null)
  assert.equal(resolveCollectConfig([], { appId: 'app' }), null)
  assert.equal(resolveCollectConfig(undefined, { appId: 'app' }), null)
})

test('resolveCollectConfig：兼容 scope_json / config_json 为 JSON 字符串的行', () => {
  const rows = [{
    scope_json: JSON.stringify({ appVersionMax: '2.0.0' }),
    config_json: JSON.stringify({ master_switch: 'off' }),
    config_version: 7
  }]
  const resolved = resolveCollectConfig(rows, { release: '1.5.0' })
  assert.equal(resolved.configVersion, 7)
  assert.equal(resolved.config.master_switch, 'off')
})

// ==================== mergeConfig 默认填充 ====================

test('mergeConfig：部分字段配置被默认值补全', () => {
  const merged = mergeConfig({ sampling: { error: 0.5 } })
  assert.equal(merged.sampling.error, 0.5)
  assert.equal(merged.sampling.performance, DEFAULT_COLLECT_CONFIG.sampling.performance)
  assert.equal(merged.master_switch, 'on')
  assert.deepEqual(merged.plugins, DEFAULT_COLLECT_CONFIG.plugins)
})
