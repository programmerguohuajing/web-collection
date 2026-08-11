# W3C 标准链路传播与跨域 CORS 配置

本文档说明 Web Collection SDK 的分布式追踪传播机制（对应路线图 Phase 3 · U03 / SDK-205），
以及前端跨域注入链路头时，目标服务端必须配置的 CORS 响应头。

## 1. 传播的三个标准 Header

SDK 在**同源**或**命中 `traceOrigins` 白名单**的请求上注入以下 W3C 标准 Header：

| Header | 规范 | 说明 |
|---|---|---|
| `traceparent` | [W3C Trace Context](https://www.w3.org/TR/trace-context/) | 主传播字段，格式 `00-<traceId>-<spanId>-<flags>` |
| `tracestate` | [W3C Trace Context](https://www.w3.org/TR/trace-context/) | 跨厂商状态透传，已做规范化（trim / 去空 member / 512 上限截断） |
| `baggage` | [W3C Baggage](https://www.w3.org/TR/baggage/) | 业务属性透传，**标准单一 Header**，格式 `key1=value1,key2=value2`（值 URL 编码） |

> ⚠️ 历史版本使用自定义的多 Header 形式 `baggage-<key>: <value>`，**已废弃**。
> 当前版本注入统一为标准 `baggage` 单一 Header；提取侧仍向后兼容旧 `baggage-*` 多个头，
> 便于服务端平滑过渡。

采用标准 Header 后，SDK 可直接与 **OpenTelemetry、Elastic APM、Grafana Faro** 等
支持 W3C Trace Context / Baggage 的后端互通，无需任何自定义解析。

## 2. traceOrigins 匹配规则

`traceOrigins` 控制**跨域**请求是否注入链路头（同源请求永远注入）。

支持三种规则形态：

```js
import { createEys } from '@web-collection/sdk'

createEys({
  tracing: true,
  // 精确字符串：仅匹配该 origin
  traceOrigins: [
    'https://api.example.com',
    // 正则：匹配整个子域
    /^https:\/\/.*\.example\.com$/,
    // 函数：自定义逻辑，接收 origin 返回 boolean
    (origin) => origin.endsWith('.internal.example.com')
  ]
})
```

| 规则类型 | 行为 |
|---|---|
| `string` | 与请求 origin **精确相等** |
| `RegExp` | 用正则 `.test(origin)` 匹配 |
| `function` | 接收 `origin` 字符串，返回 `true`/`false` |

非法 URL 或规则类型不匹配时一律拒绝注入 —— 即使配置错误，也**不会**向任意第三方域泄露 baggage。

## 3. 跨域 CORS 必需配置（重要）

浏览器对跨域请求的自定义请求头有 CORS 预检（preflight）限制。若目标服务端未显式允许上述 Header，
浏览器会拦截请求（或预检失败），链路头也无法送达。

请在目标 API 网关 / 服务的响应头中加入：

```
Access-Control-Allow-Headers: traceparent, tracestate, baggage, content-type
Access-Control-Expose-Headers: traceresponse, server-timing
```

- `Access-Control-Allow-Headers`：声明前端**发送**的自定义头（traceparent / tracestate / baggage）。
- `Access-Control-Expose-Headers`：声明前端**读取**的响应头；SDK 会从 `traceresponse`（优先）
  或 `traceparent` 响应头提取服务端返回的 trace 信息，并读取 `server-timing` 做服务端耗时分析。

> 若使用 `fetch` 且带 `keepalive` 或非简单方法（如 `POST` + 自定义头），浏览器会先发 `OPTIONS` 预检，
> 请确保预检响应同样返回上述 `Access-Control-Allow-Headers`。

## 4. 互操作性验证

SDK 的 `baggage` / `tracestate` / `traceparent` 完全遵循 W3C 规范，可用任意标准解析器对拍：

- 我们的 `serializeBaggage()` 输出（`key=value` 逗号分隔、值 `encodeURIComponent`）可被 OTel / 任意 W3C Baggage 解析器直接读取。
- 任意 OTel 客户端注入的 `baggage` / `tracestate` 也可被 SDK 的 `extractContext()` / `parseBaggage()` 正确解析。

详见单元测试 `packages/sdk/test/propagation.test.js`（含与标准解析器的互操作对拍用例）。
