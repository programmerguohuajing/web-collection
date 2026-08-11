/**
 * Replay 压缩 Worker（SDK-210）。
 *
 * 在 Worker 线程内完成 gzip 压缩，主线程零阻塞，满足 Replay 运行主线程额外开销预算
 * （P95 CPU ≤ 3%）。由 `createReplayCompressor({ workerUrl })` 加载，宿主需通过
 * `replayWorkerUrl` 配置指向本 Worker 的构建产物。
 *
 * 消息协议：
 *   in:  { id: string, text: string }   —— text 为待压缩的 JSON 字符串
 *   out: { id: string, b64: string }    —— 成功，b64 为 gzip 后的 base64
 *        { id: string, error: string }  —— 失败
 */
self.onmessage = async (e) => {
  const { id, text } = (e && e.data) || {}
  if (!id || typeof text !== 'string') return
  try {
    const cs = new CompressionStream('gzip')
    const writer = cs.writable.getWriter()
    writer.write(new TextEncoder().encode(text))
    writer.close()
    const ab = await new Response(cs.readable).arrayBuffer()
    const bytes = new Uint8Array(ab)
    let bin = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
    }
    self.postMessage({ id, b64: btoa(bin) })
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) })
  }
}
