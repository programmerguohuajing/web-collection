/**
 * @file 静态扫描：src/** 不得出现浏览器全局 / react-native 直接 import
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(__dirname, '../src')

const FORBIDDEN = ['window.', 'document.', 'localStorage', 'sessionStorage', 'XMLHttpRequest', 'navigator.sendBeacon']
const REACT_NATIVE_IMPORT = /from\s+['"]react-native['"]|require\(\s*['"]react-native['"]\s*\)/

/** 去除行注释与块注释，避免约束说明性注释触发误报。 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function listJs(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) listJs(p, acc)
    else if (p.endsWith('.js')) acc.push(p)
  }
  return acc
}

const files = listJs(srcDir)

test('src 不含浏览器全局引用', () => {
  for (const f of files) {
    const code = stripComments(fs.readFileSync(f, 'utf8'))
    for (const tok of FORBIDDEN) {
      assert.ok(!code.includes(tok), `${path.relative(srcDir, f)} 含禁用标记 ${tok}`)
    }
  }
})

test('除 react.js 外不得 import react-native', () => {
  for (const f of files) {
    if (f.endsWith('react.js')) continue
    const code = stripComments(fs.readFileSync(f, 'utf8'))
    assert.ok(!REACT_NATIVE_IMPORT.test(code), `${path.relative(srcDir, f)} 不应 import react-native`)
  }
})
