/**
 * 通过 1x1 GIF 图片发起上报。
 * 适用于不支持 fetch / sendBeacon 的受限环境（如部分旧浏览器或 CSP 策略严格的页面），
 * 利用 Image 请求天然跨域的特性，将事件序列化后拼接到 URL querystring 中发送。
 *
 * @param {object} event - 待上报的单条事件对象
 */
export function imageReport(event) {
  const img = new Image(1, 1)
  img.src = `/api/collect.gif?data=${encodeURIComponent(JSON.stringify(event))}`
}
