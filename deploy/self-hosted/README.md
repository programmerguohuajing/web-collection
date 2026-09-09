# 私有化交付（白标）部署模板

本目录提供一套可直接复用的自托管部署模板，**目标：拿到代码 + 一份 env，30 分钟内起出带客户品牌的独立实例**（控制台 + 采集同源托管）。

> 适用范围：Node 自托管（`apps/api` + PostgreSQL + pm2）。Cloudflare Worker 部署见根 README 的 Worker 章节。

## 文件清单

| 文件 | 作用 |
|---|---|
| `.env.example` | 现有 .env 全量项 + `BRAND_*` / `PUBLIC_CONSOLE_ORIGIN` 出厂预置（中文注释） |
| `start.sh` | `pm2 start ecosystem.config.cjs --only web-collection-api --env production`，启动后轮询 `/health`，再冒烟 `/brand.js` |
| `stop.sh` | `pm2 stop web-collection-api` |
| `status.sh` | `pm2 status` + `/health` + `/brand.js` 响应头（定位是否命中路由） |
| `nginx.conf.example` | 控制台域名反代 + `/api/collect` 透传 + `client_max_body_size 20m` |
| `docker-compose.yml` | 可选：api + postgres 两服务，`BRAND_*` 经 environment 注入 |

## 30 分钟起实例步骤

1. **准备环境**（~5min）：安装 Node.js ≥ 18、PostgreSQL、pm2、curl。
2. **写入配置**（~5min）：
   ```bash
   cp .env.example .env
   # 编辑 .env：填数据库、ADMIN_API_KEY、CORS_ORIGIN
   # 品牌出厂预置：改 BRAND_NAME / BRAND_PRIMARY_COLOR 等（启动即生效，无需进系统）
   ```
3. **安装依赖 + 构建前端**（~15min）：
   ```bash
   npm install
   pnpm --filter web build   # 生成 apps/web/dist
   ```
4. **启动**（~2min）：
   ```bash
   ./deploy/self-hosted/start.sh
   ```
   脚本会等待 `/health` 并返回 `/brand.js` 首行 `window.__BRAND__` 冒烟结果。
5. **反代控制台域名**（~3min，可选）：将 `nginx.conf.example` 的 `server_name` 改为你的域名，配置证书（certbot 命令见注释），并重载 nginx；同步设置 `CORS_ORIGIN`。
6. **验证**（~2min）：打开控制台 → 「系统设置 → 品牌与白标」改品牌名/主色/Logo，保存后刷新，侧栏/登录页/页头/favicon/浏览器标题全量生效。

## 品牌优先级

```
界面保存值 (config_json.brand)  >  env BRAND_*  >  内置默认 (Web Collection / #4f46e5)
```

- 出厂预置用 env：客户还没进系统，界面已经是对的。
- 界面保存后以 DB 为准，重启不覆盖客户在界面上改的值。

## 自定义域名

- **控制台域名**：在 nginx 侧反代（见 `nginx.conf.example`）并同步 `CORS_ORIGIN`；平台侧不自动签发证书。
- **采集域名**：由接入方 SDK `init({ endpoint: 'https://collect.example.com/api/collect' })` 指定，平台不修改采集协议。

## Cloudflare Worker 部署

- 白标默认关闭，需 `wrangler secret put WHITE_LABEL_ENABLED` 设为 `1` 后重启实例方可启用。
- 自定义域在 `wrangler.jsonc` 的 `routes[].pattern` 配置。
- `/brand.js` 必须在 `assets.run_worker_first` 中（已在配置内），否则会被 SPA 兜底返回无 CORS 头的 `index.html`。
