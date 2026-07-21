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
| `WEB_DIST` | `apps/web/dist` | Web 控制台静态目录 |
| `SDK_DIST` | `packages/sdk/dist` | SDK 静态目录 |

## 数据表

| 表 | 说明 |
| --- | --- |
| `events` | 原始事件表，保存行为、性能、错误、请求等事件 |
| `issues` | 错误聚合表，按 fingerprint 合并错误，支持 resolved / regression |
| `replay_events` | rrweb 会话回放分片表 |
| `sourcemaps` | SourceMap 存储表，用于错误堆栈反解 |

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
  -d '{"release":"1.0.0","file":"app.js","map":{"version":3,"sources":[],"mappings":""}}'
```

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
