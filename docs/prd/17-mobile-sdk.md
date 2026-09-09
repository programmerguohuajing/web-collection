# PRD 17：E1 · 原生移动 SDK（React Native 落地 + Flutter 契约）

> 状态：Draft（简单 PRD） · 优先级：P1 · 作者：PM·许清楚 · 预估：**本批 6d**（RN 包 4d + Flutter 契约 1d + 联调验收 1d），Flutter 实现 4d **deferred**
> 上游：`outputs/capability-opportunities-next-horizon.md:153-158`（E1 · 原生移动 SDK，原估 RN 4d + Flutter 4d + 联调 2d）
> 语言 / 技术栈：JavaScript/TypeScript（Vite library 构建，复刻 `packages/sdk` 现有 `vite.platform.config.js` 范式）；本批无控制台新页，故不适用 React + MUI + Tailwind 前端栈
> Project Name：`mobile_sdk`
> 原则：双后端一致（README 原则 #4）；复用 `POST /api/collect` + `x-app-key`，不新建采集协议；不新增事件 type；不新增部署能力位；不改数据库 schema
> **范围红线（用户明确原则）**：SDK 仍是通用技术底座，**移动端只做平台适配层与指标采集，业务事件契约不进 SDK 核心**。移动端业务埋点仍走 `track(name, props)` 通用原语，SDK 不知道"下单/支付/加购"等语义。

## 1. 背景与现状锚点（代码核实结论）

- 现状缺口：SDK 已支持小程序 / UniApp / Taro（**RN 也已有一个"能跑但不完整"的适配层**），但缺**移动端专属采集**——冷启动、帧率/卡顿、崩溃（JS + 原生）、AppState 前后台会话。这些是 App 团队接入观测平台的刚需，缺了就只能算"能上报事件"，不能算"移动端可观测"。
- 关键核实结论（决定了本 PRD 的全部裁剪决策）：

| # | 核实项 | 结论（代码锚点） |
|---|---|---|
| 1 | RN 适配层已存在 | `packages/sdk/src/platform/adapters.js:52` `createReactNativeAdapter(runtime)`：`fetch` 作网络层、`runtime.storage` 作存储层、`capabilities` 声明 `{dom:false, exposure:false, replay:false, beacon:false, visibility:false}`；`packages/sdk/src/platform/index.js` 导出 `createReactNativeEys(options, runtime)` |
| 2 | RN 目前只是"别名" | `packages/sdk/package.json` exports `./react-native` → `dist/web-collection-sdk.platform.js`，与 `./miniapp`、`./uni-app`、`./taro` **指向同一构建产物**。即 RN 与小程序共用一套逻辑，**零移动端专属指标** |
| 3 | 事件 type 是**封闭白名单** | `apps/api/src/index.js:839` 与 `cloudflare/worker.js:2478` 两处 `sanitize` 均校验 `['track','perf','performance','behavior','error','replay','log','trace']`，否则 `throw new Error('bad event type')`。**新增 `crash`/`cold_start` type 会被双栈同时拒收** |
| 4 | 统一事件 schema 已覆盖生命周期 | `packages/events-schema.js`：`session_started` 的 aliases 含 `app_start`；`page_viewed` 含 `pv`；`page_left` 含 `page_leave`。而 `platform/core.js` 的 `instrumentApp` 已在发 `app_start`/`app_foreground`/`app_background`，`pageView`/`pageLeave` 在发 `pv`/`page_leave` → **移动端生命周期事件天然被归一，无需新增 canonical** |
| 5 | 上报链路完备可复用 | `packages/sdk/src/platform/core.js`：`push` → 确定性采样 → sanitizer → `beforeSend` → 队列（`maxQueue=200`，溢出丢最旧）→ `persist` 持久化 → `flushOnline`（每批 ≤100，`x-app-key` 来自 `cfg.collectKey`，`classifyResponse` 分 success/drop/retry，`maxRetries=3` + `computeBackoff(base 500, max 30000)`）；storage key `__web_collection_platform_queue__` / `__web_collection_device_id__` |
| 6 | 采集端点与鉴权 | `apps/api/src/index.js:112` `POST /api/collect`，`authorizeCollect(appId, req.get('x-app-key'))` → 401 `bad app key`；CORS `access-control-allow-headers` 已含 `x-app-key`（`index.js:814`）。移动端无 CORS 约束，但**头要求完全一致** |
| 7 | 平台标记已存在 | `cloudflare/migrations/0001_init.sql:9` `applications(..., platform text default 'web', ...)`；`apps/web/src/views/monitor/governance/index.vue:244` 下拉已含 `['web','miniapp','uni-app','taro','react-native']` → **零后端 schema 改动** |
| 8 | 能力位是"部署侧"语义 | `packages/deployment-capabilities.js` CAPABILITY_KEYS 共 14 个，驱动 `/api/capabilities`（`worker.js:431` buildCapabilities override）。移动端是**SDK 分发形态**，服务端无新增端点/表/查询能力 → 无需登记 |
| 9 | SDK 侧已有独立能力位体系 | `packages/sdk/platform.d.ts` `PlatformCapabilities` + `core.js` `getCapabilities()` + `requireCapability()` 静默降级。移动端宿主能力自查复用这套，与部署能力位不混用 |
| 10 | Node 层可做行为验证 | `packages/sdk/test/platform.test.js`：注入 fake adapter（request/getStorage/setStorage/getContext）即可在 Node 下断言入队、脱敏、`x-app-key`、flush。**RN 包可在 Node 层完成行为验证，无需模拟器** |
| 11 | 符号化通道已存在 | `apps/api/src/index.js:179` `POST /api/sourcemaps`（P1 符号化占位可复用） |

- 已有可复用基建（本 PRD 全部写明复用关系，不重复造轮子）：

| 基建 | 位置 | E1 复用方式 |
|---|---|---|
| 平台内核 | `packages/sdk/src/platform/core.js` `createPlatformEys` | RN 包**只做宿主适配 + 指标采集**，上报/采样/脱敏/重试/持久化全部复用内核，不重写 |
| RN 适配器 | `adapters.js` `createReactNativeAdapter` | 扩展而非替换：补 `appState`/`deviceInfo`/`frameCallback` 注入点，保持 `PlatformAdapter` 接口兼容 |
| 统一事件 schema | `packages/events-schema.js` | 移动端生命周期名直接命中既有 canonical/alias，本批**不新增 canonical** |
| 采集端点 | `POST /api/collect` + `x-app-key` | 完全一致，不新建协议 |
| 能力位（SDK 侧） | `platform.d.ts` `PlatformCapabilities` + `getCapabilities()` | 移动端宿主能力自查 |
| 应用平台标记 | `applications.platform` + 治理页下拉 | 移动端应用类型标记直接复用，不改表 |
| 远程采集配置 | `packages/collect-config.js` PLUGIN_KEYS `['performance','error','replay','behavior','exposure','trace']` | 移动端指标沿用 `performance`/`error`/`behavior` 三类开关，不新增插件键 |
| 符号化 | `POST /api/sourcemaps` | P1 占位复用 |
| 构建范式 | `packages/sdk` exports 子路径 + vite lib 多入口 | 新包复刻 `./react-native` 子路径导出风格 |
| 测试范式 | `packages/sdk/test/platform.test.js` | fake adapter 注入，Node 层断言 |

## 2. 产品目标

让 React Native App 用 **5 行代码**接入平台，即可获得**移动端专属可观测能力**（冷启动耗时、帧率/卡顿、崩溃、前后台会话、网络请求），数据落在**现有事件管道与现有控制台页面**里，后端零改造。

- **G1 接入即用**：5 行初始化 + 可选 1 个 AppState 监听，即完成错误/崩溃/网络/生命周期采集；不强制新增原生依赖（AsyncStorage 可注入、可降级）。
- **G2 移动指标可读**：冷启动耗时、帧率与卡顿、崩溃、前后台会话以**现有事件类型**进入 `/api/collect`，在现有「性能分析 / 错误监控 / 会话」页按 appId 直接可见，控制台零新增页。
- **G3 底座不腐化**：移动端逻辑全部收敛在新包内；SDK 核心、采集协议、事件 type 白名单、部署能力位、数据库 schema **五项均不改**。

## 3. 用户故事

- As a **App 前端负责人**, I want RN 应用 5 行接入就能看到冷启动耗时、崩溃率和帧率，so that 我能在发版后 30 分钟内判断这版 App 是否比上版更慢/更崩，而不必等应用商店评分反馈。
- As a **移动端开发者**, I want 崩溃（JS 异常 + 原生崩溃占位）与卡顿能自动上报并带上 App 版本 / 系统版本 / 设备型号维度，so that 我能把"用户说卡"定位到具体版本与机型，而不是靠猜测复现。
- As a **移动端开发者**, I want SDK 不强依赖 AsyncStorage，未注入时自动降级为内存队列且不崩溃，so that 我不想为一个监控 SDK 增加原生依赖与链接成本，接入风险可控。
- As a **平台管理员**, I want 移动端应用复用现有 `applications.platform` 标记与现有采集鉴权（appId + x-app-key），so that 不需要为移动端单独开一套应用管理、配额或部署开关。
- As a **自托管部署者**, I want 移动端数据走现有 `/api/collect` 与现有 events 表，so that 升级 SDK 即可获得移动端数据，无需迁移数据库或开启新的能力开关。

## 4. 核心概念定义

| 概念 | 定义 |
|---|---|
| 移动会话（mobile session） | 以 **App 冷启动**为会话起点（`session_started`，由 `app_start` alias 归一），以**切后台超过阈值（默认 30s）后再回前台**为会话切分点。会话 ID 由内核 `createPlatformEys` 生成并随每个事件上报；切后台立即 `flush(true)` 强制发送 |
| 冷启动（cold start） | 进程首次创建到**首屏可交互**的耗时（ms）。区分 `phase='cold'`（进程全新创建）/ `'warm'`（进程复用、仅 Activity 重建）。判据：SDK 在 JS 侧记录"模块首次求值时间戳"与"首帧回调时间戳"之差，必要时允许业务用 `markAppReady()` 校正终点 |
| 崩溃（crash） | ① **JS 崩溃**：未捕获 JS 异常 / Promise rejection 且导致应用不可用 → 复用 `error` 事件，`props.fatal=true`；② **原生崩溃（native crash）**：iOS/Android 原生层崩溃，**本批仅占位**（事件通道与字段预留、采集由宿主桥接提供），P2 做符号化 |
| 帧率 / 卡顿（frame stats） | 单位采样窗口内（默认 1s 汇总、按需上报节流）的实际 FPS、掉帧数（dropped frames）、长任务时长（long task ms）。RN 侧通过帧回调（`requestAnimationFrame` 或宿主 `FrameCallback`）计算，JS 线程阻塞导致的掉帧是本指标主要捕捉对象 |
| 网络请求埋点 | 复用内核 `wrapFetch` / `wrapRequest`：包装后自动产出 `perf` 事件（metric `fetch`），经 `eventCategory()` 归入 `requests` 采样分类，与 Web 端 API 性能视图口径完全一致 |
| 设备 / 系统 / App 版本维度 | `release` = App 版本（现成字段）；`userAgent` = 合成串 `ReactNative/<rnVersion> <os>/<osVersion> <deviceModel>`（现成字段，512 clip）；`context.device` / `context.os` / `context.app` / `context.network`（现成字段，4000 clip）。**零 schema 改动** |

## 5. 需求池

### P0（Must have）

| # | 需求 | 说明 |
|---|---|---|
| P0-1 | 独立 workspace 包 `packages/sdk-react-native` | 包名 `@web-collection/sdk-react-native`，v0.1.0；Vite lib 构建复刻 `vite.platform.config.js`；exports `.`（ESM + CJS + types）；`peerDependencies`：`react-native`、`@react-native-async-storage/async-storage`，均 `peerDependenciesMeta.optional=true`；`pnpm-workspace.yaml` 已含 `packages/*`，无需改 |
| P0-2 | 初始化与配置 | `createReactNativeEys(options, runtime)` 签名兼容现有 RN 适配层；配置项复用内核：`endpoint`(默认 `/api/collect`)、`appId`、`release`(App 版本)、`collectKey`(→`x-app-key`)、`environment`、`sampleRate`、`batchSize`、`flushInterval`、`maxQueue`、`maxRetries`、`privacy`、`beforeSend` |
| P0-3 | 存储适配（可注入 + 内存降级） | `runtime.storage` 注入 AsyncStorage；未注入 → 内存 `Map` 降级并 emit `storage_degraded` 诊断；复用内核持久化语义（QUEUE_KEY / DEVICE_KEY），保证 `deviceId` 跨启动稳定 |
| P0-4 | 会话与 AppState 生命周期 | AppState 监听：`active` → `app_foreground`、`background` → `app_background` + `flush(true)`；冷启动 → `app_start`（归一为 `session_started`）；后台超阈值（默认 30s）回前台判定新会话。命名与内核 `instrumentApp` 保持一致 |
| P0-5 | 崩溃与 JS 错误捕获 | `ErrorUtils.setGlobalHandler` 捕获未处理 JS 异常 + unhandled rejection → `error` 事件，`props.fatal=true`；原生崩溃**预留通道与字段、本批不采集**；复用内核 1s 指纹去重与面包屑附带（内核已实现） |
| P0-6 | 移动端指标事件 | 全部复用现有 type，见 §6.1 映射表：`app_cold_start`(perf, ms)、`frame_stats`(perf, fps + 卡顿 props)、网络请求(复用 `wrapFetch` → metric `fetch`)、前后台(behavior) |
| P0-7 | 统一事件 schema 对齐 | **不新增 type**（双栈 sanitize 封闭白名单硬约束）；`packages/events-schema.js` 本批**不新增 canonical**；metric 命名须 ≤32 字符（服务端 `clip(metric, 32)`），`app_cold_start`(13) / `frame_stats`(11) 均通过 |
| P0-8 | 批量上报与离线缓存 | 复用内核：批量 ≤100/批、`maxQueue` 溢出丢最旧、持久化队列、`maxRetries=3` + 指数退避、4xx 不可重试永久丢弃、切后台 `flush(true)`。**移动端 `maxQueue` 默认上调至 500**（离线时长更长、单条事件更小） |
| P0-9 | 设备 / 系统 / App 版本维度 | 写入 `release` / `userAgent` / `context`（见 §4），零 schema 改动 |
| P0-10 | 基础用法文档 | 扩写 `packages/sdk/README.zh-CN.md:830` 现有 RN 段落 + 新包 README：最小接入（5 行）、完整接入（存储注入 + AppState + 崩溃 + fetch 包装）、自测片段（`eys.track('smoke')` + `flush`）、字段与口径说明 |

### P1（Should have）

| # | 需求 | 说明 |
|---|---|---|
| P1-1 | **Flutter 契约文档**（本批 Flutter 侧唯一交付） | 见 §6.3：MethodChannel 方法签名、事件字段、桥接约定、与 RN 包的对齐矩阵；明确标注 **deferred**，待具备 Dart 工具链后实施。**不含 Dart 代码** |
| P1-2 | React Hook `useWebCollection`（RN 版） | 对齐 `@web-collection/sdk/react` 现有 `packages/sdk/src/react/index.js` 范式，提供页面级 `pv`/`page_leave` 与 setContext 的 Hook 封装 |
| P1-3 | 源码映射 / 符号化占位 | 复用 `POST /api/sourcemaps`（`apps/api/src/index.js:179`）；给出 Hermes bundle sourcemap 上传脚本占位与 `release` 绑定规范 |
| P1-4 | 崩溃分组 | 复用现有错误聚合（`/api/issues`）；增加 `props.fingerprint` 支持，供原生崩溃栈归一组 |
| P1-5 | 控制台应用类型下拉补 `flutter` | `governance/index.vue:244` 选项数组新增 `flutter`（为 P2 Flutter 预留）。顺带修正既有取值不一致：治理页用 `miniapp`、设置页用 `miniprogram`（`settings/index.vue:273`） |
| P1-6 | 维度筛选 UI | 在现有筛选器上按 `release` / UA 解析出的系统版本 / 机型做下钻（依赖 P0-9 已落库的维度） |

### P2（Nice to have）

| # | 需求 | 说明 |
|---|---|---|
| P2-1 | 原生崩溃符号化 | iOS dSYM / Android `mapping.txt` 上传与符号还原 |
| P2-2 | ANR / OOM 检测 | Android ANR 与内存 OOM 信号采集 |
| P2-3 | **Flutter 实现** | 按 P1-1 契约文档实施，需 Dart 工具链 |
| P2-4 | 移动端专属看板 | 冷启动 P95 / 崩溃率 / 帧率分布，按 App 版本 × 系统版本 × 机型下钻 |

## 6. 关键设计决策

### 6.1 事件映射：复用现有 type + props，**不新增 type**（默认决策，硬约束驱动）

**倾向：100% 复用现有 type，移动端语义由 `name` / `metric` / `props` 承载**，理由：

1. **硬约束**：`apps/api/src/index.js:839` 与 `cloudflare/worker.js:2478` 两处 `sanitize` 均为封闭白名单 `['track','perf','performance','behavior','error','replay','log','trace']`，新增 type 会被**双栈同时拒收**（`throw new Error('bad event type')`）。改白名单意味着 Node + Worker 两端同时发版——这是**服务端改造**，与"SDK 侧可独立交付"的立项前提冲突。
2. 新增 type 会牵动 `eventCategory()`（`core/event.js:54`）采样分类、`collect-config` 插件键、控制台按 type 的列表页与 retention 清理 SQL（`worker.js:2472` 按 `type='log'` 分别清理）——**改动面远超 SDK**。
3. 复用 type 反而**自动获得全部既有能力**：错误进 issues 聚合与告警、网络 metric 名 `fetch` 自动归入 `requests` 采样分类与 API 性能视图、生命周期名自动被 `events-schema.js` 归一为 canonical。

**移动端事件映射表（本批唯一新增的是 `name`/`metric` 取值，不是 type）**：

| 移动端语义 | type | name / metric | 关键 props | 归类（category） |
|---|---|---|---|---|
| 冷启动 | `perf` | `app_cold_start` | `phase: 'cold'｜'warm'`, `appReadyMs` | `performance` |
| 帧率 / 卡顿 | `perf` | `frame_stats` | `fps`, `droppedFrames`, `longTaskMs`, `sampleWindowMs` | `performance` |
| 网络请求 | `perf` | `fetch`（复用 `wrapFetch`） | 与 Web 端完全一致 | `requests` |
| JS 崩溃 / 异常 | `error` | err.name | `fatal: true`, `source: 'global'｜'unhandledrejection'` | `error` |
| 原生崩溃（占位） | `error` | `NativeCrash` | `kind: 'native_crash'`, `fatal: true`, `nativeStack` | `error` |
| 前台 / 后台 | `behavior` | `app_foreground` / `app_background` | `elapsedMs` | `behavior` |
| 会话起点 | `behavior` | `app_start`（→ 归一 `session_started`） | — | `behavior` |
| 页面进出 | `behavior` | `pv` / `page_leave`（→ 归一 `page_viewed` / `page_left`） | `route`, `stayTime` | `behavior` |
| 业务埋点 | `track` | 业务自定义 | 业务自定义 | — |

**代价与边界**：移动端与 Web 端在 `perf` 表内靠 `metric` 名区分，`name`/`metric` 字段受服务端 clip 约束（`name` 160 / `metric` 32）——移动端 metric 名必须简短；维度筛选需依赖 `props_json` / `context`，不如独立列高效（P2-4 看板若需高频下钻，再评估预聚合日表）。

### 6.2 RN 包形态：独立 workspace 包，而非 SDK 子路径（默认决策）

**倾向：新建 `packages/sdk-react-native`（`@web-collection/sdk-react-native`）**，理由：

1. **依赖隔离**：RN 需要 `AsyncStorage` / `AppState` / `NetInfo` / `react-native` 核心等**原生模块**。这些绝不能出现在 Web SDK 的依赖图里——独立包可用 `peerDependencies` + `peerDependenciesMeta.optional` 声明，Web 用户零成本（现状 `packages/sdk/package.json` 已用同样手法把 `react` 声明为 optional peer）。
2. **产物隔离**：`packages/sdk` 的 `dist/web-collection-sdk.platform.js` 被 `apps/api/src/index.js:766` **静态托管分发**给所有接入方。在其上新增 RN 专属构建入口，会同时增大小程序 / UniApp / Taro 用户的下载体积——**用别人的带宽为 RN 买单**。
3. **版本解耦**：RN 包从 v0.1.0 起步，可快速迭代而不阻塞 `@web-collection/sdk` v0.4.0 的发版节奏；RN 生态（RN 版本、Hermes、新架构）迭代快于 Web SDK。

**代价与边界**：需在新包内 `dependencies` 声明 `@web-collection/sdk`（workspace 协议）以复用 `createPlatformEys` / `createReactNativeAdapter` / sanitizer / sampler；新包需自建 vite 构建与测试脚本（复刻现有范式，成本低）。现有 `./react-native` 子路径**保留不动**（向后兼容），文档引导新用户迁移到新包。

### 6.3 Flutter 本批只出契约文档（范围裁剪，理由必须写明）

**本仓库是 JS/TS 生态（pnpm workspace + Vite 构建），无 Dart SDK / Flutter 工具链，无法构建、无法跑测试、无法验证任何 Flutter 插件代码。** 在此条件下产出 Dart 实现，等于交付**未经任何验证的代码**——违反团队"绝不上报未验证能力"（README 原则 #4）的底线。

因此本批 Flutter 侧交付**接口契约 + 事件 schema 对齐文档**，内容包括：

- MethodChannel 通道名与方法签名（与 RN 包对齐的初始化 / 存储注入 / 生命周期 / 崩溃 / 指标上报）
- 事件字段契约：与 §6.1 映射表**逐行一致**（同一份 `name`/`metric`/`props`，保证双端数据在控制台可合并分析）
- 桥接约定：原生崩溃采集的宿主侧接口、帧率回调的宿主侧接口、Dart 侧错误捕获（`FlutterError.onError` / `PlatformDispatcher.instance.onError`）的映射关系
- 明确标注 **deferred**，并列出实施前置条件（Dart/Flutter 工具链 + 可运行的示例 App + CI 集成）

**这是基于工程可验证性的务实裁剪，不是能力缩水**：契约文档把"设计决策"与"代码实现"解耦——决策（事件口径、字段、桥接约定）在本批由 RN 侧**实跑验证**，Flutter 实施时只需按契约填充实现，返工风险反而更低。

### 6.4 不新增部署能力位 `mobile`（默认决策）

**倾向：不新增**，理由：

1. `packages/deployment-capabilities.js` 的能力位是**部署侧（服务端）能力开关**，语义是"本部署是否提供该能力"，驱动 `/api/capabilities` 并控制前端入口显隐。移动端**不新增任何服务端端点、不新增表、不新增查询能力**——同一 `/api/collect` + 同一 events 表即可承载。
2. 若登记 `mobile: false`（Worker 侧默认），等于宣布"本部署不支持移动端数据"，前端据此隐藏入口——**与事实不符**（Worker 的 `/api/collect` 完全能收移动端事件），属于"静默隐藏"违规。
3. 移动端**宿主能力自查复用 SDK 侧既有体系**：`platform.d.ts` `PlatformCapabilities` + `core.js` `getCapabilities()` + `requireCapability()` 静默降级。两套能力位语义不同（部署能力 vs 宿主能力），**不混用**。
4. 应用"是不是移动端"由 `applications.platform` 表达（`0001_init.sql:9` 已存在，治理页下拉已含 `react-native`），查询层无需开关即可区分。

## 7. 接入示例与代码片段（本项无控制台新页）

### 7.1 SDK 侧"界面"即开发者体验——三级接入片段

**A. 最小接入（5 行，零原生依赖）**

```ts
import { createReactNativeEys } from '@web-collection/sdk-react-native'

export const eys = createReactNativeEys({
  endpoint: 'https://monitor.example.com/api/collect',
  appId: 'mall-rn',
  release: '1.0.0'          // App 版本，作为维度落 release 字段
}, { collectKey: '<x-app-key>' })
```

未注入 storage 时自动降级为内存队列并 emit `storage_degraded` 诊断——**不崩溃、不报错**。

**B. 完整接入（存储注入 + AppState + 崩溃 + 网络）**

```ts
import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState } from 'react-native'
import { createReactNativeEys } from '@web-collection/sdk-react-native'

export const eys = createReactNativeEys({
  endpoint: 'https://monitor.example.com/api/collect',
  appId: 'mall-rn',
  release: '1.0.0',
  collectKey: '<x-app-key>',
  maxQueue: 500             // 移动端离线队列上限（默认 500）
}, {
  storage: AsyncStorage,                                   // 离线缓存持久化
  appState: AppState,                                      // 前后台 → app_foreground/background + flush
  getContext: () => ({ path: navigationRef.getCurrentRoute()?.name || '' })
})

global.fetch = eys.wrapFetch(global.fetch)                  // 网络请求 → metric `fetch`
```

**C. 自测片段**（用于 Node 层行为验证，无需模拟器）

```ts
eys.track('smoke_test', { from: 'rn' })
await eys.flush(true)
// 断言：POST /api/collect 携带 x-app-key、events[0].appId === 'mall-rn'
```

测试范式复刻 `packages/sdk/test/platform.test.js`：注入 fake adapter，在 Node 下断言入队 / 脱敏 / 鉴权头 / flush 行为。

### 7.2 平台侧：零新页，复用现有应用类型标记

- **不新增控制台页面**。移动端事件以现有 type 入库，在现有「性能分析（`perf`）/ 错误监控（`error`）/ 会话（`behavior` + sessionId）」页按 `appId` 自然呈现。
- **应用类型标记复用 `applications.platform`**（`cloudflare/migrations/0001_init.sql:9`，`default 'web'`）。治理页下拉已含 `react-native`（`apps/web/src/views/monitor/governance/index.vue:244`）→ **本批不改表、不改后端**；P1-5 仅补 `flutter` 选项。
- P2-4 才考虑移动端专属看板（冷启动 P95 / 崩溃率 / 帧率分布）。

## 8. 范围红线

1. **SDK 仍是通用技术底座**：移动端只做**平台适配层**与**指标采集**，**业务事件契约不进 SDK 核心**。业务埋点一律走通用原语 `track(name, props)`，SDK 不知道"下单/支付/加购"语义。
2. **不改 SDK 核心行为**：`packages/sdk/src/index.js`（Web 内核）与 `packages/sdk/src/platform/core.js`（通用平台内核）不因 RN 新增分支；RN 专属逻辑全部收敛在 `packages/sdk-react-native` 内。
3. **不新建采集协议 / 端点**：仅复用 `POST /api/collect` + `x-app-key` 鉴权头（与 Web 端完全一致）。
4. **不新增事件 type**：遵守双栈 `sanitize` 封闭白名单（§6.1）。
5. **不新增部署能力位、不改数据库 schema**：`deployment-capabilities.js` 与所有迁移文件均不动（§6.4）。
6. **Flutter 本批只出契约文档**：无 Dart 代码、不引入 Dart 工具链。这是基于**工程可验证性**的务实裁剪——仓库为 JS/TS pnpm workspace，无 Dart SDK，无法构建与验证 Flutter 插件；交付未验证代码违反「绝不上报未验证能力」原则。**不是能力缩水**：契约把设计与实现解耦，决策已由 RN 侧实跑验证，Flutter 实施返工风险更低（§6.3）。

## 9. 待确认问题

| # | 问题 | 默认决策（未回复即按此执行） | 影响面 |
|---|---|---|---|
| Q1 | RN 包做成独立 workspace 包，还是 `@web-collection/sdk` 的新子路径？ | **独立包 `packages/sdk-react-native`**。理由：原生模块依赖隔离（optional peerDeps）、避免增大被静态托管的 `platform.js` 产物体积、版本解耦。现有 `./react-native` 子路径保留向后兼容 | 构建 / 发布 / 依赖图 |
| Q2 | AsyncStorage 硬依赖，还是可注入 + 降级？ | **可注入 + 内存降级**。未注入时降级内存 `Map` 并 emit `storage_degraded` 诊断，不抛错。与现有适配器 `runtime.storage` 可选设计及 README「SDK 不强制增加存储依赖」一致 | 接入成本 / 离线能力 |
| Q3 | 移动端事件用新 type，还是复用现有 type + props？ | **复用现有 type + props**（§6.1）。硬约束：双栈 `sanitize` 封闭白名单会拒收新 type；且改白名单牵动采样分类、插件键、控制台与清理 SQL | 事件契约 / 后端改造量 |
| Q4 | 离线队列上限与丢弃策略？ | **移动端 `maxQueue` 默认 500**（Web/平台层默认 200），溢出**丢弃最旧**；`maxRetries=3` + 指数退避（base 500ms / max 30s）；4xx 不可重试永久丢弃；切后台 `flush(true)`。全部复用内核现成语义，仅调默认参数 | 离线数据完整性 / 内存占用 |
| Q5 | 是否新增 `mobile` 部署能力位？ | **不新增**（§6.4）。能力位是部署侧语义，移动端无服务端新增能力；登记 false 会导致前端静默隐藏入口，与事实不符。宿主能力自查复用 SDK 侧 `PlatformCapabilities` + `getCapabilities()` | 控制台入口 / 双栈一致性 |

**附：待与现有 Web 会话口径对齐的一项（不阻塞开工）**——移动端会话切分阈值默认取「后台 30s 后再回前台算新会话」，需与现有 `sessions` 表口径核对后确认；若不一致，以现有 Web 口径为准对齐，避免同一平台两套会话定义。
