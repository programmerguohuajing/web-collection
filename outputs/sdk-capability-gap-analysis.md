# Web Collection SDK 能力缺口调研（基于 MDN Web API 全量清单）

> 调研时间：2026-08-14
> 对照基准：MDN 中文站 Web API 参考（按领域归类的 200+ 接口全集）
> 对照对象：`packages/sdk` 源码 + `README.zh-CN.md` 现有能力
> 目标：找出 SDK **当前未覆盖、但属于前端遥测/可观测性范畴、可低成本新增**的能力，先输出清单，不实现。

---

## 0. 调研方法

1. 抓取 MDN Web API 全量接口，按 9 大领域归类：通信/网络、存储、设备硬件、媒体图形、用户交互、身份安全隐私、后台/性能、文件编码、综合 DOM。
2. 盘点 SDK 现状（源码 + README），区分「已覆盖 / 部分覆盖 / 未覆盖」。
3. 对「未覆盖」项，按「遥测价值 × 实现成本 × 隐私风险」评定优先级。

---

## 1. SDK 已覆盖（无需重复建设）

| 领域 | 已覆盖能力 |
|---|---|
| **错误** | JS 运行时错误、资源加载错误、未捕获 Promise、Fetch/XHR/WebSocket/SSE 错误；Web Worker 错误（opt-in）、Service Worker 错误（opt-in）；Vue/React 渲染错误 |
| **性能** | navigation 拆解、TTFB、FP、FCP、LCP、TTI、TBT、FID、INP、CLS、longtask、白屏/白屏率、JS 堆内存、资源失败率、缓存命中率、路由渲染耗时、资源加载、包体摘要、Server-Timing 解析 |
| **请求/网络** | Fetch、XMLHttpRequest、WebSocket、EventSource(SSE)，含 W3C `traceparent` 链路注入与 Span |
| **行为** | pv、page_leave、click、scroll、路由切换(pushState/replaceState/popstate/hashchange)、曝光；表单/狂点/死点/通用交互/下拉/输入/键盘/触摸（后 7 项 opt-in）；事务 |
| **生命周期** | app_start、app_foreground/background(visibilitychange)、network_change(online/offline)、pagehide 冲刷 |
| **环境指纹** | 屏幕/视口、语言/时区、platform/vendor、cookieEnabled、doNotTrack、NetworkInformation 快照、Battery 快照、特性支持位（serviceWorker/webWorker/sharedArrayBuffer/webAssembly/intersectionObserver/performanceObserver） |
| **其他** | 会话回放(rrweb)、分布式链路、隐私脱敏引擎、IndexedDB+Beacon 可靠传输、诊断事件、能力位自查 `getCapabilities()` |

> 注：上面「已覆盖」里 `online/offline`、`visibilitychange` 是本次核验后才确认的——初看容易误判为缺口，已排除。

---

## 2. 可增加能力清单（按优先级）

类型说明：**环境**=初始化时一次性采集的静态/半静态信息；**监控**=持续产生的事件/指标；**错误**=错误/异常捕获。
默认策略：**默认开**=低风险、无敏感数据、自动有价值；**opt-in**=需显式开关（隐私/合规/成本）。

| # | 能力 | MDN 来源 | 采集内容 | 类型 | 建议默认 | 复杂度 | 优先级 |
|---|---|---|---|---|---|---|---|
| 1 | **UA Client Hints** | User-Agent Client Hints (`NavigatorUAData`) | `userAgentData`：浏览器品牌/版本、设备型号、CPU 架构、位数、是否移动端、formFactors | 环境 | 默认开 | 低 | **P0** |
| 2 | **CPU 核数** | `navigator.hardwareConcurrency` | 逻辑 CPU 核数 | 环境 | 默认开 | 低 | **P0** |
| 3 | **设备内存** | Device Memory API (`navigator.deviceMemory`) | 设备 RAM(GB，2 的幂) | 环境 | 默认开 | 低 | **P0** |
| 4 | **Reporting API 监控** | Reporting API (`ReportingObserver`/`Report`) | 浏览器下发的弃用警告、干预(intervention)、CSP 违规、可信类型违规、崩溃报告 | 错误/监控 | 默认开 | 低 | **P0** |
| 5 | **页面生命周期 & bfcache** | Page Lifecycle + bfcache | `pageshow`(persisted→bfcache 命中)、`freeze`/`resume`(后台冻结)、`pagehide`(persisted→bfcache 未命中)、`visibilitychange` 已覆盖 | 监控 | 默认开 | 低 | **P0** |
| 6 | **WebGL/WebGPU 上下文丢失** | Canvas/WebGL/WebGPU (`webglcontextlost`/`contextlost`) | 显卡上下文丢失/恢复事件，定位渲染黑屏、图形崩溃 | 错误/监控 | opt-in | 低 | P1 |
| 7 | **媒体元素错误** | HTMLMediaElement (`<video>/<audio>` error) | 播放失败、解码错误、网络错误（媒体类站点高频问题） | 错误/监控 | opt-in | 低 | P1 |
| 8 | **网络质量变化** | Network Information API (`change` 事件) | 网络类型/下行速率/RTT/saveData 实时变化（env 已采快照，缺变化事件） | 监控 | 默认开 | 低 | P1 |
| 9 | **存储配额用量** | Storage API (`navigator.storage.estimate()`) | 应用 IndexedDB/localStorage 已用/配额，辅助诊断 SDK 自身队列与业务存储压力 | 环境/监控 | 默认开 | 低 | P1 |
| 10 | **权限状态** | Permissions API (`navigator.permissions`) | 通知/定位/相机/麦克风等权限授予状态快照 | 环境 | opt-in | 低 | P1 |
| 11 | **屏幕方向** | Screen Orientation API (`screen.orientation`) | 方向类型/角度 + `orientationchange` 事件 | 环境/监控 | 默认开 | 低 | P1 |
| 12 | **安全上下文 & 触摸能力** | `navigator.isSecureContext` / `navigator.maxTouchPoints` | HTTPS 上下文标记、最大触摸点数 | 环境 | 默认开 | 低 | P1 |
| 13 | **元素级性能 (Element Timing)** | PerformanceElementTiming | LCP/关键元素的元素级耗时与归属（当前 LCP 只给时间点，不给元素） | 监控 | opt-in | 中 | P2 |
| 14 | **SharedWorker 监控** | SharedWorker / SharedWorkerGlobalScope | 对照 Worker/SW 已支持，补齐 SharedWorker 错误与消息错误监听 | 错误 | opt-in | 中 | P2 |
| 15 | **Worker 上下文环境探针** | WorkerGlobalScope / WorkerNavigator / WorkerLocation | 在 Worker 内采集 UA/语言/平台（即 WorkerNavigator），回应此前关于 Worker 作用域属性的问题 | 环境 | opt-in | 中 | P2 |
| 16 | **WebRTC 连接质量** | WebRTC (`RTCPeerConnection.getStats`) | RTT、抖动、丢包、码率、分辨率（RTC/音视频产品的核心可观测性） | 监控 | opt-in | 高 | P2 |
| 17 | **计算压力** | Compute Pressure API (`PressureObserver`) | CPU/内存压力信号（新标准，渐进增强） | 监控 | opt-in | 中 | P2 |
| 18 | **Service Worker 全生命周期** | Service Worker API | 现有仅 active/updated+messageerror；补齐 installing/installed/waiting/redundant/updatefound 状态 | 监控 | 默认开 | 低 | P2 |
| 19 | **全屏状态** | Fullscreen API (`fullscreenchange`) | 进入/退出全屏（视频/沉浸式应用） | 监控 | opt-in | 低 | P3 |
| 20 | **Web Share 意图** | Web Share API (`navigator.share`) | 分享触发与成败（需包裹，隐私低风险） | 监控 | opt-in | 低 | P3 |
| 21 | **剪贴板操作** | Clipboard API | 复制/粘贴意图（隐私敏感，必须 opt-in 且只记元数据不记内容） | 监控 | opt-in | 低 | P3 |

### P0 详细说明（建议优先落地）

- **#1 UA Client Hints**：比解析 `navigator.userAgent` 字符串更可靠、更结构化，且是 UA 缩减趋势下的官方替代。属于"全采集、按需取值"原则下的环境字段扩充，无隐私新增风险。
- **#2/#3 硬件画像**：`hardwareConcurrency` 与 `deviceMemory` 是零成本的设备算力画像，对"低端机性能问题"归因极有价值，且不暴露任何 PII。
- **#4 Reporting API**：浏览器主动上报的弃用/干预/CSP/崩溃信息，目前完全落入盲区。用一个 `ReportingObserver` 即可批量捕获，是性价比最高的"免费"可观测性来源，且天然不含业务 PII。
- **#5 页面生命周期/bfcache**：bfcache 命中率直接决定二次访问速度，当前 `pagehide` 只做冲刷、不区分是否走 bfcache；补齐 `pageshow.persisted` 与 `freeze/resume` 可量化"后台冻结"与"缓存恢复"两大体验指标。

---

## 3. 不建议默认开启 / 需显式 opt-in（隐私或合规）

| 能力 | MDN 来源 | 风险 | 建议 |
|---|---|---|---|
| 地理定位 | Geolocation API | 精确位置=强 PII | 不内置，仅作为业务自定义 `track` 由接入方自行上报 |
| 设备方向/运动、传感器 | DeviceOrientation/Motion、Accelerometer 等 | 运动/环境传感数据 | opt-in，且仅在明确场景开启，默认关闭 |
| 相机/麦克风/蓝牙/USB/HID/串口 | WebRTC/WebBluetooth/WebUSB/WebHID/Web Serial | 设备枚举=指纹+隐私 | 不主动采集，按需由业务上报 |
| 剪贴板内容 | Clipboard API | 可能含敏感文本 | 仅记元数据（操作类型），绝不记内容 |

> 与项目"采集层不主动丢弃、过滤下沉到入库/查询层"的原则一致：SDK 可在 opt-in 下采集上述原始信号，但**默认关闭**；是否入库/展示由下游按合规策略决定。

---

## 4. 建议落地顺序

1. **第一批（P0，低成本高价值，可一次性并入环境/监控模块）**：#1 UA Client Hints、#2 核数、#3 设备内存、#4 ReportingObserver、#5 生命周期/bfcache、#12 安全上下文/触摸点（顺手）。
2. **第二批（P1，补强专项体验与稳定性）**：#6 图形上下文、#7 媒体错误、#8 网络质量变化、#9 存储配额、#10 权限、#11 屏幕方向。
3. **第三批（P2，专项/长尾）**：#13 元素级性能、#14 SharedWorker、#15 Worker 上下文探针、#16 WebRTC、#17 计算压力、#18 SW 全生命周期。
4. **第四批（P3，长尾/低优先）**：#19 全屏、#20 Web Share、#21 剪贴板元数据。

---

## 5. 备注与下一步

- 本清单为**调研产出**，未改动任何代码。
- 若确认方向，建议从 P0 六项起步，按"环境字段走 `setupEnvironmentMonitor` 扩展、监控/错误走独立 `setup*Monitor` 子模块（沿用现有 `safe()` 容错 + `requireCapability` 能力位门控）"的模式落地。
- 每项新增均应遵循现有隐私档位（balanced 默认）与 `beforeSend`/`consent` 门控，确保 opt-in 项默认不采集、不破坏"全采集"原则。
