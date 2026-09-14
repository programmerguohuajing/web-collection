/**
 * @file 回归守卫：产品分析页「事件分析」Tab 只在部署真实支持时渲染。
 *
 * 背景：该 Tab 原先写成 `<el-tab-pane :disabled="!insightsSupported">`，
 * 而 Cloudflare Worker 部署没有 /api/analytics/insights 端点，
 * packages/deployment-capabilities.js 的 WORKER_CAPABILITIES.insights 恒为 false，
 * 于是生产环境永远呈现一个「看得见、点不动」的禁用 Tab。
 *
 * 现方案（产品决定）：不支持时不渲染 —— `v-if="insightsSupported"`。
 * 自托管 Node 部署 NODE_CAPABILITIES.insights 为 true，入口照常可用，功能不丢。
 *
 * 另外必须拦住深链 `?tab=insights`：capabilities 是异步加载的，
 * 若不校验就直接写进 el-tabs 的 v-model，不支持的部署会出现「无选中 Tab」的空态。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const analytics = readFileSync(resolve(root, 'apps/web/src/views/monitor/analytics/index.vue'), 'utf8')

test('事件分析 Tab 用 v-if 门禁，不得再出现 :disabled 写法', () => {
  assert.match(analytics, /<el-tab-pane v-if="insightsSupported" label="事件分析" name="insights">/)
  assert.doesNotMatch(analytics, /:disabled="!insightsSupported"/)
})

test('EventInsightPanel 只在受门禁的 Tab 内挂载', () => {
  const gatedPane = analytics.match(/<el-tab-pane v-if="insightsSupported"[\s\S]*?<\/el-tab-pane>/)
  assert.ok(gatedPane, '未找到受 insightsSupported 门禁的 Tab 面板')
  assert.match(gatedPane[0], /<EventInsightPanel\b/)
})

test('深链 ?tab 需经 resolveTab 过滤掉不支持的事件分析', () => {
  assert.match(analytics, /function resolveTab\(name\)/)
  assert.match(analytics, /name === 'insights' && !insightsSupported\.value \? '' : name/)
  // 必须同时监听 insightsSupported：capabilities 异步到位后自托管部署才认这个深链
  assert.match(analytics, /watch\(\[\(\) => route\.query\.tab, insightsSupported\]/)
})

test('el-tabs 的 v-model 名必须都在允许集合内', () => {
  const names = [...analytics.matchAll(/<el-tab-pane[^>]*name="([^"]+)"/g)].map(m => m[1])
  const allowed = analytics.match(/const TAB_NAMES = \[([^\]]+)\]/)
  assert.ok(allowed, '未找到 TAB_NAMES 白名单')
  for (const name of names) {
    assert.ok(allowed[1].includes(`'${name}'`), `Tab 名 ${name} 不在 TAB_NAMES 白名单内`)
  }
})
