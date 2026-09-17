# Web Collection — All-in-One 前端遥测监控平台

> **一端多能、开箱即用**：集 **错误监控 (Error)**、**性能分析 (Web Vitals)**、**会话回放 (rrweb Replay)**、**链路追踪 (Tracing)**、**AI 智能诊断** 以及原生 **MCP (Model Context Protocol) 协议服务** 于一体的前端监控全栈平台。

---

## 🚀 极速开始 (Docker 1 键运行)

### 单容器 All-in-One 模式（内置 PostgreSQL，零前置配置）

无需安装或配置外部数据库，运行单个容器即可提供全量服务：

```bash
docker run -d \
  --name web-collection \
  -p 8787:8787 \
  web-collection:latest
```

启动后在浏览器直接打开：**`http://localhost:8787`**

> 💡 **Docker Desktop GUI 用户**：可在 Docker Desktop UI 中找到镜像点击 **Run**，在 `Optional settings` -> `Host port` 输入 `8787` 即可一键启动。

---

## ✨ 核心特性

- 🐛 **错误监控**：自动捕获 JS 运行时异常、Uncaught Promise 拒绝、静态资源加载错误及 Web Worker 错误，支持 SourceMap 解析与分发追踪。
- ⚡ **性能分析**：实时监测 Core Web Vitals (LCP, INP, CLS) 与 Long Tasks，洞察页面性能瓶颈。
- 🎬 **会话回放**：集成 rrweb 高保真会话录制与回放，还原用户真实操作路径。
- 🔗 **分布式链路追踪**：支持 W3C `traceparent` 协议与拓扑分析，无缝打通前后端请求链路。
- 🤖 **内嵌 AI 诊断引擎**：提供基于大模型的错误根因定位、影响面分析与修复方案生成。
- 🔌 **原生 MCP 协议支持**：内置 `/mcp` 端点，支持 Claude Desktop、Cursor、Windsurf 等 AI Agent 直接接入并调取遥测数据。
- 🏷️ **白标与私有化支持**：支持自定义品牌名称、Logo、主色调及登录标题，启动即生效。

---

## 🔌 常见连接与服务接口

| 服务名称 | 访问地址 / 端点 | 说明 |
| :--- | :--- | :--- |
| **Web 控制台** | `http://localhost:8787/` | 前端可视化管理与分析界面 |
| **健康检查** | `http://localhost:8787/health` | 容器与 Pod 健康探针 (`{"ok":true}`) |
| **采集 Endpoint** | `http://localhost:8787/api/collect` | SDK 数据上报点 |
| **MCP 网关服务** | `http://localhost:8787/mcp` | MCP Agent 直连接口 (`Authorization: Bearer <CollectKey>`) |
| **AI 诊断接口** | `http://localhost:8787/api/ai/*` | AI 问答与基线诊断 API |

---

## ⚙️ 环境变量说明 (Environment Variables)

容器启动时支持通过 `-e` 传入以下环境变量来自定义配置：

| 环境变量 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| `PORT` | `8787` | 服务监听端口 |
| `HOST` | `0.0.0.0` | 服务监听网卡 IP |
| `DATABASE_URL` | *内嵌 Postgres* | PostgreSQL 数据库连接串（例如 `postgresql://user:pass@host:5432/web_eys`）。指定外部链接时会自动关闭内嵌数据库 |
| `ADMIN_API_KEY` | `change-me-in-prod` | 管理端 API 鉴权密钥 |
| `CORS_ORIGIN` | `*` | 允许跨域的 Origin |
| `BRAND_NAME` | `Web Collection` | 白标品牌名称 |
| `BRAND_PRIMARY_COLOR` | `#4f46e5` | 控制台主题主色调 |

---

## 🛠️ Docker Compose & Kubernetes 部署

使用 Docker Compose（包含独立 PostgreSQL）：

```bash
cd deploy/self-hosted
docker compose up -d
```

部署到 Kubernetes 集群：

```bash
kubectl apply -k deploy/k8s
```

* 详细 Kubernetes 部署清单与指南：[deploy/k8s/README.md](https://github.com/programmerguohuajing/web-collection/tree/main/deploy/k8s)
* 项目 GitHub 源码仓库：[programmerguohuajing/web-collection](https://github.com/programmerguohuajing/web-collection)
