# PRD 16：D4 白标 / 私有化交付（品牌配置 + 自定义域名 + 部署模板）

> 状态：Draft（简单 PRD） · 优先级：P2 · 作者：PM · 预估：前端 3d + 后端 1.5d + 部署 2d
> 上游：`outputs/capability-opportunities-next-horizon.md:144-149`（D4 立项原文：品牌名/Logo/主色配置、自定义域名、部署模板；原估 前端 3d + 部署 2d，后端持久化因复用既有 settings 表单列）
> 原则：双后端一致（Node/PG + Cloudflare/D1 同接口同能力位，README 原则 #4）；`whiteLabel` 能力位 Node 默认 true、Worker 默认 false + `WHITE_LABEL_ENABLED=1` env 门禁（synthetic/dsr/experiments 同范式）；未开启时显式「当前部署不支持白标」而非静默隐藏。
> **范围红线（本批不做）**：**不改 SDK 采集协议、不引入多租户隔离重构**。品牌配置是**展示层 + 部署层**能力，不动数据平面语义（事件 schema / 采样 / 留存 / 告警判定口径一律不变）；不做 Logo 对象存储与上传、不做域名自动证书签发。

## 1. 背景与现状锚点（代码核实结论）

- 现状缺口：平台已在两种部署形态上跑通（Node 自托管 `apps/api` + PG + pm2；Cloudflare Worker + D1），但**品牌是硬编码的**——`apps/web/src/layout/index.vue:91` 直接 `return 'Web Collection'`，侧栏品牌块 `:151-153 / :167-169`、页脚 `:181`、登录页 `views/login/index.vue:97-100`、团队页 `views/teams/index.vue:337-341`、`components/DashboardHeader.vue:64/76`、告警默认标题 `alert-channels.js:24` 全部写死 `Web Collection` / `WC`。政企客户采购"私有化 + 自定义品牌"时，改品牌 = 改源码重新构建。
- 已有可复用基建（本 PRD 全部写明复用关系，不重复造轮子）：

| 基建 | 位置 | D4 复用方式 |
|---|---|---|
| 全局配置存储（双栈） | Node `platform_settings(id=1, config_json jsonb)`（`apps/api/src/db.js:277`，`governance.js:157-168` getSettings/saveSettings、`ai-settings-service.js:37/140` 复用同表）；Worker D1 `settings(id=1, config_json)`（`cloudflare/worker.js:733-734`） | 品牌配置落成 `config_json.brand` 块，**零迁移**；读写沿用「先读 merge 再回写」范式（防覆盖 retention/alerts/ai 其他块） |
| 能力位 | `packages/deployment-capabilities.js`（CAPABILITY_KEYS + NODE_/WORKER_CAPABILITIES + buildCapabilities）；Node `/api/capabilities`（`apps/api/src/index.js:103`）；Worker override（`worker.js:431`） | 新增 `whiteLabel` 能力位；Node `true`，Worker `false` + `WHITE_LABEL_ENABLED=1` |
| 能力位前端消费 | `apps/web/src/composables/useAuth.ts:98-104`（slo/synthetic/dsr/experimentsEnabled computed）；`layout/index.vue:78-83` `capFlags` 驱动导航显隐 | 新增 `whiteLabelEnabled`；`/brand` 入口挂同一 cap 机制 |
| RBAC | `packages/rbac.js` ROLE_MATRIX（camelCase 键，owner 恒放行）；`services/dsr-service.js:81` `hasPermission(auth.role, permission)` | 新增 `brandView` / `brandManage` |
| 前端主题变量 | `apps/web/src/style.css`「Style B」段 `:root{--c-primary:#4f46e5;--c-primary-hover;--c-primary-soft;--el-color-primary:var(--c-primary);...}`（Element Plus 变量全部映射自 `--c-*`） | 运行时覆盖 `--c-primary` 等 ≤6 个变量即全站主色生效，**免重新构建** |
| 静态托管 / HTML 入口 | Node `serveStatic/serveFile`（`apps/api/src/index.js:820-836`，未命中回退 index.html）；Worker `ASSETS.fetch`（`worker.js:180-181/764`）；`apps/web/index.html`（3 行：favicon ×2 + `#app` + `/src/main.js`） | 新增引导脚本 `/brand.js`（Node express 路由 + Worker `run_worker_first` 补 `"/brand.js"`），`index.html` 增一行 script |
| favicon / 静态资源 | `apps/web/public/favicon.ico|favicon.svg`（`index.html` 引用） | 客户自托管时把 logo 放自有静态目录（Node `serveFile` 已托管 `apps/web/dist` 任意路径），配置 URL 指向即可 |
| SDK 采集端点 | `packages/sdk/src/index.js:179` `endpoint` 默认 `/api/collect`；`config/remote-config.js:39/87` 由 endpoint 推导同源 `/sdk-config`；`normalize()` 白名单**不含 endpoint**（远端不可覆盖，安全设计） | 采集域名**已由接入方 init 入参支持**，平台侧不改 SDK；本批只在接入片段里生成带自定义域名的 `endpoint`（P1-3） |
| 部署现状 | `ecosystem.config.cjs`（pm2 单 app `web-collection-api`）；根 `.env`（PORT/DATABASE_URL/PG*/ADMIN_API_KEY/COLLECT_TOKEN/CORS_ORIGIN/MAX_EVENTS）；README.zh-CN「生产模式 / GitHub Actions 自托管 Runner」；`wrangler.jsonc`（custom_domain + D1 + ASSETS） | 部署模板以 **pm2 + .env.example + 一键脚本**为主形态（与现状同源），docker-compose 作为可选补充 |
| 表迁移 | `cloudflare/migrations/` 最新 `0034_experiments.sql` | 本批**默认零迁移**（复用 config_json）；若评审改选独立表则新增 `0035_white_label.sql`（见 §9 Q1 备选） |

- 现实约束：全仓 grep **无任何 multipart / 对象存储 / R2 绑定**（`apps/api/src/index.js`、`cloudflare/worker.js` 均无上传通道）→ Logo 只能走 URL（或客户自托管静态文件），上传能力不在本批。

## 2. 产品目标

让私有化客户**不改源码、不重新构建**即可把控制台变成"自己的产品"——改品牌名/Logo/主色/登录页文案即改即生效，并拿到一份可一键起停的部署模板。

- **G1 品牌可配即用**：管理员在系统设置里改品牌名/主色/Logo/登录页文案，保存后刷新即全站生效（侧栏、登录页、页头、favicon、浏览器标题），无需前端重新构建、无需重启服务。
- **G2 私有化可复制交付**：交付工程师拿到同一份代码 + 一份 env/部署模板，30 分钟内起一套带客户品牌的独立实例（控制台 + 采集同源托管）。
- **G3 边界可控**：能力位 + RBAC 双门禁（Worker 侧 env 未开则显式提示"当前部署不支持"）；品牌能力只改展示与部署配置，数据平面零改动。

## 3. 用户故事

- As a **私有化客户管理员**, I want 在系统设置里填写我的品牌名/主色/Logo 与登录页文案并实时预览, so that 我给领导演示的监控平台是我司品牌，而不是一个开源产品的默认界面。
- As a **私有化客户管理员**, I want 改完点保存、刷新页面即生效（不用找供应商重新打包发版）, so that 换 Logo 这种小事不用走一次发布流程。
- As a **平台运维（自托管部署者）**, I want 品牌出厂默认值可用 env（`BRAND_NAME`/`BRAND_PRIMARY_COLOR` 等）预置, so that 交付时改 env 就能出品牌，客户还没进系统前界面就已经是对的。
- As a **平台运维**, I want Worker 部署上白标默认关闭（env 门禁），前端明确提示"当前部署不支持白标", so that 未验证能力不会静默暴露给存量客户。
- As a **交付工程师**, I want 一套部署模板（env 样例 + 一键起停脚本 + 反向代理样例），并明确控制台域名/采集域名该怎么配, so that 每新签一个客户不用重新摸索一遍部署步骤。

## 4. 核心概念定义

| 概念 | 定义 |
|---|---|
| 品牌配置 brand | 一套展示层配置：`name`（品牌名）/ `shortName`（侧栏缩写，默认 `WC`）/ `logoUrl` / `faviconUrl` / `primaryColor` / `loginTitle` / `loginSubtitle` / `loginFooter` / `consoleDomain` / `collectDomain`。存于全局配置 `config_json.brand` 块，单行 |
| 主题作用域 | **全局**（本批 P0，一套部署一个品牌）vs **按团队**（P1-4，同一部署不同团队不同品牌，按 `x-team-id` 选覆盖块）。P0 数据形状预留 `scopes.global` / `scopes.teams{}`，避免 P1 改结构 |
| 自定义域名（控制台） | 客户访问控制台的域名（如 `monitor.customer.com`）。属**部署配置**：反代 / 证书 / `CORS_ORIGIN` / OAuth 回调由部署侧完成；平台侧 P0 只记录并在部署文档给出反代样例，P1 做录入与配置引导 |
| 自定义域名（采集） | SDK 上报与 `/sdk-config` 拉取所用域名。**SDK 已支持**：`init({ endpoint })` 可传绝对地址（`packages/sdk/src/index.js:179`，远端配置不可覆盖，属安全设计）。平台侧 P0 不改，P1-3 在接入片段里生成带该域名的 `endpoint` |
| 部署模板 | `deploy/self-hosted/` 三件套：`.env.example`（含 `BRAND_*` 出厂默认值）+ `start.sh/stop.sh/status.sh`（pm2 起停，兼容现有 `ecosystem.config.cjs`）+ `nginx.conf.example`（控制台域名反代）；可选 `docker-compose.yml`。Cloudflare 侧给出 `wrangler.jsonc` 的 `routes[].pattern` 与 `WHITE_LABEL_ENABLED` 配置说明 |
| 出厂默认值 vs 运行时配置 | 优先级：**DB `config_json.brand` > env `BRAND_*` > 代码内置默认（Web Collection）**。env 是初始化/无人配置时的回落，DB 一旦保存即以 DB 为准，保证"客户在界面上改的"不被重启覆盖 |

## 5. 需求池

### P0（Must have）

| # | 需求 | 说明 |
|---|---|---|
| P0-1 | 品牌配置持久化（双栈同构） | 落 `config_json.brand` 块：Node `platform_settings(id=1)`（扩展 `governance.js normalizeSettings/mergeSettings` 白名单）、Worker D1 `settings(id=1)`（扩展 `worker.js:734 saveSettings` 白名单，当前仅保留 retention/alerts）；两端 `getBrand()` 输出**归一化 + 钳位**后的品牌对象（颜色 `/^#([0-9a-fA-F]{6})$/`，URL 限 https? 或 `/` 开头相对路径，文案 ≤ 80/120 字符） |
| P0-2 | 运行时主题注入（免重新构建） | 新增公开引导脚本 `GET /brand.js`（Node express 路由；Worker `wrangler.jsonc.run_worker_first` 补 `"/brand.js"`），输出 `window.__BRAND__={...}` + `document.documentElement.style.setProperty('--c-primary', ...)`（覆盖 `--c-primary/--c-primary-hover/--c-primary-soft` 及 `--el-color-primary*`）+ 替换 `link[rel=icon]` href + `document.title`；`apps/web/index.html` 增一行 `<script src="/brand.js"></script>`（位于 `<div id="app">` 之前，同步执行，避免默认蓝闪一下）。能力位关闭时输出空实现（保持默认主题） |
| P0-3 | 前端品牌消费去硬编码 | 新增 `apps/web/src/composables/useBrand.ts`（模块级单例 ref，读 `window.__BRAND__`，默认回落 `Web Collection`/`#4f46e5`）；替换硬编码点：`layout/index.vue:91/151-153/167-169/181`、`views/login/index.vue:97-100`、`views/teams/index.vue:337-341`、`components/DashboardHeader.vue:64/76`；`alert-channels.js:24` 告警默认标题走品牌名 |
| P0-4 | 品牌配置管理页 `/brand` | 表单（品牌名 / 侧栏缩写 / 主色取色器 + HEX 输入 / Logo URL / Favicon URL / 登录页标题·副标题·页脚 / 控制台域名 / 采集域名）+ **实时预览卡**（微缩侧栏品牌块 + 主色按钮·标签 + 登录页小样）+ 保存 / 重置为默认（二次确认）。能力位 `whiteLabel=false` 时整页显示「当前部署不支持白标」占位（不静默隐藏）；`accounts=false` 时沿用 `/api/settings` 现有 ADMIN_API_KEY 模式放行 |
| P0-5 | 能力位 `whiteLabel` | `CAPABILITY_KEYS` 登记 `whiteLabel`；`NODE_CAPABILITIES.whiteLabel = true`；`WORKER_CAPABILITIES.whiteLabel = false`，Worker `worker.js:431` override 追加 `whiteLabel: env.WHITE_LABEL_ENABLED === '1'`；`useAuth.ts` 增 `whiteLabelEnabled` computed；`layout/index.vue:79 capFlags` 增 `whiteLabel`；守卫 `guardWhiteLabel`（复刻 `guardDsr`，未开启 503） |
| P0-6 | RBAC 权限点 | `brandView: ['admin','member','viewer']`（品牌是展示层、非敏感，全员可见）、`brandManage: ['admin']`（owner 恒放行，改品牌属平台管理员视角）；服务端 `hasPermission(auth.role, 'brandManage')`（`dsr-service.js:81` 同范式）。`/brand.js` 与 `GET /api/brand` 为**公开**端点（登录页未登录也要白标），仅返回展示字段，不含任何部署密钥 |
| P0-7 | 部署配置 env 化 + 部署模板 | 新增 env：`BRAND_NAME` / `BRAND_SHORT_NAME` / `BRAND_LOGO_URL` / `BRAND_FAVICON_URL` / `BRAND_PRIMARY_COLOR` / `BRAND_LOGIN_TITLE` / `BRAND_LOGIN_SUBTITLE` / `PUBLIC_CONSOLE_ORIGIN`（控制台对外域名，供文档/片段生成；`CORS_ORIGIN` 语义不变）；写进根 `.env` 注释与 `deploy/self-hosted/.env.example`；新增 `deploy/self-hosted/{start.sh,stop.sh,status.sh,nginx.conf.example}` + README.zh-CN 新增「私有化交付（白标）」章节（含 Worker 侧 `WHITE_LABEL_ENABLED` 与 `wrangler.jsonc` 自定义域说明）。脚本必须复用现有 `ecosystem.config.cjs`，不另起进程模型 |

### P1（Should have）

| # | 需求 | 说明 |
|---|---|---|
| P1-1 | 告警/通知文案白标 | 告警渠道默认标题与模板前缀（`alert-channels.js`）取品牌名；导出文件名前缀白标 |
| P1-2 | 控制台域名录入与配置引导 | `/brand` 页录入 `consoleDomain` 后展示「需完成的 3 步」：反代 → `CORS_ORIGIN`/`PUBLIC_CONSOLE_ORIGIN` → 重启生效；提供可复制的 nginx 片段；**不做自动改配置、不自动签发证书** |
| P1-3 | 采集域名接入片段 | 应用/集成页的 SDK 初始化片段按 `collectDomain` 生成绝对 `endpoint`（`https://collect.customer.com/api/collect`）与 `/sdk/*.js` 引用地址；明确"SDK 已支持 endpoint 覆盖，平台不改协议" |
| P1-4 | 多租户品牌（按团队） | `brand.scopes.teams[teamId]` 覆盖全局；`/brand.js` 无法感知登录态（公开脚本）→ 改由登录后 `/api/brand?teamId=` 二次应用，首次渲染用全局块（接受一次短暂切换，见 §9 Q1） |
| P1-5 | 品牌变更审计 | 记录 `updated_by`/`updated_at`（`brand.updatedBy`），列表在系统设置展示最近 10 次变更（复用 `data_access_audit` 风格，不新建表） |

### P2（Nice to have）

| # | 需求 | 说明 |
|---|---|---|
| P2-1 | 完整多主题（暗色 / 多套预设） | 主题预设切换，需统一 `--c-*` 全量变量与暗色模式（当前 style.css 无暗色变量） |
| P2-2 | 自定义 CSS 注入 | 允许追加一段 CSS；需转义与 CSP 评估，风险较高，默认关闭 |
| P2-3 | 域名自动证书（ACME） | 自动申请/续期 Let's Encrypt 证书并热加载 |
| P2-4 | Logo 上传与托管 | 当前仓库无对象存储（全仓无 multipart/R2），需引入存储层后再议 |

### 非目标（明确不做）

- 不按品牌隔离数据（不做多租户数据面拆分）；不做"每应用一套品牌"（P1 只到团队级）。
- 不修改 `events-schema` / 采样 / 留存 / 告警判定等任何数据平面语义。
- 不在 SDK 内引入品牌/域名概念；`/sdk-config` 不新增品牌块。

## 6. 关键设计决策

### 6.1 主题注入：运行时 CSS 变量 + `/brand.js` 引导脚本（默认决策）

**倾向：`/brand.js` 引导脚本 + CSS 变量覆盖**，而非"构建期变量替换"或"应用启动后 fetch 再注入"，理由：

1. `style.css` 的 Style B 段已把 Element Plus 主色全部映射为 `--el-color-primary: var(--c-primary)` 等变量，改 ≤6 个 `--c-*` 变量即全站生效——**不需要重新构建**，契合 G1（客户改品牌不该触发发版）。构建期变量（Vite define / SCSS 变量）每次换品牌都要重新打包 + 重新分发 dist，私有化场景下交付成本不可接受。
2. 引导脚本是**同步阻塞**的（`index.html` 中位于 `#app` 之前），首帧即正确主色，避免"先蓝后客户色"的闪烁；若改为 Vue 挂载后 `fetch('/api/brand')` 再注入，登录页首帧必然闪一次默认主题，且多一次往返。
3. `/brand.js` 是静态资源语义，Node `serveFile` 与 Worker `ASSETS` 之外各挂一条路由即可，Worker 侧只需在 `wrangler.jsonc.run_worker_first` 追加 `"/brand.js"`，对现有 assets/SPA 回退链路零破坏。

**代价与边界**：品牌脚本在登录前执行，因此只能返回**非敏感的展示字段**（品牌名/颜色/Logo URL/登录文案），不含域名密钥或任何凭据；按团队品牌（P1-4）无法在首帧生效，需登录后二次应用（可接受一次切换）。

### 6.2 存储：复用全局配置 `config_json.brand` 块，不新建表（默认决策）

- 双栈已各有一张"全局配置单行表"（Node `platform_settings` / Worker `settings`，均 `id=1, config_json`），且已有两个模块（governance、ai-settings）共存的先例——品牌是第三个模块，同表合入**零迁移**，两条部署链路都不用加 migration，符合"展示层配置"的量级。
- 风险与对策：两端 `saveSettings` 都是**白名单归一化**（Node `normalizeSettings` 保留 retention/alerts/ai；Worker `saveSettings` 只保留 retention/alerts），直接 PUT 会丢字段 → P0-1 必须扩展两端白名单并补 `brand` 归一化；写路径沿用「先读 merge 再整体回写」（`governance.js` 已有注释明确此约定）。
- 备选：若评审倾向独立表（审计/多租户更清晰），则新增 `brand_configs` + D1 迁移 `0035_white_label.sql`（Node `ensureSchema` 同构建表），工作量 +0.5d，见 §9 Q1。

### 6.3 自定义域名两层，本批交付深度不同

| 层 | 谁配置 | 本批交付 |
|---|---|---|
| 控制台域名 | 客户/交付工程师（反代 + 证书 + `CORS_ORIGIN`） | P0 只**记录**字段 + 部署文档/模板给出反代样例；P1-2 做录入与"需完成 3 步"引导；**不自动签发证书、不自动改服务端配置** |
| 采集域名 | 接入方（SDK `init({ endpoint })`，已支持） | P0 不改；P1-3 在接入片段里生成带该域名的绝对 `endpoint` 与 `/sdk/*.js` 地址。**平台侧不新增任何采集协议字段** |

私有化单进程天然同域：Node 同时托管控制台静态（`serveFile`）、`/api/collect`、`/sdk-config`、`/sdk/:file`（`index.js:705/763`），SDK 默认 `endpoint='/api/collect'` 即同源相对路径——所以"同域"是默认且推荐的形态，跨域只是接入方自行传绝对地址的选项。

### 6.4 部署模板形态：pm2 + env 样例 + 一键脚本为主，docker-compose 可选

现状交付路径是 pm2（`ecosystem.config.cjs`）+ 根 `.env` + 可选 GitHub Actions Runner（README.zh-CN「生产模式」）。模板必须**兼容并复用**它，而不是替换：

```
deploy/self-hosted/
  .env.example          # 现有项 + BRAND_* / PUBLIC_CONSOLE_ORIGIN 注释说明
  start.sh              # pm2 start ecosystem.config.cjs --only web-collection-api --env production
  stop.sh / status.sh   # pm2 stop|status（与 README 常用命令一致）
  nginx.conf.example    # 控制台域名反代 + /api/ /sdk/ 透传 + 客户端大体量 body 限制
  docker-compose.yml    # 可选：api + postgres 两服务，BRAND_* 通过 environment 注入
  README.md             # 30 分钟起一套带品牌实例的步骤清单
```

不引入 K8s/Helm（超出本批 2d 预算与客户实际环境）。

## 7. 数据模型与接口契约

### 7.1 `config_json.brand` 块（双栈同构；Node `platform_settings.id=1` / Worker D1 `settings.id=1`）

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| name | string(80) | `Web Collection` | 品牌名（侧栏、页头、浏览器标题、`alert-channels` 默认标题） |
| shortName | string(8) | `WC` | 侧栏/登录页方形 Logo 内的缩写；无 `logoUrl` 时展示 |
| logoUrl | string(2048) | `''` | Logo 图片 URL（https? 或 `/` 开头相对路径）；空 → 走缩写方块 |
| faviconUrl | string(2048) | `''` | favicon URL；空 → `/favicon.svg` |
| primaryColor | string(7) | `#4f46e5` | 主色，正则 `^#[0-9a-fA-F]{6}$`；注入 `--c-primary`（hover/soft 由服务端按主色派生，前端不计算） |
| loginTitle | string(80) | = name | 登录页主标题 |
| loginSubtitle | string(120) | `前端遥测平台` | 登录页副标题 |
| loginFooter | string(160) | `''` | 登录页页脚（客户可放备案/版权信息） |
| consoleDomain | string(256) | `''` | 控制台对外域名（P0 仅记录 + 文档引导） |
| collectDomain | string(256) | `''` | 采集域名（P0 仅记录，P1-3 用于生成接入片段） |
| scopes | object | `{ global: {...} }` | P0 只写 `global`；P1-4 增 `teams: { [teamId]: partial }`，结构预留不改表 |
| updatedBy / updatedAt | string(64) / number | — | 变更留痕（P1-5 展示） |

归一化规则：未知字段丢弃；URL 仅允许 `http(s)://` 或 `/` 开头（防 `javascript:` 注入）；颜色不合法回落 env/内置默认；文案长度钳位。

### 7.2 接口（Node 与 Worker 同路径同契约）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/brand.js` | 公开 | 引导脚本（`application/javascript`，短 Cache-Control: 60s + `etag`）：设 `window.__BRAND__` + 覆盖 CSS 变量 + 替换 favicon/title；能力位关闭时输出空实现 |
| GET | `/api/brand` | 公开 | 归一化后的品牌对象（同上字段，不含密钥）；未配置时回落到 env `BRAND_*`，再回落到内置默认 |
| PUT | `/api/brand` | `brandManage` | merge 后回写 `config_json.brand`（不覆盖 retention/alerts/ai 块）；返回归一化结果；能力位关闭 → 503「白标能力未启用」 |
| POST | `/api/brand/reset` | `brandManage` | 清除 `brand` 块 → 回落到 env/内置默认（二次确认后调用） |

Worker 侧同路径实现（D1 `settings` 读写 + `guardWhiteLabelW` 复刻 `guardDsrW:1867` 范式）；`/api/capabilities` 双端经 `buildCapabilities` 输出 `whiteLabel`（Node `true`，Worker `env.WHITE_LABEL_ENABLED==='1'`）。

## 8. UI 设计稿描述（`/brand`，`apps/web/src/views/monitor/brand/index.vue`，系统设置分组）

- **路由与入口**：`router/index.js` 在 settings 同级加 `{ path: 'brand', component: () => import('../views/monitor/brand/index.vue'), meta: { title: '品牌与白标' } }`；`layout/index.vue`「系统设置」分组增 `{ title: '品牌与白标', path: '/brand', icon: Setting, cap: 'whiteLabel' }`（cap=false 时不渲染入口；直接访问 URL 时页内显示「当前部署不支持白标」占位，不静默空白）。
- **页面结构（左右两栏，桌面端 `grid-template-columns: 1.1fr 0.9fr`）**：
  - 左：`<el-form>` 表单卡——① 基础：品牌名（必填，≤80）+ 侧栏缩写（≤8）+ 主色（`el-color-picker` + HEX 输入联动，旁边「重置为 #4f46e5」）；② 资源：Logo URL + 「预览」按钮（加载失败 toast 提示并回退缩写方块）、Favicon URL；③ 登录页：标题 / 副标题 / 页脚（带字符计数）；④ 域名：控制台域名 + 采集域名（只读提示"采集域名由 SDK `init({endpoint})` 生效，此处仅用于生成接入片段"）。
  - 右：**实时预览卡**（sticky）——微缩侧栏（深色底 + 品牌块：Logo 或缩写方块 + 品牌名 + 副标题）+ 主色按钮组（primary/默认/文字按钮）+ 主色 tag + 登录页小样（品牌块 + 标题/副标题/页脚）；预览随表单**本地即时更新**，与"已保存值"不同时右上角显示「未保存」灰标。
  - 底部操作条：保存（`brandManage`；无权限时按钮禁用并 tooltip「需要 Admin 及以上」）/ 重置为默认（`el-popconfirm` 二次确认）/ 取消（还原为服务端值）。
- **交互约定**：保存成功后 `ElMessage` 提示并**引导刷新**（`/brand.js` 为同步引导脚本，主色/标题需刷新后全量生效；表单内不自动 reload，避免打断连续编辑）；长文本一律 `<OverflowTip>`（EP 2.14 红线，禁用原生 show-overflow-tooltip）；页头附一行口径说明："品牌配置为全局生效，仅影响展示与部署文档，不改变任何采集与数据口径"。

## 9. 待确认问题（均给默认决策）

1. **Q1 品牌配置存全局还是按团队？** 默认决策：**P0 全局单行**（`config_json.brand.scopes.global`），结构预留 `scopes.teams` 供 P1-4 扩展。理由：私有化客户通常是"一客户一套部署"，全局即够用；按团队品牌在首帧（登录前）无法判定归属，必须登录后二次应用，复杂度与收益不成比例。备选：若评审要求独立表以便审计，改 `brand_configs` + D1 `0035_white_label.sql`（+0.5d）。
2. **Q2 Logo 存 URL 还是上传？** 默认决策：**URL**（含 `/` 开头相对路径）。全仓无 multipart/对象存储/R2 绑定，引入存储层远超本批预算；私有化客户把 logo 放进自托管静态目录（Node `serveFile` 已托管 `apps/web/dist` 下任意路径，如 `/brand/logo.svg`）即可，零新增依赖。上传能力列 P2-4。
3. **Q3 主题注入用 CSS 变量还是构建期变量？** 默认决策：**运行时 CSS 变量 + `/brand.js` 引导脚本**（§6.1）。构建期替换每次换品牌都要重新打包分发，与"客户自助改品牌"目标冲突；CSS 变量方案在现有 `style.css` 变量体系上改 ≤6 个变量即可，且支持 env 出厂预置。
4. **Q4 私有化模板交付形态？** 默认决策：**pm2 + `.env.example` + `start/stop/status.sh` + `nginx.conf.example`**（`deploy/self-hosted/`，复用现有 `ecosystem.config.cjs`），另附**可选** `docker-compose.yml`（api + postgres）。不做 K8s/Helm；Cloudflare 侧只补文档（`wrangler.jsonc` 自定义域 + `WHITE_LABEL_ENABLED=1`）。
5. **Q5 采集域名与控制台域名是否同域？** 默认决策：**推荐同域**（Node 单进程同时托管控制台静态、`/api/collect`、`/sdk-config`、`/sdk/:file`，SDK 默认 `endpoint='/api/collect'` 即同源）。跨/独立采集域名仅作为接入方 `init({ endpoint: 'https://collect.customer.com/api/collect' })` 的选项，**平台侧不新增协议字段、不代理转发**。
6. **Q6 `/brand.js` 缓存策略？** 默认决策：`Cache-Control: public, max-age=60` + ETag（品牌极少变更，60s 足以保证改完刷新可见；不设长缓存避免客户改了品牌却要清 CDN 缓存）。

## 10. 范围红线（明确不做）

- **不改 SDK 采集协议**：`/sdk-config` 不新增品牌块，`events-schema`、采样、上报通道、限流一律不动；采集域名仅通过接入方已有的 `endpoint` 入参生效。
- **不引入多租户隔离重构**：不按品牌拆分库/表/权限边界；P1-4 的团队级品牌只是展示层覆盖块，不触碰 `applications.team_id` 过滤逻辑与数据访问等级（07/D2）语义。
- **不做资源托管与证书自动化**：无 Logo 上传/对象存储（P2-4）、无 ACME 自动签发（P2-3）；域名与证书属部署侧职责，平台只给文档与引导。
- 不做暗色/多主题与自定义 CSS（P2），不在本批引入新的前端构建变量体系。

## 11. 成功指标

- 交付后，一套全新私有化实例从"拿到代码"到"带客户品牌的控制台可访问" ≤ 30 分钟（按 `deploy/self-hosted/README.md` 步骤清单计时）。
- 品牌变更零发版：管理员在 `/brand` 改名/换主色/换 Logo，保存 + 刷新后侧栏、登录页、页头、favicon、浏览器标题全部生效，无需重新构建前端。
- 硬编码清零：`Web Collection` 字面量在 `apps/web/src` 中仅剩 `useBrand` 默认回落一处（`grep` 可验收）。
- 双栈一致：`GET /api/capabilities` 的 `whiteLabel` 在 Node 为 `true`、Worker 未设 `WHITE_LABEL_ENABLED` 时为 `false` 且 `/brand` 显示"当前部署不支持白标"（非静默隐藏）；`GET /api/brand` 与 `PUT /api/brand` 双端字段与归一化结果一致。
