/**
 * CSV 导出工具
 *
 * exportCsv(filename, columns, rows)
 * - columns: [{ key: 'fieldName', label: '表头' }]，key 支持点路径如 'user.name'
 * - rows: 数据数组
 * - 自动转义逗号、双引号、换行；加 BOM 以支持 Excel 中文；通过 Blob 下载
 */

function getValue(row, key) {
  if (row == null) return ''
  if (!key.includes('.')) return row[key]
  return key.split('.').reduce((acc, part) => (acc == null ? '' : acc[part]), row)
}

function escapeCell(value) {
  if (value === null || value === undefined) return ''
  const str = String(value)
  // 含逗号、双引号、换行时用双引号包裹，双引号转义为两个双引号
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

export function toCsvText(columns, rows) {
  const header = columns.map(col => escapeCell(col.label)).join(',')
  const lines = (rows || []).map(row =>
    columns.map(col => escapeCell(getValue(row, col.key))).join(',')
  )
  // BOM 让 Excel 正确识别中文
  return '﻿' + [header, ...lines].join('\r\n')
}

export function downloadCsv(filename, csvText) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * 导出 CSV 并下载
 * @param {string} filename 文件名（不含扩展名也可）
 * @param {Array<{key:string,label:string}>} columns 列定义
 * @param {Array} rows 数据行
 * @returns {number} 导出的行数
 */
export function exportCsv(filename, columns, rows) {
  const count = (rows || []).length
  downloadCsv(filename, toCsvText(columns, rows))
  return count
}

/**
 * 分页拉取全量数据（用于"导出全部"）
 * @param {(page:number, pageSize:number)=>Promise<{items:Array,total:number}>} fetchPage
 * @param {number} pageSize 每页大小，默认 1000
 * @returns {Promise<Array>} 全部数据
 */
export async function fetchAllPages(fetchPage, pageSize = 1000) {
  const all = []
  let page = 1
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { items, total } = await fetchPage(page, pageSize)
    if (items && items.length) all.push(...items)
    if (!items || items.length < pageSize || all.length >= total) break
    page += 1
  }
  return all
}
