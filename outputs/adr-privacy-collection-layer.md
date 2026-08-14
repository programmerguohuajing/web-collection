# ADR-007: 隐私脱敏分层 —— 凭据留采集层、通用 PII 下沉下游

## Status
Implemented（Phase A SDK 显式化已落地；Phase B 后端 mask-at-query + `privacy_mode` 列已落地；Phase C SDK 消费即文档化映射，因 SDK 已原生支持 `privacy.mode`）。更新于 2026-08-14。

## Context
SDK 现有 `PrivacyMode` 默认 `balanced`，在事件出 SDK 之前（`src/index.js:713/717`、`src/platform/core.js:303/309` 的 `sanitizeEvent`）就改写原文：
- 字段级丢弃：`password/token/secret/authorization/cookie/apikey/privatekey/jwt/...` 命中即 `[REDACTED]`；
- PII 文本丢弃：邮箱/手机/身份证/银行卡/JWT 在文本中匹配即 `[REDACTED]`；
- URL query 剥离 `phone/idcard/cvv/auth/sign/sessionid` 等；请求/响应头与 body 脱敏。

这与本项目已对齐的采集原则冲突——"全链路采集、入库全量存储、用到时才从库取值；脱敏在下游（入库/查询层）做，不在 SDK 采集层主动丢弃字段"（见 `MEMORY.md` 2026-08-14）。冲突点：默认 balanced 在采集层把原值改写了，DB 存的是已脱敏值，任何下游授权方（安全取证、已授权调试）都无法还原——正是 P0-2 当初担心的"采集层丢弃 → 后续要展示时没数据、得改 SDK 重发版"。

实地核查现状：
- `cloudflare/worker.js:63` 直接 `JSON.stringify(event.*)` 裸存入 D1，**无字段脱敏**——"入库全量"的存储前提已满足。
- 治理（P1-3，服务端强制）仅有 `rules_json` 的 `blockedTypes/blockedNames/allowedOrigins` + `sample_rate`，**无字段脱敏、无隐私模式开关**（`applications` 表无 `privacy_mode`）。
- SDK `sanitizer.js` 的 `redactObject` 对凭据键的剥离**在所有模式（含 off）下都生效**；自由文本 PII 脱敏由 `redactPii = mode !== 'off'` 控制。即"凭据常驻剥离 + 通用 PII 受模式控制"已是现状。

## Decision
采用**混合方案**，把字段显式分成两级：

1. **凭据类（password/token/secret/authorization/cookie/apikey/privatekey/jwt/keys 等）—— 永不采集原文，保留在 SDK 采集层 strip。**
   这些不是遥测数据，下游无合法分析用途，明文存储是安全/合规负债。常驻剥离**不违反"全采集"原则**（原则针对行为/观测遥测，不含凭证），且已在所有模式生效，须显式声明为 intentional carve-out。
2. **通用 PII（自由文本邮箱/手机/身份证/银行卡/JWT、表单字段、URL query PII、请求/响应 body PII）—— 受隐私模式控制，默认仍脱敏，可显式关闭以全采集。**
   - 出厂默认保持 `balanced`（隐私安全默认，不破坏现有消费方）。
   - 新增显式默认声明 + 文档；可选新增 `minimal` 模式（= 仅凭据 carve-out，语义 alias，便于消费方理解）。
3. **按应用开启 raw 采集（全采集 opt-in）：** 在 `applications` 增加 `privacy_mode`（或并入 `rules_json`），由治理后台（P1-3 同模式，服务端强制）配置；SDK 初始化按该值决定脱敏档位。
4. **下游查询时脱敏（mask-at-query）：** 在 `apps/api` 查询层复用 `sanitizer.js` 纯函数（`redactObject`/`redactPiiText`/`sanitizeUrl`），按**查询方角色（RBAC）**对 `props_json/message/url/breadcrumbs_json/context_json/original_json` 做掩码。**原值入库、按角色展示时掩码**，才是原则完整落地；不做"入库前脱敏"（那仍丢原值，只是后移一跳）。

## Consequences
- 收益：与采集原则对齐；授权取证/调试可还原原值；隐私默认安全得以保留；按应用灵活选择全采集。
- 代价：
  - 需新建后端查询脱敏模块 + 确定"查询方角色"来源（apps/api 现有 `session/role/admin/auth` 痕迹，需确认 RBAC 模型）。
  - 原值入库涉及 GDPR/PIPL"数据最小化"合规张力：裸存 PII 需合法事由 + 留存策略。
  - SDK 默认档位文档化、`privacy.test.js` 当前锁定 balanced 契约，若新增/重命名模式需相应更新。
- **顺序硬约束**：下游查询脱敏（第 4 点）**必须先于**按应用 raw opt-in（第 3 点）上线，否则控制台会把裸 PII 暴露给所有查看者。

## Implementation（2026-08-14 落地）

### A. SDK 侧（Phase A，零运行时变更）
- `src/core/sanitizer.js`：`createSanitizer` 上方注释显式声明两级分类（凭据常驻剥离 = intentional carve-out，不违原则；通用 PII 受 mode 控制；balanced 是刻意出厂默认）。
- `index.d.ts`：`PrivacyMode` 与 `EysPrivacyOptions.mode` JSDoc 写明两级分类与各档位语义；`platform.d.ts` 复用同一 `EysPrivacyOptions`（import type），自动覆盖。
- `packages/sdk/README.md` 隐私段：补 "Two-tier classification" 与 **governance ↔ SDK 映射**（app `privacy_mode='raw'` ⇄ SDK `privacy.mode='off'`，后端查询时掩码）。
- 未引入新 `minimal` 模式；`balanced` 默认不变；`privacy.test.js` 11/11 无回归。

### B. 后端侧（Phase B）
- 新增 `apps/api/src/privacy.js`（**纯函数、不引 DB、可独立单测**）：镜像 SDK `sanitizer.js` 的 PII 正则（邮箱/手机/身份证/银行卡/JWT → `[REDACTED]`）与凭据 key 整字段 `[REDACTED]`；`maskValue`（递归，深度 4 / 单项 100 上限）；`isAuthorizedRaw`（请求头 `x-eys-raw-access` vs 环境变量 `EYS_RAW_ACCESS_TOKEN`，常量时间比较）；`createMaskingMiddleware`（响应边界掩码中间件，含 `MASK_SKIP_PREFIXES`）。
- `apps/api/src/index.js`：在所有 `/api` 查询路由注册 `createMaskingMiddleware()`。
- `apps/api/src/privacy.js` 新增 `queryMaskingEnabled()`：**默认关闭（访问即看原文，无查看者权限分级）**，中间件为 pass-through；设环境变量 `EYS_QUERY_MASKING=on` 即重新启用 mask-at-query（届时写入/配置/静态类前缀不掩码、授权查看者看原文）。因当前部署不做权限分级，故默认不掩码。
- `applications.privacy_mode` 列两处落地：
  - 本地 Postgres：`apps/api/src/db.js` `ensureSchema()` 加 `alter table applications add column if not exists privacy_mode varchar(16) not null default 'balanced'`。
  - 生产 D1：`cloudflare/migrations/0008_application_privacy_mode.sql`。
- `apps/api/src/governance.js`：`saveApplication` 接受并校验 `privacyMode`（`balanced`|`raw`，默认 `balanced`）；`listApplications` 选中并输出 `privacy_mode`；`APP_PRIVACY_MODES` 常量。
- 测试：`test/privacy.test.js`（8 用例，纯函数）、`test/privacy-middleware.test.js`（5 用例，mock req/res 验证中间件掩码/跳过/授权）。均通过。
- **硬约束已满足**：mask-at-query 先行上线，故任何应用可被设为 `raw` 而不暴露裸 PII。

### C. SDK 消费（Phase C）
SDK 已原生支持 `privacy.mode`（`off`/`balanced`/`strict`），故"消费 governance `privacy_mode`"无需新增 SDK 代码——是运营层映射：app 治理设为 `raw` 时，部署方同步将 SDK 配为 `privacy.mode:'off'`；后端查询时按授权掩码。`privacy.test.js` 契约无需改动（未新增/重命名模式）。

## Open Questions（仍待产品/合规决策）
- **查看者角色模型（2026-08-14 已决策：暂不做权限控制）**：用户拍板当前部署**不做查看者权限分级**——任何能访问 API 的调用方都视为可查看原文，故查询侧脱敏默认关闭（`queryMaskingEnabled()===false`、中间件 pass-through）。`isAuthorizedRaw`（基于 `EYS_RAW_ACCESS_TOKEN` 的 token 闸门）保留为**未来启用掩码时的占位**，待接入真实 RBAC（按用户角色/权限的查询层门控）后再细分角色，届时将 `EYS_QUERY_MASKING=on`。apps/api 目前无用户级 session/role，此决策下无需新增。
- **raw PII 入库合规（2026-08-14 已决策：仅新建 raw 应用生效）**：raw PII 入库**只对新建且显式开启 `raw` 的应用生效**；存量应用隐私档位保持 `balanced`（SDK 采集层已脱敏，DB 无裸 PII），不受影响。`privacy_mode` 列默认 `balanced` + 迁移/建表默认 `balanced` 已落实该隔离。裸存 PII 的合法事由与留存策略仍建议由合规书面确认（尤其 raw 应用的留存期是否需短于通用事件 30 天）。
- **过度脱敏风险**：后端 `bankcard` 正则（`\d{16,19}`）与 SDK 一致，可能把 16–19 位纯数字 ID（如订单号）误判为银行卡而 `[REDACTED]`；因与 SDK balanced 行为对齐，保持一致性优先，后续如需可收窄正则。
