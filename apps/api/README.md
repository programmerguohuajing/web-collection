# Web Collection API

Node + Express + PostgreSQL 后端服务，负责接收 SDK 上报、写入监控数据、聚合错误、保存 SourceMap、提供后台查询接口，并托管 Web 控制台和 SDK 构建产物。

## 启动

```bash
pnpm --filter @web-collection/api db:init
pnpm --filter @web-collection/api dev
```

生产环境：

```bash
pnpm --filter @web-collection/api start
```

默认端口：`8787`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | API 服务端口 |
| `ADMIN_API_KEY` | `dev-admin-key` | 管理接口鉴权 key，请求头 `x-api-key` |
| `COLLECT_TOKEN` | 空 | 采集接口 token；为空时不校验 |
| `CORS_ORIGIN` | `*` | 跨域允许来源 |
| `DATABASE_URL` / `PG_URL` | 空 | PostgreSQL 连接串 |
| `PGHOST` | `127.0.0.1` | PostgreSQL 主机 |
| `PGPORT` | `5432` | PostgreSQL 端口 |
| `PGUSER` | `postgres` | PostgreSQL 用户 |
| `PGPASSWORD` | 空 | PostgreSQL 密码 |
| `PGDATABASE` / `DB_NAME` | `web_collection` | 数据库名 |
| `PG_POOL_SIZE` | `10` | 连接池大小 |
| `MAX_EVENTS` | `50000` | events 表最大保留行数 |
| `FEISHU_WEBHOOK_URL` | 空 | 飞书自定义机器人 Webhook，用于错误与性能告警 |
| `ALERT_SECRET_MASTER_KEY` | 空 | 渠道密钥 AES-GCM 加密主密钥 |
| `ALERT_PUBLIC_BASE_URL` / `PUBLIC_BASE_URL` | 空 | QStash 回调的 API 公开地址 |
| `QSTASH_TOKEN` | 空 | QStash 发布令牌；为空时后台直接发送 |
| `QSTASH_CURRENT_SIGNING_KEY` | 空 | QStash 当前签名校验密钥 |
| `QSTASH_NEXT_SIGNING_KEY` | 空 | QStash下一签名校验密钥 |
| `CLEANUP_INTERVAL_MS` | `3600000` | 数据保留策略自动清理周期 |
| `WEB_DIST` | `apps/web/dist` | Web 控制台静态目录 |
| `SDK_DIST` | `packages/sdk/dist` | SDK 静态目录 |

## 数据表

| 表 | 说明 |
| --- | --- |
| `events` | 原始事件表，保存行为、性能、错误、请求等事件 |
| `issues` | 错误聚合表，按 fingerprint 合并错误，支持 resolved / regression |
| `replay_events` | rrweb 会话回放分片表 |
| `sourcemaps` | SourceMap 存储表，用于错误堆栈反解 |
| `applications` | 应用、平台、负责人和采样率配置 |
| `releases` | 应用版本及状态 |
| `platform_settings` | 数据保留与告警阈值配置 |
| `alert_history` | 告警通知审计记录 |
| `alert_channels` | 告警渠道、路由与加密配置 |
| `alert_deliveries` | 每个渠道的投递状态、重试和错误记录 |

## 采集接口

### POST `/api/collect`

公开采集接口，支持单条、数组、`{ events: [...] }` 批量格式。

```bash
curl -X POST "http://127.0.0.1:8787/api/collect" \
  -H "content-type: application/json" \
  -d '{"type":"track","appId":"web","release":"1.0.0","name":"submit_order","props":{"orderId":"SO1"}}'
```

如果设置了 `COLLECT_TOKEN`：

```bash
curl -X POST "http://127.0.0.1:8787/api/collect?token=YOUR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"type":"track","name":"test"}'
```

### GET `/api/collect.gif`

GIF 降级采集接口，适合受限环境。

```bash
curl "http://127.0.0.1:8787/api/collect.gif?data=%7B%22type%22%3A%22track%22%2C%22name%22%3A%22test%22%7D"
```

## 管理接口

管理接口都需要请求头：

```bash
x-api-key: dev-admin-key
```

通用查询参数：

| 参数 | 说明 |
| --- | --- |
| `startTime/endTime` | 毫秒时间戳范围 |
| `appId` | 应用 ID |
| `release` | 版本 |
| `type` | 事件类型 |
| `status` | issue 状态 |
| `path/url` | 页面路径或 URL |
| `userId/userName/userPhone` | 用户查询 |
| `keyword` | 关键字 |
| `page/pageSize` | 分页，默认 `1 / 10` |

### GET `/api/summary`

总览聚合数据。

```bash
curl "http://127.0.0.1:8787/api/summary" -H "x-api-key: dev-admin-key"
```

### GET `/api/events`

事件列表。

```bash
curl "http://127.0.0.1:8787/api/events?type=perf&page=1&pageSize=10" \
  -H "x-api-key: dev-admin-key"
```

### GET `/api/issues`

错误聚合列表。

```bash
curl "http://127.0.0.1:8787/api/issues?status=open" \
  -H "x-api-key: dev-admin-key"
```

### POST `/api/issues/:id/resolve`

标记错误为已解决。

```bash
curl -X POST "http://127.0.0.1:8787/api/issues/FINGERPRINT/resolve" \
  -H "x-api-key: dev-admin-key"
```

### GET `/api/replays`

会话回放列表。

```bash
curl "http://127.0.0.1:8787/api/replays?page=1&pageSize=10" \
  -H "x-api-key: dev-admin-key"
```

### GET `/api/replays/:replayId`

获取单条回放的 rrweb 事件流。

```bash
curl "http://127.0.0.1:8787/api/replays/1" \
  -H "x-api-key: dev-admin-key"
```

### POST `/api/sourcemaps`

上传 SourceMap。

```bash
curl -X POST "http://127.0.0.1:8787/api/sourcemaps" \
  -H "x-api-key: dev-admin-key" \
  -H "content-type: application/json" \
  -d '{"appId":"web","release":"1.0.0","file":"app.js","map":{"version":3,"sources":[],"mappings":""}}'
```

构建完成后可在 CI/CD 中自动上传：

```bash
pnpm sourcemaps:upload -- --dir apps/web/dist --app-id web --release 1.0.0 \
  --endpoint https://monitor.example.com --key "$WEB_COLLECTION_ADMIN_KEY"
```

### 采集治理接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/applications` | 应用和采样策略列表 |
| `PUT /api/applications/:appId` | 新增或更新应用、事件采样率、回放采样率 |
| `GET /api/applications/:appId/releases` | 应用版本列表 |
| `PUT /api/applications/:appId/releases/:release` | 新增版本或更新版本状态 |
| `GET/PUT /api/settings` | 数据保留周期和告警阈值 |
| `GET /api/alerts` | 告警通知记录 |
| `GET /api/capabilities` | 查询当前运行时支持的平台能力 |
| `POST /api/analytics/insights/query` | 事件趋势、用户数和会话数分析 |
| `GET /api/analytics/event-properties` | 查询事件可用属性 |
| `GET/POST/PUT/DELETE /api/analytics/insights` | 保存分析定义管理 |
| `POST /api/analytics/paths/query` | 用户路径节点与转移分析 |
| `POST /api/maintenance/cleanup` | 立即执行过期数据清理 |
| `GET /api/export/events.csv` | 导出事件报表 |
| `GET /api/export/issues.csv` | 导出错误报表 |
| `GET /api/export/replays.csv` | 导出回放报表 |

应用首次上报时会自动注册应用和版本。采样策略在服务端入库前执行，`0` 表示停止采集，`1` 表示全量采集。自动清理仅删除过期原始事件、回放、SourceMap、告警记录和已解决错误，不删除仍处于 open/regression 状态的问题。

## 静态托管

生产服务会托管：

| 路径 | 说明 |
| --- | --- |
| `/` | Web 控制台 SPA |
| `/sdk/:file` | SDK 构建产物 |
| `/web-collection-sdk.es.js` | ES Module SDK |
| `/web-collection-sdk.iife.js` | IIFE SDK |

访问前先执行根目录构建：

```bash
pnpm build
```

## 安全与清洗

- 采集事件类型白名单：`track / perf / performance / behavior / error / replay`
- URL 会移除 `token/password/key/secret/authorization` 查询参数
- `props`、`breadcrumbs` 会裁剪，避免超大对象入库
- 管理接口使用 `x-api-key` 鉴权
- 采集接口可用 `COLLECT_TOKEN` 增加防刷

## 脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm --filter @web-collection/api dev` | 本地启动 |
| `pnpm --filter @web-collection/api start` | PM2 生产启动 |
| `pnpm --filter @web-collection/api restart:pm2` | 重启 PM2 服务 |
| `pnpm --filter @web-collection/api stop:pm2` | 停止 PM2 服务 |
| `pnpm --filter @web-collection/api db:init` | 初始化数据库 |
| `pnpm --filter @web-collection/api test` | 运行测试 |
