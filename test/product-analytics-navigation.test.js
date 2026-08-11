import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workspaceRoot = new URL('../', import.meta.url)

test('当前布局提供产品分析入口，路由和漏斗分析页签保持可用', async () => {
  const [layout, router, analytics] = await Promise.all([
    readFile(new URL('apps/web/src/layout/index.vue', workspaceRoot), 'utf8'),
    readFile(new URL('apps/web/src/router/index.js', workspaceRoot), 'utf8'),
    readFile(new URL('apps/web/src/views/monitor/analytics/index.vue', workspaceRoot), 'utf8')
  ])

  assert.match(router, /import Layout from ['"]\.\.\/layout\/index\.vue['"]/, '路由必须使用当前布局')
  assert.match(
    layout,
    /label:\s*['"]洞察['"][\s\S]*?title:\s*['"]产品分析['"],\s*path:\s*['"]\/analytics['"],\s*icon:\s*DataAnalysis/,
    '洞察分组必须提供产品分析入口'
  )
  assert.match(
    router,
    /path:\s*['"]analytics['"][\s\S]*?title:\s*['"]产品分析['"]/,
    '产品分析菜单必须对应可访问的路由'
  )
  assert.match(
    analytics,
    /label=['"]漏斗分析['"]\s+name=['"]funnels['"]/,
    '产品分析页面必须保留漏斗分析页签'
  )
})
