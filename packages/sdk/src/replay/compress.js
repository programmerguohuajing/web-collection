/**
 * Replay 压缩（SDK-210 · Worker / 压缩 / 预算）。
 *
 * 回放事件体积大，直接 JSON 上报会显著放大带宽与序列化开销。本模块提供三级降级：
 *   1. Worker 压缩：配置 `workerUrl` 且运行环境支持 `Worker` + `CompressionStream` 时，
 *      在 Worker 内完成 gzip，主线程零阻塞（满足 Replay CPU ≤ 3% 预算）。
 *   2. 主线程 CompressionStream：无 Worker 但浏览器支持 `CompressionStream` 时主线程压缩。
 *   3. 同步降级：两者皆不可用时返回 `compression:'none'`（原样 base64 UTF-8），
 *      并 emit `replay_worker_unavailable`（仅一次），保证功能不中断。
 *
 * 压缩结果为 base64 字符串，配合 `compression` 标记随回放 payload 上报；服务端按标记解压。
 */

function hasCompressionStream() {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined'
}

function bytesToBase64(bytes) {
  if (typeof btoa === 'function') {
    let bin = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
    }
    return btoa(bin)
  }
  return Buffer.from(bytes).toString('base64')
}

function base64ToBytes(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

async function gzipBytes(bytes) {
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  writer.write(bytes)
  writer.close()
  const ab = await new Response(cs.readable).arrayBuffer()
  return new Uint8Array(ab)
}

async function gunzipBytes(bytes) {
  const ds = new DecompressionStream('gzip')
  const writer = ds.writable.getWriter()
  writer.write(bytes)
  writer.close()
  const ab = await new Response(ds.readable).arrayBuffer()
  return new Uint8Array(ab)
}

/** 向 Worker 发送一次压缩请求并等待结果（按 id 关联）。 */
function postToWorker(worker, text) {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const onMsg = (e) => {
      const data = e.data || {}
      if (data.id !== id) return
      cleanup()
      if (data.error) reject(new Error(data.error))
      else resolve(data.b64)
    }
    const onErr = (err) => { cleanup(); reject(err) }
    const cleanup = () => {
      worker.removeEventListener('message', onMsg)
      worker.removeEventListener('error', onErr)
    }
    worker.addEventListener('message', onMsg)
    worker.addEventListener('error', onErr)
    worker.postMessage({ id, text })
  })
}

function safeCreateWorker(workerUrl) {
  try {
    if (typeof Worker === 'undefined') return null
    return new Worker(workerUrl, { type: 'module' })
  } catch {
    return null
  }
}

/**
 * 创建回放压缩器。
 * @param {object} [opts]
 * @param {string} [opts.workerUrl] - 压缩 Worker 脚本地址（提供则优先 Worker 压缩）
 * @param {(type:string, detail:object)=>void} [opts.onDiagnostic] - 诊断回调（replay_worker_unavailable 等）
 * @returns {{
 *   compress: (events:object[]) => Promise<{compression:'gzip'|'none', body:string}>,
 *   decompress: (payload:{compression:'gzip'|'none', body:string}) => Promise<object[]>,
 *   destroy: () => void
 * }}
 */
export function createReplayCompressor({ workerUrl, onDiagnostic } = {}) {
  const worker = workerUrl ? safeCreateWorker(workerUrl) : null
  const useWorker = !!worker && hasCompressionStream()
  let warned = false

  const warnUnavailable = (reason) => {
    if (warned) return
    warned = true
    onDiagnostic?.('replay_worker_unavailable', { reason })
  }
  if (!useWorker && !hasCompressionStream()) warnUnavailable(worker ? 'no_compression_stream' : 'no_worker')

  return {
    /**
     * 压缩回放事件数组。
     * @param {object[]} events
     * @returns {Promise<{compression:'gzip'|'none', body:string}>}
     */
    async compress(events) {
      const json = JSON.stringify(events)
      if (useWorker) {
        try {
          const b64 = await postToWorker(worker, json)
          return { compression: 'gzip', body: b64 }
        } catch {
          // Worker 异常回退主线程 / 降级
        }
      }
      if (hasCompressionStream()) {
        const bytes = new TextEncoder().encode(json)
        const gz = await gzipBytes(bytes)
        return { compression: 'gzip', body: bytesToBase64(gz) }
      }
      warnUnavailable('no_compression_stream')
      const bytes = new TextEncoder().encode(json)
      return { compression: 'none', body: bytesToBase64(bytes) }
    },

    /**
     * 解压回放 payload（用于本地自测 / 调试）。
     * @param {{compression:'gzip'|'none', body:string}} payload
     * @returns {Promise<object[]>}
     */
    async decompress(payload) {
      const bytes = base64ToBytes(payload.body)
      if (payload.compression === 'gzip') {
        const out = await gunzipBytes(bytes)
        return JSON.parse(new TextDecoder().decode(out))
      }
      return JSON.parse(new TextDecoder().decode(bytes))
    },

    destroy() {
      worker?.terminate?.()
    }
  }
}

export { hasCompressionStream, bytesToBase64, base64ToBytes }
