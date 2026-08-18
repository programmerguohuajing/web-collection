# 通知渠道模板配置 — 功能设计

> 状态：设计阶段（待 UI 设计确认后进入开发）
> 作者：SoftwareArchitect
> 日期：2026-08-18

## 1. 背景与目标

通知渠道配置目前对「通知模板」的支持**不统一**：仅 `webhook`/`email` 支持 `bodyTemplate`，而飞书、钉钉、企业微信、飞书智能体**固定发送 `alert.message`，完全无法自定义通知内容**。同时现有模板编辑只是纯 `textarea`，没有变量插入能力。

本设计目标：
1. **所有渠道类型**均支持配置通知模板（文本 / JSON 两种形态）。
2. 模板支持插入变量，**右侧展示该渠道可用的全部变量**，点击变量插入到光标位置（`${var}` 语法）。
3. 统一模板语法与变量目录，前后端共享，避免变量定义散落。

## 2. 现状分析

### 2.1 渠道类型（7 种）

`email` · `sms` · `feishu` · `feishu_app` · `wecom` · `dingtalk` · `webhook`

定义位置：`packages/alerting.js` → `channelTypes`。

### 2.2 现有模板能力与差距

| 渠道 | 现状 | 缺口 |
|------|------|------|
| webhook | `bodyTemplate`(JSON) + headers | 无变量插入交互；语法为 `{{var}}` |
| email | `subject` + `bodyTemplate`(JSON) | 正文非文本模板；无变量插入交互 |
| sms | `templateId` | 无参数模板映射 |
| feishu | 固定 `alert.message` | **无模板** |
| feishu_app | 固定 `alert.message` | **无模板** |
| wecom | 固定 `alert.message` | **无模板** |
| dingtalk | 固定 `alert.message` | **无模板** |

### 2.3 现有变量（`sendChannel` 内 `variables` 对象）

`message` · `appId` · `level` · `metric` · `value` · `threshold` · `page` · `release` · `traceId` · `occurredAt` · `alertId` · `recipients` · `subject` · `templateId` ＋ `secret.KEY`（密钥变量）

> 问题：变量定义写死在 `sendChannel` 函数体内，前端无法感知，无法生成「变量面板」。

### 2.4 现有语法

`{{var}}` / `{{secret.KEY}}`，由 `renderObject()` 实现。用户要求采用 `${var}` 语法。

## 3. 设计方案

### 3.1 模板语法统一

- **新语法**：`${var}` / `${secret.KEY}`（用户要求）。
- **后端渲染兼容**：同时识别 `${var}` 与旧 `{{var}}`，保证已有配置不失效。`${var}` 优先。
- 前端编辑器只产出 `${var}` 语法。

### 3.2 变量目录（Variable Catalog）—— 核心

将变量定义从 `sendChannel` 函数体中**抽取为独立导出** `templateVariables`，前后端共享。前端用它渲染右侧变量面板，后端用它做变量校验与文档。

```js
// packages/alerting.js
export const templateVariables = [
  // 基础组（所有渠道可见）
  { key: 'message',    label: '告警内容', desc: '告警消息文本',     example: '错误率超阈值', group: '基础', types: '*' },
  { key: 'level',      label: '告警级别', desc: 'warning/error/critical', example: 'error', group: '基础', types: '*' },
  { key: 'metric',     label: '指标',     desc: '触发指标',         example: 'error', group: '基础', types: '*' },
  { key: 'value',      label: '当前值',   desc: '指标当前值',       example: '12.5', group: '基础', types: '*' },
  { key: 'threshold',  label: '阈值',     desc: '触发阈值',         example: '10',   group: '基础', types: '*' },
  { key: 'appId',      label: '应用ID',   desc: '来源应用',         example: 'web-portal', group: '基础', types: '*' },
  // 上下文组
  { key: 'page',       label: '页面路径', desc: '触发页面',         example: '/checkout', group: '上下文', types: '*' },
  { key: 'release',    label: '版本',     desc: '应用版本',         example: 'v1.2.3', group: '上下文', types: '*' },
  { key: 'traceId',    label: '链路ID',   desc: '关联追踪ID',       example: 'a1b2c3', group: '上下文', types: '*' },
  { key: 'occurredAt', label: '发生时间', desc: 'ISO 8601 时间',    example: '2026-08-18T04:00:00Z', group: '上下文', types: '*' },
  { key: 'alertId',    label: '告警ID',   desc: '告警唯一标识',     example: '1024', group: '上下文', types: '*' },
  // 渠道组（按类型过滤）
  { key: 'recipients', label: '接收人',   desc: '配置的接收人列表', example: 'a@b.com', group: '渠道', types: ['email','sms'] },
  { key: 'subject',    label: '主题',     desc: '邮件主题',         example: '告警通知', group: '渠道', types: ['email'] },
]
```

- `secret.KEY` 由密钥配置动态生成，`webhook` 类渠道在面板中额外展示「密钥变量」分组（点击插入 `${secret.KEY}`）。
- `types: '*'` 表示所有渠道可见；数组表示仅这些渠道可见。
- 变量目录是**单一真相源**：新增变量只改一处，前后端同步。

### 3.3 按渠道类型的模板字段映射

不同渠道的「模板」含义不同，通过 `messageType` 控制消息形态，按类型动态展示对应字段（详见第 10 节）：

| 渠道 | messageType | 模板字段 | 模式 | 默认值 |
|------|------------|---------|------|--------|
| email | `text` | `subjectTemplate` + `bodyTemplate` | text | `${message}` |
| sms | `sms` | `templateId`（变量参数自动映射） | sms | — |
| feishu | `text` / `interactive` | `messageTemplate` | text / json | `${message}` / card JSON |
| feishu_app | `text` / `interactive` | `messageTemplate` | text / json | `${message}` / card JSON |
| wecom | `text` | `messageTemplate` | text | `${message}` |
| dingtalk | `text` / `markdown` | `titleTemplate` + `messageTemplate` | text | `${message}` |
| webhook | `json` | `bodyTemplate` + headers | json | `{"text":"${message}"}` |

- 新增字段：`messageTemplate`、`subjectTemplate`、`titleTemplate`、`messageType`。
- 保留 `bodyTemplate` 兼容：webhook 仍用 `bodyTemplate`（JSON）；email 的 `bodyTemplate` 语义改为「文本正文」。
- 模式 `text`：纯文本/Markdown，变量直接替换。
- 模式 `json`：必须是合法 JSON，变量替换后仍需可解析（前端实时校验）。飞书 `interactive` 即 json 模式。

### 3.4 模板编辑器组件 `<TemplateEditor>`

独立可复用组件，替换现有裸 `textarea`。

**Props**
| Prop | 类型 | 说明 |
|------|------|------|
| modelValue | string | 模板内容（双向绑定） |
| mode | `'text' \| 'json'` | 编辑模式 |
| variables | Variable[] | 过滤后的可用变量（由父组件按渠道类型过滤） |
| placeholder | string | 占位提示 |
| minHeight | number | textarea 最小高度，默认 120 |

**布局**
```
┌───────────────────────────────┬──────────────────┐
│  模板编辑区 (textarea)          │  可用变量         │
│  ${message} 发生于 ${occurredAt}│  ▸ 基础           │
│  ...                           │    告警内容 message │
│                                │    告警级别 level  │
│                                │  ▸ 上下文         │
│                                │    页面路径 page   │
│  [预览]  JSON 校验: ✓ 合法      │    发生时间 ...    │
└───────────────────────────────┴──────────────────┘
```

**交互**
- 变量面板按 `group` 折叠分组，每项显示 `label` + `key`（等宽小字），hover 显示 `desc` 与 `example`。
- 点击变量项 → 在 textarea **当前光标位置**插入 `${key}`，插入后光标移动到 `${key}` 之后，textarea 保持焦点。
- JSON 模式：实时校验合法性，底部显示 `✓ 合法 JSON` / `✗ JSON 解析失败`。
- 底部「预览」按钮：用各变量 `example` 值渲染模板，展示替换后结果，方便用户确认。

**光标插入实现要点**
- 维护 `textarea` 的 `selectionStart` / `selectionEnd`。
- 插入：`value.slice(0, start) + '${' + key + '}' + value.slice(end)`，重设光标到 `start + key.length + 3`。
- 失焦后再点击变量需恢复上次光标：在 `blur` 时缓存光标位置。

### 3.5 后端渲染改造

`packages/alerting.js` 新增统一渲染函数：

```js
// 支持 ${var} / ${secret.KEY}，兼容旧 {{var}} / {{secret.KEY}}
export function renderTemplate(tpl, variables, secrets = {}) {
  if (typeof tpl !== 'string') return tpl
  return tpl
    .replace(/\$\{\s*(secret\.)?([A-Za-z0-9_]+)\s*\}/g, (_, s, k) =>
      String(s ? secrets[k] ?? '' : variables[k] ?? ''))
    .replace(/\{\{\s*(secret\.)?([A-Za-z0-9_]+)\s*\}\}/g, (_, s, k) =>
      String(s ? secrets[k] ?? '' : variables[k] ?? ''))
}
```

`sendChannel` 改造（关键分支，按 `messageType` 分派）：
- `feishu` / `feishu_app`：
  - `messageType=interactive`：`JSON.parse(messageTemplate)` → `renderObject` 递归替换变量 → `body={msg_type:"interactive", card}`
  - `messageType=text`（默认）：`body={msg_type:"text", content:{text: renderTemplate(messageTemplate||'${message}')}}`
- `dingtalk`：
  - `messageType=markdown`：`body={msgtype:"markdown", markdown:{title: renderTemplate(titleTemplate||'${level}'), text: renderTemplate(messageTemplate||'${message}')}}`
  - `messageType=text`（默认）：`body={msgtype:"text", text:{content: renderTemplate(messageTemplate||'${message}')}}`
- `wecom`：`body={msgtype:"text", text:{content: renderTemplate(messageTemplate||'${message}')}}`
- `email`：`subject = renderTemplate(subjectTemplate||subject||'Web Collection 告警')`；`text = renderTemplate(bodyTemplate||'${message}')`
- `webhook`：`bodyTemplate` 走 `renderObject`（结构化替换），内部改用 `renderTemplate` 处理字符串值，兼容两种语法。
- `sms`：`message` 参数走 `renderTemplate`。

> 变量对象 `variables` 由 `sendChannel` 内部组装（保持现有逻辑），无需改动数据来源。

## 4. 数据模型变更

`alert_channels.config_json` 增量字段（**向后兼容，无破坏性迁移**）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `messageType` | string | 消息形态：`text`/`interactive`/`markdown`/`json`/`sms`，按渠道可选 |
| `messageTemplate` | string(≤20000) | 文本消息模板 / 飞书 card JSON / 钉钉 markdown text |
| `subjectTemplate` | string(≤256) | email 主题模板 |
| `titleTemplate` | string(≤256) | 钉钉 markdown 标题模板 |

- `normalizeChannel` 增加新字段校验与默认值（`messageType` 按渠道白名单校验）。
- 旧 `bodyTemplate` / `subject` 字段保留：webhook 仍读 `bodyTemplate`；email 优先 `subjectTemplate` 回退 `subject`，优先 `bodyTemplate`(文本)。
- 渲染层兼容 `{{var}}`，旧数据无需迁移。

## 5. API 变更

无新增端点。现有 `POST/PUT /api/alert-channels` 的 `config` 体新增 `messageTemplate` / `subjectTemplate` 字段，由 `normalizeChannel` 处理。

新增只读辅助端点（可选，便于前端获取变量目录）：
- `GET /api/alert-channels/template-variables` → 返回 `templateVariables`（按 `type` query 过滤）。
- 前端也可直接 import `packages/alerting.js` 的 `templateVariables`（web 已有该依赖路径）。

## 6. 交互设计（详见 UI 设计图）

1. 渠道配置弹窗内，选择「类型」后，**动态展示对应模板字段**。
2. 每个模板字段使用 `<TemplateEditor>` 组件。
3. 右侧变量面板根据渠道类型过滤变量（`types` 匹配）。
4. 点击变量插入光标位置，格式 `${key}`。
5. JSON 模式实时校验；提供「预览」用示例值渲染。

## 7. 兼容性与迁移

| 项 | 策略 |
|----|------|
| 旧 `{{var}}` 配置 | 渲染层兼容，继续生效 |
| 旧 `bodyTemplate` | webhook 保留；email 语义转文本正文 |
| 旧 `subject` | email 回退字段 |
| DB 迁移 | 无，config_json 增量字段 |
| 新建渠道 | 默认 `${var}` 语法，默认模板 `${message}` |

## 8. 实施计划（UI 确认后）

| 步骤 | 内容 | 涉及文件 |
|------|------|---------|
| 1 | 后端：导出 `templateVariables` + `renderTemplate` + `sendChannel` 改造 + `normalizeChannel` 新字段 | `packages/alerting.js` |
| 2 | 前端：`<TemplateEditor>` 组件（光标插入、变量面板、JSON 校验、预览） | `apps/web/src/components/TemplateEditor.vue`（新增） |
| 3 | 前端：`alert-channels.js` 表单增加 `messageTemplate`/`subjectTemplate` 字段 | `apps/web/src/alert-channels.js` |
| 4 | 前端：`AlertsPage.vue` 渠道弹窗集成 `<TemplateEditor>`，按类型动态展示 | `apps/web/src/pages/AlertsPage.vue` |
| 5 | 测试：补充 `renderTemplate`、各渠道模板渲染用例 | `test/alerting.test.js` |
| 6 | 文档：更新渠道配置说明 | `docs/` |

## 9. 决策点（已确认）

1. **语法**：采用 `${var}`，旧 `{{var}}` 仅作兼容。 ✓
2. **富文本卡片**：本期支持。飞书 `interactive card`（JSON 结构）、钉钉 `markdown` 卡片（title+text）本期实现。 ✓
3. **变量预览值**：用静态 `example` 值渲染预览。 ✓

## 10. 富文本卡片设计（本期范围）

通过 `messageType` 字段控制消息形态，按渠道可选值不同：

| 渠道 | messageType 可选值 | 模板字段 | 说明 |
|------|-------------------|---------|------|
| feishu | `text` / `interactive` | `messageTemplate` | interactive 时存 card JSON，渲染时 renderObject 递归替换变量 |
| feishu_app | `text` / `interactive` | `messageTemplate` | 同 feishu，经 OpenAPI 发 card |
| dingtalk | `text` / `markdown` | `titleTemplate` + `messageTemplate` | markdown 时 title+text 均支持 `${var}` |
| wecom | `text`（默认） | `messageTemplate` | 企微仅文本 |
| email | `text`（默认） | `subjectTemplate` + `bodyTemplate` | — |
| webhook | `json`（默认） | `bodyTemplate` | — |
| sms | `sms`（默认） | `templateId` | — |

### 飞书 interactive card 模板示例（存入 messageTemplate）
```json
{
  "config": { "wide_screen_mode": true },
  "header": { "title": { "tag": "plain_text", "content": "【${level}】告警通知" }, "template": "red" },
  "elements": [
    { "tag": "div", "text": { "tag": "lark_md", "content": "**告警内容**：${message}" } },
    { "tag": "div", "text": { "tag": "lark_md", "content": "**页面**：${page}  **版本**：${release}" } },
    { "tag": "div", "text": { "tag": "lark_md", "content": "**链路**：${traceId}  **时间**：${occurredAt}" } }
  ]
}
```
渲染：`JSON.parse` 后用 `renderObject` 递归把各字段里的 `${var}` 替换为变量值，作为 `card` 字段发出（`msg_type: "interactive"`）。

### 钉钉 markdown 模板示例
- `titleTemplate`：`【${level}】告警通知`
- `messageTemplate`：`### 告警通知\n\n**告警内容**：${message}\n\n**页面**：${page}\n\n**版本**：${release}\n\n[查看链路](https://...)`

发出：`{ msgtype: "markdown", markdown: { title: renderTemplate(titleTemplate), text: renderTemplate(messageTemplate) } }`
