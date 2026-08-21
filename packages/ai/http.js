/**
 * @file HTTP 辅助：json() / cors()（从 Cloudflare worker.js 抽取，ai-worker 与主 worker 共享）
 */
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })

export function cors(response, request) {
  const r = new Response(response.body, response)
  const origin = request.headers.get('origin')
  r.headers.set('access-control-allow-origin', origin || '*')
  if (origin) { r.headers.set('access-control-allow-credentials', 'true'); r.headers.append('vary', 'Origin') }
  r.headers.set('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS')
  r.headers.set('access-control-allow-headers', 'content-type,x-app-key,x-ai-key,traceparent')
  return r
}
