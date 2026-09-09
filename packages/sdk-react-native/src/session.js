/**
 * @file 会话管理（RN 层自维护会话 ID + 后台超时切分）
 *
 * 背景（架构 A16 / §3.4）：内核 sessionId 为实例内常量且无 setter（core.js:79），
 * 而移动端需要「切后台超过阈值再回前台 → 新会话」，因此 RN 层自维护 ID 并通过 beforeSend 覆盖。
 * ID 生成风格与内核一致：优先 crypto.randomUUID，降级时间戳 + 随机。
 */

/** 生成唯一 ID（优先 crypto.randomUUID，降级时间戳 + 随机数）。 */
function newId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  } catch {
    // 某些宿主 crypto.randomUUID 存在但调用抛错，降级处理。
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

/**
 * 创建会话管理器。
 * @param {{ timeoutMs?: number, now?: () => number }} [options={}]
 * @returns {{
 *   currentId: () => string,
 *   start: (now?: number) => string,
 *   markBackground: (now?: number) => void,
 *   onForeground: (now?: number, timeoutMs?: number) => { id: string, rotated: boolean, elapsedMs: number },
 *   maybeRotate: (now?: number, timeoutMs?: number) => boolean,
 *   elapsedSinceBackground: (now?: number) => number,
 *   startedAt: () => number
 * }}
 */
export function createSessionManager(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 30000
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now()

  let id = newId()
  let startedAt = nowFn()
  let lastBackgroundAt = 0

  /** 开启新会话（冷启动或超时恢复）。 */
  function start(now = nowFn()) {
    id = newId()
    startedAt = now
    lastBackgroundAt = 0
    return id
  }

  /** 标记进入后台（记录时刻，供回前台计算后台时长）。 */
  function markBackground(now = nowFn()) {
    lastBackgroundAt = now
  }

  /**
   * 回到前台：判定是否需要旋转会话。
   * @param {number} [now]
   * @param {number} [threshold=timeoutMs]
   * @returns {{ id: string, rotated: boolean, elapsedMs: number }}
   */
  function onForeground(now = nowFn(), threshold = timeoutMs) {
    const elapsedMs = lastBackgroundAt ? Math.max(0, now - lastBackgroundAt) : 0
    const rotated = lastBackgroundAt > 0 && elapsedMs >= threshold
    if (rotated) {
      id = newId()
      startedAt = now
    }
    lastBackgroundAt = 0
    return { id, rotated, elapsedMs }
  }

  /**
   * 仅判定是否应旋转（不重置后台时刻）。
   * @param {number} [now]
   * @param {number} [threshold=timeoutMs]
   */
  function maybeRotate(now = nowFn(), threshold = timeoutMs) {
    return lastBackgroundAt > 0 && now - lastBackgroundAt >= threshold
  }

  return {
    currentId: () => id,
    start,
    markBackground,
    onForeground,
    maybeRotate,
    elapsedSinceBackground: (now = nowFn()) => (lastBackgroundAt ? Math.max(0, now - lastBackgroundAt) : 0),
    startedAt: () => startedAt
  }
}
