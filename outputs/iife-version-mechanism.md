# SDK IIFE 交付机制确认 + 版本失真修复

## 你的初始化方式是否仍然有效？—— 有效，且更省心

你通过 `https://web-collection.jingguohua.cc.cd/sdk/web-collection-sdk.iife.js` 引入 IIFE 的方式**完全正确，URL 永不需要改**。

交付链路（已核对源码与部署配置）：

```
wrangler.jsonc
  assets.directory = ./apps/web/dist
  run_worker_first: ["/sdk/*"]
        │
        ▼
cloudflare/worker.js:16
  if (url.pathname.startsWith('/sdk/'))
      response = await env.ASSETS.fetch(...)   // 即 ./apps/web/dist
        │
        ▼
scripts/prepare-cloudflare.js
  cpSync('packages/sdk/dist', 'apps/web/dist/sdk', {recursive:true})
        │   ← build:cloudflare 先 pnpm --filter @web-collection/sdk build
        ▼
push main → Deploy Cloudflare → 线上 IIFE = 当前 SDK 源码的最新构建
```

**结论**：每次 push 到 `main`，GitHub Actions `Deploy Cloudflare` 都会先重新构建 SDK，再把产物拷进 `apps/web/dist/sdk/`，最后部署。所以：
- 这个 URL **始终返回当前最新构建的 IIFE**，内容自动跟上版本；
- 你浏览器里的 `<script src>` **不需要任何改动**；
- 你贴出的那串 init 参数（含 `requests:true / exposure:true / distributedTracing:true`）现在能正常建实例——已对**线上 IIFE** 真实 `createEys(...)` 冒烟验证：`INSTANCE_OK:true`（不再抛 `webCapabilities is not defined`）、`FETCH_WRAPPED:true`（请求监控已生效）。

### 一点建议（非必须）
该文件名是静态名，Cloudflare 默认有缓存。若你想**锁定版本**或**强制刷新**客户端缓存，可在引入 URL 加查询串（worker 走 ASSETS、忽略 query，不影响命中）：
```html
<script src="https://web-collection.jingguohua.cc.cd/sdk/web-collection-sdk.iife.js?v=0.2.3"></script>
```
由你自己控制何时升版本。

## 顺带修掉一个真实的"版本失真" bug

核对线上 IIFE 时发现：运行时上报的 `sdkVersion` 一直是 **`0.1.16`**，而非 `0.2.3`。

- **根因**：`packages/sdk/src/core/event.js` 的 `SDK_VERSION` 是**手写常量 `'0.1.16'`**，自 0.1.16 之后就再没跟着 `package.json` 一起 bump（0.2.0/0.2.1/0.2.2/0.2.3 全漏了）。
- **后果**：你后端收到的**每一条事件都标记 `sdkVersion:0.1.16`**，导致你根本无法从数据里区分"现在跑的是 0.2.3 还是 0.1.16"——这正是你这次追问"改了这么多版本还准不准"的核心隐患。

### 修复（一劳永逸，commit `2449358`，已部署）
把 `SDK_VERSION` 改为**构建时从 `package.json` 自动注入**（4 个 vite 配置均加 `define: { __SDK_VERSION__: JSON.stringify(pkg.version) }`），直引 src（测试）时回退 `'0.0.0-dev'`。

- 验证：本地 + 线上 IIFE 重新 grep 均只含 `0.2.3`，`0.1.16` 消失；
- 好处：以后只改 `package.json` 的版本号即可，**再也不会漏改常量**；
- 回归测试：`init-smoke.test.js` 新增 `SDK_VERSION` 非空 / semver 形态断言。

## 待你拍板
- **CDN（你用的）**：已部署，现在上报 `0.2.3` ✅
- **npm 侧一致性**：已发布的 npm `0.2.3` 的 dist 仍是修复前的旧构建（内含 `0.1.16` 常量）。如果你希望 **npm 包也报告正确版本**，需要再发一个 `0.2.4`（重建 + tag + Release + tgz）。要我发吗？
- 消费方仓库（`account-shop-nuxt` / `account-shop-app`）仍需升级 `@web-collection/sdk` 到最新并重新部署，线上才真正跑到含修复的版本。
