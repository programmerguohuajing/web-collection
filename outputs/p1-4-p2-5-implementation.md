# P1-4 能力位静默降级 · P2-5 双 ID + 启动排队 —— SDK 落地

> 在 `@web-collection/sdk` 核心落地 juxonmedia 对比中保留的两项能力（P0-1/P0-2/P1-3 已与用户对齐拒绝）。
> 目标：内部健壮性 + 零数据丢失，**用户无感、不绑业务、不违背"全采集"原则**。

## 一、P1-4 能力位 + 静默降级
- 适配器声明 `capabilities` 能力位图（`dom / exposure / replay / networkStatus / navigation / storage / beacon / visibility`）。
- SDK 装配阶段用 `requireCapability(name, { required })` 门控：未声明的能力**静默跳过**对应监听/采集，并 `emit('capability_missing')` 诊断。
- 平台适配器 `createMiniProgramAdapter` / `createReactNativeAdapter` 已声明各自宿主缺的能力位。
- Web SDK（createEys）用 `webCapabilities` 做 feature-detect（无 `IntersectionObserver` → `exposure:false`），曝光采集与 global-errors 的 network/navigation 监听均按能力位门控。

## 二、P2-5 双 ID + 启动排队
- **双 ID**：`anonymousId` = 既有 `deviceId`（设备级稳定，随所有事件 `deviceId` 字段随行）；`identify(userId, traits?)` 复用 `setUser` 回填 `userId`；新增 `getAnonymousId()`。
- **启动排队**：Web / 平台层各加 `pendingTracks` 缓冲；`ready` 未 resolve 前的事件入缓冲，`ready` 后 splice 回放并 `emit('pending_replayed')`。平台 ready=`hydrate()`（异步存储），Web 同步就绪但结构统一。**早期初始化事件零丢失**。

## 三、改动文件
| 文件 | 改动 |
|---|---|
| `packages/sdk/src/platform/adapters.js` | 小程序 / RN 适配器声明 `capabilities` |
| `packages/sdk/src/transport/diagnostics.js` | `DIAGNOSTIC_TYPES` 增 `capability_missing` / `pending_replayed` |
| `packages/sdk/src/platform/core.js` | 平台层 `requireCapability` + `pendingTracks` 缓冲/回放 + `getCapabilities`/`identify`/`getAnonymousId` |
| `packages/sdk/src/index.js` | Web 层 `webCapabilities` + `requireCapability` + `pendingTracks` 缓冲/回放 + 上述 API |
| `packages/sdk/platform.d.ts` / `index.d.ts` | 新增 `getCapabilities` / `identify` / `getAnonymousId`；`DiagnosticType` 增两项 |
| `packages/sdk/test/capabilities-identity.test.js` | **新增** 4 用例，已接入 `package.json` 的 `test` 脚本 |

## 四、验证结果
- `node --check` 四个运行时文件全部通过。
- 回归：`replay 19/19`、`event 1/1`、`fetch 1/1`、`transport 31/31`、`platform` 退出 0、`capabilities-identity 4/4` —— 全部 `exit 0`、干净退出。
- 测试退出挂起已修复：参照 `replay.test.js`，测试末尾调用 `destroy()`（清 flush `setInterval` + 跨标签页 `BroadcastChannel`），`sendExitBatch` 走 mock `fetch` 可 resolve。

## 五、未做（可选）
- `outputs/sdk-comparison-juxonmedia.md` §6 尚未按"最终采纳 P1-4/P2-5、拒绝 P0-1/P0-2/P1-3"改写——如需同步文档可告知。
- 遗留张力：SDK 现有 `PrivacyMode` 默认 `balanced` 会在采集层 strip 部分 PII，与"采集层不丢弃"原则矛盾，待后续明确默认档位或下沉 strip。
