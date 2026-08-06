/**
 * 通过 1x1 GIF 图片发起上报（像素上报 / Beacon fallback）。
 * 适用于不支持 fetch / sendBeacon 的受限环境（如部分旧浏览器或 CSP 策略严格的页面），
 * 利用 Image 请求天然跨域的特性，将事件序列化后拼接到 URL querystring 中发送。
 *
 * 优点：兼容性极好，不会被 CORS 或 CSP 拦截
 * 缺点：仅支持 GET，有 URL 长度限制，无返回值/错误处理（fire-and-forget）
 *
 * @param {object} event - 待上报的单条事件对象
 */
export function imageReport(event) {
  // 创建 1x1 的透明图片，设置 src 即触发 HTTP GET 请求完成上报
  const img = new Image(1, 1)
  img.src = `/api/collect.gif?data=${encodeURIComponent(JSON.stringify(event))}`
}
