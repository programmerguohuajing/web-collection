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
  r.headers.set('access-control-allow-methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS')
  const reqHeaders = request.headers.get('access-control-request-headers')
  r.headers.set('access-control-allow-headers', reqHeaders || 'content-type,authorization,x-app-key,x-collect-key,x-team-id,x-ai-key,x-sdk-version,x-sdk-name,x-eys-raw-access,traceparent,tracestate,baggage,if-none-match,if-match,if-modified-since,if-unmodified-since')
  r.headers.set('access-control-expose-headers', 'server-timing,traceresponse,x-request-id')
  return r
}
