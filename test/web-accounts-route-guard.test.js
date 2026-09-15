/**
 * @file 回归守卫：D2 账号体系全站登录接入（路由守卫 + 登录页完整可用）。
 *
 * 背景：后端 auth 端点（/api/auth/*、/api/me）两端均已实现，但前端存在三处断点——
 * ① router 无 beforeEach 守卫，accounts 开启后仍可匿名浏览全部页面；
 * ② 登录页模板使用 brandName/brandShortName/brandSubtitle 但从未 import（script setup
 *    无全局注入），页头品牌区渲染空白；
 * ③ 守卫重定向携带的 ?redirect= 原目标在登录完成后不被消费，回跳断链。
 *
 * 本测试用源码断言锁定三处修复（与 web-analytics-insights-tab.test.js 同范式）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const router = readFileSync(resolve(root, 'apps/web/src/router/index.js'), 'utf8')
const login = readFileSync(resolve(root, 'apps/web/src/views/login/index.vue'), 'utf8')

test('router 必须注册 beforeEach 登录守卫并消费 accounts 能力位', () => {
  assert.match(router, /router\.beforeEach\(async \(to\) =>/)
  assert.match(router, /accountsEnabled\.value/)
})

test('守卫必须放行公开路由：登录页与看板分享嵌入页', () => {
  assert.match(router, /PUBLIC_PATHS = new Set\(\['\/login'\]\)/)
  assert.match(router, /PUBLIC_PREFIXES = \['\/embed\/'\]/)
})

test('守卫必须携带 ?redirect= 原目标，且仅在令牌确定失效（401）时踢回登录页', () => {
  assert.match(router, /redirect: to\.fullPath/)
  assert.match(router, /err\?\.status === 401/)
})

test('登录页必须显式导入并解构品牌字段（script setup 无全局注入）', () => {
  assert.match(login, /import \{ useBrand \} from '\.\.\/\.\.\/composables\/useBrand'/)
  assert.match(login, /\{ brandName, brandShortName, brandSubtitle \} = useBrand\(\)/)
})

test('登录页 goAway 必须消费 ?redirect= 且拒绝开放重定向', () => {
  assert.match(login, /route\.query\.redirect/)
  assert.match(login, /redirect\.startsWith\('\/'\) && !redirect\.startsWith\('\/\/'\)/)
})
