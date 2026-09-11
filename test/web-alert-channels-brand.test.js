/**
 * @file 回归守卫：告警渠道表单默认主题不得引用未定义的品牌名（D4 白标改造遗留）。
 *
 * 背景：apps/web/src/alert-channels.js 的 createAlertChannelForm 曾直接写
 * `${brandName.value} 告警`，但该文件未 import brandName —— 构建期不报错、
 * 运行期在渲染告警中心页面时抛 ReferenceError，导致整块 AlertsPage 白屏。
 *
 * 现方案：alert-channels.js 定义本地 alertSubjectPrefix() 惰性函数，从
 * window.__BRAND__（/brand.js 同步注入）读品牌名并回落内置名。
 * 不再 import useBrand.ts：纯 JS 工具模块依赖 .ts + Vue 响应式会让
 * node --test 原生 ESM 无法解析（无扩展名 .ts 导入，alerting.test.js 连带挂）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const channels = readFileSync(resolve(root, 'apps/web/src/alert-channels.js'), 'utf8')
const useBrand = readFileSync(resolve(root, 'apps/web/src/composables/useBrand.ts'), 'utf8')

test('alert-channels.js 定义惰性 alertSubjectPrefix 且尊重白标品牌', () => {
  // 函数式读取 window.__BRAND__，未启用白标/未注入时回落内置名 'Web Collection'
  assert.match(channels, /function alertSubjectPrefix\(\)/)
  assert.match(channels, /window\.__BRAND__/)
  assert.match(channels, /'Web Collection'/)
  assert.match(channels, /alertSubjectPrefix\(\)/)
})

test('alert-channels.js 不得直接引用 brandName 标识符', () => {
  const body = channels.split('\n').filter(line => !/^\s*(import|\/\/|\*)/.test(line)).join('\n')
  assert.doesNotMatch(body, /\bbrandName\b/)
})

test('useBrand 仍导出 alertSubjectPrefix 供其他消费方复用', () => {
  assert.match(useBrand, /export const alertSubjectPrefix/)
})
