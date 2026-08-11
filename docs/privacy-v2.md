# Privacy v2 · 统一 sanitizer 设计说明

> 关联路线图：Phase 4（U04 / U11 / SDK-206）
> 实现模块：`packages/sdk/src/core/sanitizer.js`（唯一事实来源），`packages/sdk/src/core/event.js` 委托调用。

## 1. 背景与目标

历史实现中，隐私规则分散且不统一：

- 输入框只采元数据（已正确）；
- `<select>` 选择框仍上报 `selectedValue` / `selectedText` 原文；
- 基础事件直接携带 `userPhone` 明文；
- 请求 / 响应 body 仅按字段名脱敏，无法覆盖任意文本内容；
- 缺少统一策略档位与同意分类。

Privacy v2 把所有「是否发送敏感数据」的判断收敛到 **一个 sanitizer 引擎**，做到「配置即策略、策略即代码」。

## 2. 三档策略（mode）

| 档位 | 行为 | 适用 |
|---|---|---|
| `off` | 不做任何隐私保护（仅保留既有 `redactKeys` 字段脱敏） | 业务显式关闭保护、内网可信环境 |
| `balanced`（**默认**） | 字段键脱敏 + 值级 PII 文本脱敏 + 手机号不可逆 hash + URL query 敏感参数剥离 + 头丢弃 + body 清洗 | 生产环境默认最小化采集 |
| `strict` | 在 balanced 基础上进一步：URL 丢弃整个 query、下拉框仅采索引与数量（连 label hash 都不带） | 强合规场景 |

> `createEys` / `createPlatformEys` 在合并配置后调用 `createSanitizer(cfg.privacy)`，未知档位回退到 `balanced`。

## 3. 能力清单

- **字段键脱敏**：`props` / `context` / `breadcrumbs` 中命中敏感 key（password/token/secret/authorization/cookie/apikey…）整体替换为 `[REDACTED]`。
- **值级 PII 文本脱敏**：对字符串叶子值精准匹配并脱敏——邮箱、中国大陆手机号、身份证（18 位）、银行卡（16–19 位）、JWT。仅命中典型形态，不误伤普通文本。
- **用户手机号不可逆 hash**：`balanced` / `strict` 下 `userPhone` 经 FNV-1a + 长度信息的 `h_*` 代称，服务端无法还原。
- **URL query 剥离**：`balanced` 仅剥 `token` / `code` / `phone` / `idcard` 等敏感参数；`strict` 丢弃整个 query（保留 hash）。
- **请求 / 响应头丢弃**：默认移除 `Authorization` / `Cookie` / `Set-Cookie` / `Proxy-Authorization`，可经 `dropHeaders` 追加。
- **请求 / 响应 body 清洗**：`sanitizePair` 对 JSON body 递归字段脱敏、对文本 body 做 PII 脱敏；支持自定义 `requestResponseSanitizer` 钩子（异常回退默认）。
- **`beforeSend` 后二次清洗**：钩子可能重新引入敏感数据，`push` 在 `beforeSend` 之后再次 `sanitizeEvent`。

## 4. 采集模块接入点

| 模块 | 接入方式 |
|---|---|
| `index.js` / `platform/core.js` 的 `push` | 整体事件清洗 + `userPhone` hash + `beforeSend` 后二次清洗 |
| `behavior/advanced.js` 的 `select_change` | `balanced` 仅采 `selectedIndex` / `totalOptions` / `labelHash`；`strict` 仅索引与数量；`off` 采原文 |
| `behavior/click.js` 的点击 label / DOM 文本 | 经 `sanitizeText` 脱敏 PII |
| `performance/body-sampler.js` | 经 `sanitizePair` 清洗 requestBody / responseBody |
| `addReplayEvent`（自定义回放事件） | payload 经 `sanitizeEvent` 清洗 |

## 5. 同意分类与 GPC / DNT

`resolveConsent(config, navigatorLike)` 解析五类同意：

`essential` / `performance` / `analytics` / `replay` / `diagnostics`

- 默认全开；`consent: 'denied'` 时仅保留 `essential`。
- 浏览器发出 **GPC**（`navigator.globalPrivacyControl === true`）或 **DNT**（`navigator.doNotTrack === '1' | 'yes' | 'true'`）信号时，未被用户显式授权的 `analytics` / `replay` / `diagnostics` 降级为拒绝。
- SDK 据此门控回放录制（`replay`）与请求 body 采样（`analytics`）。
- 自查接口：`client.getPrivacyMode()`、`client.getConsentCategories()`。

## 6. 配置示例

```js
WebCollection.createEys({
  appId: 'web-app',
  privacy: {
    mode: 'balanced',            // 默认即 balanced，可显式声明
    redactKeys: ['mySecret'],    // 在默认敏感字段基础上追加
    dropHeaders: ['x-api-secret'],
    textRedaction: true,         // 默认开启
    consentCategories: { replay: true }, // 显式授权可覆盖 GPC/DNT
    requestResponseSanitizer: (pair) => {
      // 自定义清洗：例如替换某业务字段
      return { ...pair, requestBody: 'REDACTED' }
    }
  }
})
```

## 7. 测试

`packages/sdk/test/privacy.test.js`（11 例）断言序列化 payload 中**不含**明文手机号 / 邮箱 / 密码 / token / 身份证 / 银行卡 / 敏感 query 参数，覆盖三档策略、select / click / body 采样、`userPhone` hash、GPC / DNT 映射、自定义钩子。已接入 `npm test`。
