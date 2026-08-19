import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workspaceRoot = new URL('../', import.meta.url)

test('分布式调用树复用项目现有的浅色 Style B 视觉语言', async () => {
  const [tree, node] = await Promise.all([
    readFile(new URL('apps/web/src/components/DistributedTraceTree.vue', workspaceRoot), 'utf8'),
    readFile(new URL('apps/web/src/components/DistributedTraceNode.vue', workspaceRoot), 'utf8')
  ])

  assert.match(tree, /<el-input[\s\S]*<el-radio-group[\s\S]*<el-select/)
  assert.match(tree, /background:\s*#fff;/)
  assert.match(tree, /var\(--line,\s*#dfe5ec\)/)
  assert.match(node, /import \{ ArrowRight \} from '@element-plus\/icons-vue'/)
  assert.match(node, /background:\s*#eef0fe;/)
  assert.match(node, /var\(--c-primary,\s*#4f46e5\)/)
  assert.doesNotMatch(tree, /DISTRIBUTED TRACE|trace-eyebrow|live-dot|radial-gradient|#07111f/i)
  assert.doesNotMatch(node, />CRITICAL<|box-shadow:\s*0\s+0\s+\d+px/i)
})

test('调用树保留层级、时间轴、错误和关键路径信息', async () => {
  const [tree, node] = await Promise.all([
    readFile(new URL('apps/web/src/components/DistributedTraceTree.vue', workspaceRoot), 'utf8'),
    readFile(new URL('apps/web/src/components/DistributedTraceNode.vue', workspaceRoot), 'utf8')
  ])

  assert.match(tree, /role="tree"/)
  assert.match(tree, /class="timeline-scale"/)
  assert.match(tree, /关键路径 \{\{ criticalPath\.length \}\}/)
  assert.match(node, /role="treeitem"/)
  assert.match(node, /class="node-junction"/)
  assert.match(node, /class="duration-bar"/)
  assert.match(node, />关键<\/span>/)
  assert.match(node, />错误<\/span>/)
})
