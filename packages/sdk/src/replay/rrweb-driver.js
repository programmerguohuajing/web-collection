/**
 * Replay 驱动加载器（SDK-209 · 分包与懒加载）。
 *
 * 这是整个 SDK 中**唯一**引用 rrweb 的边界。rrweb 体量较大（gzip ~90KB），
 * 必须避免被静态打进核心包，否则 `replay:false` 的用户也会被迫下载 rrweb。
 *
 * 加载策略（按可用性与构建形态降级）：
 *   1. 全局注入：IIFE 自托管场景，宿主通过 <script> 注入 rrweb，暴露 `window.rrweb`。
 *   2. 动态 import：ESM 构建中 Vite 会把 `import('rrweb')` 拆成独立 chunk，
 *      核心 es 包不包含 rrweb，只有在 replay 真正开启时才按需下载该 chunk。
 *   3. replayLibUrl 注入：IIFE 构建把 rrweb 外部化（external）后，`import('rrweb')`
 *      在浏览器中无法解析，此时回退为注入 `replayLibUrl` 指向的 rrweb IIFE 脚本，
 *      再读取 `window.rrweb`。
 *
 * 三者均失败时抛出可读错误，并附带接入指引（不静默吞掉，便于排查）。
 *
 * @param {object} [opts]
 * @param {string} [opts.replayLibUrl] - IIFE 场景下 rrweb 脚本地址（自托管），可选。
 * @returns {Promise<object>} 解析为包含 `record` 的 rrweb 模块对象。
 */
export async function loadRrweb({ replayLibUrl } = {}) {
  // 1) 全局已注入（IIFE 自托管 / 宿主预加载）
  if (typeof window !== 'undefined' && window.rrweb && window.rrweb.record) {
    return window.rrweb
  }

  // 2) ESM / 支持动态 import 的环境：按需加载 rrweb（核心包不含 rrweb）。
  try {
    const mod = await import('rrweb')
    const rr = mod && mod.record ? mod : mod && mod.default
    if (rr && rr.record) return rr
  } catch (_) {
    // IIFE 构建中 rrweb 被 external 化，`import('rrweb')` 运行时无法解析，走回退。
  }

  // 3) IIFE 自托管：通过 replayLibUrl 注入脚本后再读 window.rrweb。
  if (replayLibUrl) {
    await injectScript(replayLibUrl)
    if (typeof window !== 'undefined' && window.rrweb && window.rrweb.record) {
      return window.rrweb
    }
  }

  throw new Error(
    '[web-collection] replay 已开启但未能加载 rrweb：' +
      'ESM 环境需将 rrweb 作为依赖提供；IIFE 环境需通过 <script> 注入 rrweb（暴露 window.rrweb）' +
      (replayLibUrl ? '' : '，或在 createEys 中配置 replayLibUrl 指向 rrweb 脚本')
  )
}

/**
 * 向文档注入 <script> 并等待其 load / 判定已存在。
 * 重复注入同一 URL 时直接复用，避免重复网络请求。
 * @param {string} src
 * @returns {Promise<void>}
 */
export function injectScript(src) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') return reject(new Error('no document to inject script'))
    const existing = document.querySelector(`script[data-eys-replay-lib="${src}"]`)
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve()
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error(`replayLibUrl load failed: ${src}`)))
      return
    }
    const el = document.createElement('script')
    el.src = src
    el.async = true
    el.dataset.eysReplayLib = src
    el.addEventListener('load', () => {
      el.dataset.loaded = '1'
      resolve()
    })
    el.addEventListener('error', () => reject(new Error(`replayLibUrl load failed: ${src}`)))
    document.head.appendChild(el)
  })
}
