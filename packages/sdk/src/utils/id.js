/**
 * 获取或生成唯一标识符（会话 ID / 设备 ID）。
 *
 * 优先从 storage 中复用已有值，避免每次页面加载都产生新 ID。
 * `persistent` 为 true 时使用 localStorage（跨会话持久化，适合 deviceId），
 * 否则使用 sessionStorage（仅当前标签页生命周期，适合 sessionId）。
 * 当 storage 不可用（隐私模式 / 禁用）时降级为随机值。
 *
 * @param {string} key - storage 存储键名
 * @param {boolean} [persistent=false] - 是否跨会话持久化
 * @returns {string} 唯一标识符
 */
export function getId(key, persistent = false) {
  try {
    const store = persistent ? localStorage : sessionStorage
    const old = store.getItem(key)
    if (old) return old
    const id = crypto.randomUUID?.() || `${Date.now()}${Math.random()}`
    store.setItem(key, id)
    return id
  } catch {
    return `${Date.now()}${Math.random()}`
  }
}
