/**
 * 提取 DOM 元素的可读信息，用于行为采集和曝光采集。
 * 收集标签名、id、className（截断 160 字符）、文本内容（截断 120 字符），
 * 以及所有 `data-track-*` 自定义属性（去掉前缀后作为键）。
 *
 * @param {Element} el - 目标 DOM 元素
 * @returns {object} 元素信息对象
 */
export function elementInfo(el) {
  const text = readableText(el)
  const props = {
    tag: el.tagName,
    id: el.id || '',
    className: String(el.className || '').slice(0, 160),
    text: clip(text, 120),
    ariaLabel: clip(el.getAttribute?.('aria-label') || '', 120),
    alt: clip(el.getAttribute?.('alt') || '', 120),
    title: clip(el.getAttribute?.('title') || '', 120),
    placeholder: clip(el.getAttribute?.('placeholder') || '', 120),
    role: clip(el.getAttribute?.('role') || '', 40),
    type: clip(el.getAttribute?.('type') || '', 40),
    name: clip(el.getAttribute?.('name') || '', 80),
    href: clip(el.getAttribute?.('href') || '', 200)
  }
  for (const item of el.attributes || []) {
    if (item.name.startsWith('data-track-')) props[item.name.slice(11)] = item.value
  }
  props.label = props.text || props.ariaLabel || props.alt || props.title || props.placeholder || props.name || props.id || ''
  return props
}

function readableText(el) {
  const ownText = (el.innerText || el.textContent || '').trim()
  if (ownText) return ownText
  const label = el.closest?.('label') || (el.id ? el.ownerDocument?.querySelector?.(`label[for="${cssEscape(el.id)}"]`) : null)
  return (label?.innerText || label?.textContent || '').trim()
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&')
}

/**
 * 字符串裁剪工具，将任意值转为字符串后截取前 size 个字符。
 *
 * @param {*} value - 待裁剪的值
 * @param {number} size - 最大长度
 * @returns {string} 裁剪后的字符串
 */
export function clip(value, size) {
  return String(value).slice(0, size)
}
