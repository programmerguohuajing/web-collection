/**
 * 业务错误：带 HTTP 状态码，由全局错误中间件按 4xx 返回 JSON 响应（避免误把"用户输入不合法"当 500）。
 * 不计入服务端日志（中间件已基于 status >= 500 判断）。
 */
export class HttpError extends Error {
  constructor(message, statusCode = 400, code = null) {
    super(message)
    this.name = 'HttpError'
    this.statusCode = statusCode
    this.code = code
  }
}

/** 简洁工厂：throw new HttpError('xxx', 400) 等价 throw badRequest('xxx') */
export const badRequest = (message, code) => new HttpError(message, 400, code)
export const notFound = (message, code) => new HttpError(message, 404, code)
export const conflict = (message, code) => new HttpError(message, 409, code)
