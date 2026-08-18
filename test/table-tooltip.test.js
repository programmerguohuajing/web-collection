import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { tableConfig } from '../apps/web/src/table-tooltip.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

async function vueFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return vueFiles(target)
    return entry.isFile() && entry.name.endsWith('.vue') ? [target] : []
  }))
  return nested.flat()
}

test('全局表格 tooltip 使用固定视口坐标并锚定当前单元格', () => {
  const options = tableConfig.tooltipOptions
  assert.equal(options.appendTo, 'body')
  assert.equal(options.teleported, true)
  assert.equal(options.placement, 'top')
  assert.deepEqual(options.fallbackPlacements, ['bottom'])
  assert.equal(options.offset, 8)
  assert.equal(options.popperClass, 'table-cell-tooltip')
  assert.equal(options.showArrow, false)
  assert.equal(options.popperOptions.strategy, 'fixed')

  const computeStyles = options.popperOptions.modifiers.find(({ name }) => name === 'computeStyles')
  assert.deepEqual(computeStyles?.options, { adaptive: false, gpuAcceleration: false })
  const flip = options.popperOptions.modifiers.find(({ name }) => name === 'flip')
  assert.deepEqual(flip?.options.fallbackPlacements, ['bottom'])
  assert.equal(flip?.options.rootBoundary, 'viewport')
  const preventOverflow = options.popperOptions.modifiers.find(({ name }) => name === 'preventOverflow')
  assert.equal(preventOverflow?.options.rootBoundary, 'viewport')
  assert.equal(preventOverflow?.options.altAxis, true)
})

test('OverflowTip 以真实 DOM 为锚点且只对真实溢出内容启用', async () => {
  const source = await readFile(path.join(repoRoot, 'apps/web/src/components/OverflowTip.vue'), 'utf8')
  assert.match(source, /ref="triggerRef"/)
  assert.match(source, /trigger\.scrollWidth\s*>\s*trigger\.clientWidth\s*\+\s*1/)
  assert.match(source, /popper-class="table-cell-tooltip"/)
  assert.match(source, /:show-arrow="false"/)
  assert.match(source, /:teleported="true"/)
  assert.match(source, /append-to="body"/)
  assert.match(source, /:popper-options="popperOptions"/)
  assert.match(source, /!content \|\| \(!force && !overflowing\)/)
  assert.match(source, /adaptive:\s*false/)
  assert.match(source, /gpuAcceleration:\s*false/)
})

test('所有页面的表格溢出内容统一使用 OverflowTip', async () => {
  const files = await vueFiles(path.join(repoRoot, 'apps/web/src'))
  const sources = await Promise.all(files.map(async (file) => [file, await readFile(file, 'utf8')]))
  const nativeOverflowUsers = sources
    .filter(([, source]) => /<el-table-column\b[^>]*\bshow-overflow-tooltip\b/s.test(source))
    .map(([file]) => path.relative(repoRoot, file))
  assert.deepEqual(nativeOverflowUsers, [], `仍在使用易丢失行锚点的 show-overflow-tooltip: ${nativeOverflowUsers.join(', ')}`)

  const overflowTipUsers = sources
    .filter(([, source]) => /<OverflowTip\b/.test(source))
    .map(([file]) => path.relative(repoRoot, file))
  assert.ok(overflowTipUsers.length >= 9, `OverflowTip 覆盖页面/组件不足，当前仅 ${overflowTipUsers.length} 个`)

  const rawTableTooltips = sources
    .filter(([, source]) => /<el-table[\s\S]*?<el-tooltip\b/.test(source))
    .map(([file]) => path.relative(repoRoot, file))
  assert.deepEqual(rawTableTooltips, [], `表格内仍有未统一定位的 el-tooltip: ${rawTableTooltips.join(', ')}`)
})

test('表格 tooltip 限宽、换行并隐藏系统滚动条按钮', async () => {
  const css = await readFile(path.join(repoRoot, 'apps/web/src/style.css'), 'utf8')
  assert.match(css, /\.cell-ellipsis\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s)
  assert.match(css, /\.table-cell-tooltip\s*\{[^}]*max-width:\s*min\(520px,\s*calc\(100vw\s*-\s*24px\)\);/s)
  assert.match(css, /\.table-cell-tooltip::\-webkit-scrollbar-button\s*\{[^}]*display:\s*none;[^}]*width:\s*0;[^}]*height:\s*0;?\s*\}/s)
})
