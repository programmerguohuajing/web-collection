# Web Collection SDK — Worker 相关可新增能力清单（基于 MDN）

> 调研依据：MDN 上 `WorkerGlobalScope` / `DedicatedWorkerGlobalScope` / `SharedWorkerGlobalScope` /
> `ServiceWorkerGlobalScope` / `WorkerNavigator` / `WorkerLocation` / `ServiceWorkerContainer` /
> `ServiceWorkerRegistration` 全部实例属性、事件、方法。
> SDK 现状：仅 `workerMonitoring`（Web Worker 错误，默认关）、`serviceWorkerMonitoring`
> （SW controllerchange + messageerror + active/updated，默认关），以及 environment 里的
> `features.serviceWorker` / `features.webWorker` 布尔检测。

## 0. 架构前提（必须先知道）

SDK 当前只运行在 **主线程（window 上下文）**。而 `WorkerGlobalScope` / `WorkerNavigator` /
`WorkerLocation` **只存在于 Worker 内部作用域**，SDK 在主线程拿不到它们，除非 SDK 被**显式加载进
Worker**（新增 worker-mode 入口）。

这把能力分成两类，ROI 与风险完全不同：

| 类别 | 是否需要改动架构 | 示例 |
|---|---|---|
| **A. 主线程可观测增强** | 否，纯增量 | SW 注册快照、SW 更新生命周期、SW 脚本错误、SharedWorker 主线程监控、SW 能力探测 |
| **B. Worker 内部可见性** | 是，需新增 worker-mode 入口 | WorkerNavigator/Location 快照、Worker Promise 拒绝、Worker CSP 违规、Worker 性能 |

## 1. Track A — 主线程可观测增强（建议优先，无需新架构）

| # | 能力 | 来源(MDN) | 当前状态 | 优先级 | 说明 |
|---|---|---|---|---|---|
| A1 | SW 注册快照（active/waiting/installing + scope + updateViaCache） | ServiceWorkerRegistration | 仅采 active/updated 的 scriptURL | **P0** | 初始化时 `getRegistration()` 拉全量，定位"卡在 waiting"等真实故障 |
| A2 | SW 更新生命周期（updatefound / installing→waiting→active 流转） | ServiceWorkerRegistration.updatefound + 容器事件 | 无 | **P0** | 最常见的 SW 上线 bug：新版本卡 waiting 不激活 |
| A3 | SW 脚本错误（ServiceWorkerContainer `error` 事件） | ServiceWorkerContainer.error | 仅采 `messageerror` | P1 | 补上 SW 自身脚本异常（目前漏采） |
| A4 | SW 能力探测（pushManager 权限/订阅、Background Sync、navigationPreload、periodicSync） | ServiceWorkerRegistration.* | 无 | P2 | 进 environment.features，仅布尔/轻量 |
| A5 | SharedWorker 主线程监控（proxy SharedWorker 构造，采 connect/error/messageerror） | SharedWorker / SharedWorkerGlobalScope | 完全无 | P1 | 复用现有 Worker proxy 思路，无需 worker 入口即可采错误/连接 |
| A6 | SharedWorker 支持检测 feature flag | — | environment.features 无此项 | P2 | 补 `features.sharedWorker` 布尔 |

## 2. Track B — Worker 内部可见性（需新增 worker-mode 入口）

> 前置：SDK 需提供可在 Worker 内 `import` 的入口，初始化时上报一份 worker 上下文快照回主线程/
> 直报。否则以下属性在架构上拿不到。

| # | 能力 | 来源(MDN) | 当前状态 | 优先级 | 说明 |
|---|---|---|---|---|---|
| B1 | Worker 环境快照（hardwareConcurrency / deviceMemory / connection.effectiveType / onLine / languages / userAgentData） | WorkerNavigator | 完全无（仅主线程 navigator） | P1 | 直接回答上一轮"WorkerNavigator 未采" |
| B2 | Worker 脚本定位（WorkerLocation：scriptURL/origin/protocol/host） | WorkerLocation | 完全无 | P2 | 区分 blob: / 同源 / 跨域 worker 脚本，利于定位 |
| B3 | Worker Promise 拒绝（unhandledrejection / rejectionhandled） | WorkerGlobalScope 事件 | 漏采（仅 error+messagerror） | **P0** | 异步 Worker 代码的头号盲区，必须进 worker 才能采 |
| B4 | Worker CSP 违规（securitypolicyviolation） | WorkerGlobalScope 事件 | 无 | P1 | 安全遥测，worker 内 CSP 比主线程更易被忽略 |
| B5 | Worker 生命周期（DedicatedWorker.close 提前终止 / SharedWorker.connect 连接数 / name） | Dedicated/SharedWorkerGlobalScope | 无 | P2 | SharedWorker connect 可观测多页面共享连接 |
| B6 | Worker 网络状态（online/offline 事件） | WorkerGlobalScope 事件 | 无 | P3 | 与主线程 online 互补 |
| B7 | Worker 性能（performance：long tasks / resource timing） | WorkerGlobalScope.performance | 无（仅主线程 performance） | P2 | Worker 内长任务/资源耗时 |
| B8 | Worker 安全上下文（isSecureContext / crossOriginIsolated） | WorkerGlobalScope | 无 | P3 | worker 上下文安全态势 |

## 3. Track C — Service Worker 内部（一般不建议）

SW 生命周期短、重启频繁。`install/activate/fetch/push/sync` 等事件只有把 SDK 打进 SW 才能采，
ROI 低、侵入性强，**默认不做**；若消费方有强需求再单独评估。

## 4. 优先级总览

- **立刻做（P0）**：A1、A2、B3（Worker Promise 拒绝，需 worker-mode）。
- **近期（P1）**：A3、A5、B1、B4。
- **按需（P2/P3）**：A4、A6、B2、B5、B6、B7、B8。

## 5. 关键架构决策（ADR 草稿，待确认）

**ADR-Worker-Visibility：是否引入可选 worker 入口以支撑 Track B？**

- **Context**：当前 SDK 仅主线程运行，无法观测 Worker 内部上下文（WorkerNavigator/Location/
  GlobalScope 事件）。上一轮已确认这四类目前零采集。
- **Decision（建议）**：先落地 Track A（零架构改动、高 ROI）；Track B 以**可选 worker 入口**
  `@web-collection/sdk/worker` 提供，由消费方在其 Worker 内 `import` 初始化，不让主包耦合。
- **Consequences**：
  - 收益：真正的 worker 内部可见性（B1–B8），尤其补上 Promise 拒绝这一大盲区。
  - 代价：消费方需改动 Worker 代码接入 SDK（多一份 bundle 面）；worker 入口与主包共享核心、
    需保证核心 SDK 外部化（复用现有 React 集成的 externalize 经验）。
  - 若**不**引入该入口，则 Track B 全部无法实现，只能做 Track A。

## 6. 对照上一轮结论

上一轮确认「SharedWorker / WorkerGlobalScope / WorkerLocation / WorkerNavigator」当前零采集。
本清单中：
- A5/A6 在不改架构前提下，先把 **SharedWorker 的错误/连接监控 + 支持检测**补上；
- B1/B2/B3/B4/B5/B7/B8 才是真正把 **WorkerNavigator / WorkerLocation / WorkerGlobalScope**
  采出来的路径，但都依赖第 5 节的 worker 入口决策。
