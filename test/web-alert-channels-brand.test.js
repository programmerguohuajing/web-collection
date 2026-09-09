/**
 * @file 回归守卫：告警渠道表单默认主题不得引用未导入的 brandName（D4 白标改造遗留）。
 *
 * 背景：apps/web/src/alert-channels.js 的 createAlertChannelForm 曾直接写
 * `${brandName.value} 告警`，但该文件未 import brandName —— 构建期不报错、
 * 运行期在渲染告警中心页面时抛 ReferenceError，导致整块 AlertsPage 白屏。
 * 正确做法是消费 useBrand 单例导出的 alertSubjectPrefix computed。
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

test('alert-channels.js 从 useBrand 导入品牌前缀', () => {
  assert.match(channels, /import\s*\{[^}]*alertSubjectPrefix[^}]*\}\s*from\s*'\.\/composables\/useBrand'/)
})

test('alert-channels.js 不得直接引用 brandName 标识符', () => {
  const body = channels.split('\n').filter(line => !/^\s*import\b/.test(line)).join('\n')
  assert.doesNotMatch(body, /\bbrandName\b/)
})

test('useBrand 导出 alertSubjectPrefix 供告警渠道复用', () => {
  assert.match(useBrand, /export const alertSubjectPrefix/)
})
