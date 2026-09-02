# web-collection MCP Server

把 web-collection SDK 的采集数据平面（事件 / 日志 / 错误 / 链路 / 回放 / 分析 / 告警）以 **MCP 工具** 形式暴露给 AI Agent。

- **方案 A（当前）**：独立 Node / Cloudflare Worker 服务，包装现有后端 `/api/*` REST 接口。
- **可扩展**：通过 `DataSource` 抽象层，未来可新增直连 D1 / Postgres 的实现（见 `src/datasource/`），MCP 工具代码无需改动。

> MCP server 是常驻服务，无法跑在浏览器端的 SDK 里；它消费的是 SDK 背后的数据平面（Cloudflare Worker + D1/Postgres）。SDK 本身保持「通用技术底座」定位，不含 MCP 逻辑。

## 架构

```
MCP Client ──(Streamable HTTP, Bearer MCP_AUTH_TOKEN)──▶ /mcp
                                                       │
                                              Worker fetch handler
                                              (auth gate + CORS)
                                                       │
                                              McpServer + 12 tools
                                                       │
                                              DataSource 抽象层
                                                       │
                              ┌────────────────────────┴─────────────┐
                              │ RestDataSource（Plan A，已实现）        │
                              │   调用后端 /api/*，带 x-app-key 鉴权    │
                              └───────────────────────────────────────┘
```

### 暴露的工具（tools）

| 工具 | 对应后端接口 | 说明 |
|---|---|---|
| `list_events` | `/api/events` | 原始采集事件分页 |
| `list_logs` | `/api/logs` | 前端日志分页 |
| `get_summary` | `/api/summary` | 聚合概览（事件数 / 错数 / 性能 p75 / 行为分布） |
| `list_issues` | `/api/issues` | 聚合错误问题 |
| `list_replays` | `/api/replays` | 会话回放列表 |
| `list_traces` | `/api/traces` | 调用链路拓扑 |
| `get_analytics_sessions` | `/api/analytics/sessions` | 会话分析 |
| `get_analytics_paths` | `/api/analytics/paths` | 路径分析 |
| `get_analytics_click_paths` | `/api/analytics/click-paths` | 点击路径分析 |
| `get_analytics_heatmap` | `/api/analytics/heatmap` | 热力图 |
| `get_analytics_live` | `/api/analytics/live` | 近 5 分钟实时概览 |
| `list_alerts` | `/api/alerts` | 告警记录 |
| `list_alert_channels` | `/api/alert-channels` | 告警渠道配置 |

每个工具接受统一的过滤/分页入参：`appId` / `release` / `type` / `name` / `userId` / `sessionId` / `traceId` / `path` / `keyword` / `status` / `startTime` / `endTime` / `page` / `pageSize`。

## 鉴权（两层）

1. **MCP 端点保护**：客户端必须带 `Authorization: Bearer <MCP_AUTH_TOKEN>`。未携带或错误返回 401。
2. **后端 /api/* 调用**：MCP server 以 `MCP_API_KEY` 作为 `x-app-key` 调用后端（即现有 appKey / collectKey）。后端 `cloudflare/worker.js` 的 `collect()` 会以 sha256 比对 `collect_key_hash`。

> 注意：当前后端 `adminApi`（/api/*）部分接口未强制 `x-app-key`（仅 `collect` 强制）。MCP server 始终带此头，既符合既有约定，也为后端后续收紧鉴权做好准备。

## 数据源切换（rest / d1）

`DataSource` 抽象层支持两种数据源，通过 `MCP_DATASOURCE_KIND` 切换（默认 `rest`）：

- **rest（默认）**：包装现有后端 `/api/*` REST 接口。`MCP_API_KEY` 作为 `x-app-key` 调用后端，与线上后端权限/分页/脱敏逻辑一致。
- **d1**：直连本 worker 的 D1 绑定（`wrangler.jsonc` 已预留 `DB`），绕过后端 worker 直接查询。适用于自由分析、低延迟场景。**仅含只读 SELECT**，敏感字段（`user_phone` 等）做了与后端一致的脱敏；复杂聚合（sessions / paths / click-paths / heatmap / summary / live / traces）在 D1 模式下有独立实现，返回结构与 rest 模式保持一致。

切换方式（`wrangler.jsonc` 的 `vars` 已含 `MCP_DATASOURCE_KIND: "rest"`）：

```bash
# d1 模式：.dev.vars / secret 设 MCP_DATASOURCE_KIND=d1（无需 MCP_API_KEY）
# rest 模式：保持 MCP_DATASOURCE_KIND=rest 并提供 MCP_API_KEY
```

> 直连 D1 暂未做字段级白名单之外的额外权限收敛；如需更细粒度控制，在 `src/datasource/d1.ts` 的查询处加固（呼应项目「脱敏下沉 DB 层」待决策项）。

## 部署（Cloudflare Workers）

```bash
cd apps/mcp

# 1) 设置密钥（secret，不进仓库）
npx wrangler secret put MCP_API_KEY --config wrangler.jsonc      # 后端 collectKey / appKey
npx wrangler secret put MCP_AUTH_TOKEN --config wrangler.jsonc  # MCP 客户端 Bearer token

# 2) 部署（wrangler.jsonc 已配置 name=web-collection-mcp、nodejs_compat、D1 预留绑定）
npx wrangler deploy --config wrangler.jsonc
```

`wrangler.jsonc` 已包含：
- `BACKEND_BASE_URL`（默认 `https://web-collection.jingguohua.cc.cd`，可改）
- `MCP_APP_ID`（可选，默认 `default`，作为工具未传 appId 时的默认应用）

## 本地开发

用 `.dev.vars` 提供环境变量（不要提交到仓库）：

```
BACKEND_BASE_URL=https://web-collection.jingguohua.cc.cd
MCP_API_KEY=your-collect-key
MCP_AUTH_TOKEN=local-dev-token
MCP_APP_ID=default
```

```bash
npx wrangler dev --config wrangler.jsonc
```

本地验证（无状态模式，无需 session）：

```bash
# 1) 列出 tools
curl -s -X POST http://localhost:8787/mcp \
  -H "Authorization: Bearer local-dev-token" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 2) 调用一个工具
curl -s -X POST http://localhost:8787/mcp \
  -H "Authorization: Bearer local-dev-token" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_summary","arguments":{"pageSize":5}}}'
```

## 客户端接入（如 Claude Desktop / MCP Inspector）

- 传输方式：**Streamable HTTP**
- Endpoint：`https://<your-subdomain>.workers.dev/mcp`
- Headers：`{ "Authorization": "Bearer <MCP_AUTH_TOKEN>" }`
- 本服务为**无状态模式**（`sessionIdGenerator: undefined`），每次请求独立，客户端无需维护 session。

## 扩展：接入直连 D1 / Postgres

1. 在 `src/datasource/` 新建 `d1.ts` / `postgres.ts`，实现 `DataSource` 接口。
2. 在 `src/datasource/index.ts` 的 `createDataSource` 加 `case 'd1'` / `'postgres'`。
3. 在 `wrangler.jsonc` 启用对应绑定（`DB` 已预留）。
4. MCP 工具层无需任何改动。

> 直连实现需额外处理只读白名单与字段脱敏（呼应项目「脱敏下沉 DB 层」待决策项）。
