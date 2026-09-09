import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 环境红线约束测试：
 * 1. 本包源码绝不 import 'electron'（全依赖注入）→ 保持可单测 + main/preload 打包边界干净。
 * 2. 主进程源码绝不出现 Web 全局（window/document/localStorage/navigator/sessionStorage）——
 *    渲染端上下文一律经 globalThis.* 可选链守卫访问（见 preload.js getContext）。
 */

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/([^:'"\\])\/\/[^\n]*/g, '$1')
}

function listJs(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listJs(full))
    else if (name.endsWith('.js')) out.push(full)
  }
  return out
}

const FORBIDDEN = [
  [/from\s+['"]electron['"]/, "import 'electron'（必须依赖注入）"],
  [/require\(\s*['"]electron['"]\s*\)/, "require('electron')（必须依赖注入）"],
  [/\bwindow\./, '裸 window.*（应走 globalThis 或注入）'],
  [/\bdocument\./, '裸 document.*（应走 globalThis 或注入）'],
  [/\blocalStorage\b/, 'localStorage（主进程无此全局）'],
  [/\bsessionStorage\b/, 'sessionStorage（主进程无此全局）'],
  [/\bnavigator\./, '裸 navigator.*（应走 globalThis.navigator?.）'],
  [/\baddEventListener\(/, 'DOM addEventListener（主进程无 DOM）']
]

test('源码不 import electron、不出现 Web 裸全局（注释除外）', () => {
  const files = listJs(srcDir)
  assert.ok(files.length >= 9, `src 文件数异常：${files.length}`)
  const violations = []
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf-8'))
    for (const [pattern, label] of FORBIDDEN) {
      if (pattern.test(code)) violations.push(`${file} → ${label}`)
    }
  }
  assert.deepEqual(violations, [])
})

test('globalThis 守卫访问（preload 渲染端上下文）允许存在', () => {
  const preload = stripComments(readFileSync(join(srcDir, 'preload.js'), 'utf-8'))
  assert.match(preload, /globalThis\.(location|document|navigator)\?/)
})
