# Kubernetes & Docker 容器化部署指南

本目录及根目录提供 Web Collection 前端遥测监控平台的 Docker 镜像构建和 Kubernetes 部署清单。

---

## 目录结构

```
.
├── Dockerfile                  # Multi-Stage Docker 镜像构建描述文件（根目录）
├── .dockerignore                # Docker 构建忽略规则（根目录）
└── deploy/
    ├── self-hosted/
    │   └── docker-compose.yml  # Docker Compose 本地一键启动配置
    └── k8s/
        ├── configmap.yaml      # 非敏感配置项与白标品牌预置
        ├── secret.yaml         # 数据库连接串及密钥等敏感凭据
        ├── deployment.yaml     # API & Web 同源服务 Deployment (含健康检查与资源限制)
        ├── service.yaml        # Service (ClusterIP) 映射
        ├── ingress.yaml        # NGINX Ingress 域名路由配置
        ├── kustomization.yaml  # Kustomize 配置文件
        └── README.md           # 部署操作说明
```

---

## 1. 镜像构建与推送 (Docker)

### 自动化发布 (Release CI/CD)

项目在 GitHub Actions 中整合了 Release 版本自动化镜像构建：
- 当推送以 `v*.*.*` 格式命名的版本 Tag（例如 `git tag v0.5.0 && git push origin v0.5.0`）时，`.github/workflows/release-npm.yml` 工作流会自动触发。
- 构建好的镜像将自动发布到 **GitHub Container Registry (GHCR)**：
  - `ghcr.io/<owner>/web-collection:v0.5.0`
  - `ghcr.io/<owner>/web-collection:latest`

### 本地手动构建

在项目根目录下，使用快捷 npm 命令或辅助脚本执行：

```bash
# 自动读取 package.json 版本并打 Tag
pnpm docker:build

# 指定目标镜像 Registry 并推送
node scripts/build-docker-release.js --push --registry your-registry.domain.com/library
```

---

## 2. Docker Compose 本地或单机快速部署

若使用 Docker Compose 进行轻量化一键部署（包含 PostgreSQL 数据库 + API 同源服务）：

```bash
cd deploy/self-hosted
docker compose up -d --build
```

验证服务健康状态：
```bash
curl http://localhost:8787/health
# 预期返回: {"ok":true}
```

---

## 3. Kubernetes (K8s) 集群部署步骤

### 步骤一：配置环境变量与密钥

1. 修改 `deploy/k8s/configmap.yaml` 中的配置项（如品牌名称 `BRAND_NAME`、跨域策略 `CORS_ORIGIN`）。
2. 修改 `deploy/k8s/secret.yaml` 中的敏感数据：
   - `DATABASE_URL`: PostgreSQL 数据库连接字符串
   - `ADMIN_API_KEY`: 管理端 API 密钥
   - `ACCOUNTS_JWT_SECRET`: 账号认证密钥

### 步骤二：更新 Deployment 镜像地址

编辑 `deploy/k8s/deployment.yaml`，将 `spec.template.spec.containers[0].image` 修改为你推送的镜像地址：
```yaml
image: your-registry.domain.com/library/web-collection:v0.5.0
```

### 步骤三：修改 Ingress 访问域名

编辑 `deploy/k8s/ingress.yaml`，将 `host: monitor.example.com` 替换为实际部署的控制台域名。

### 步骤四：部署到 Kubernetes

使用 `kubectl` 一键应用清单：

```bash
# 使用 kustomize 批量部署
kubectl apply -k deploy/k8s

# 或者逐个应用清单
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/secret.yaml
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/service.yaml
kubectl apply -f deploy/k8s/ingress.yaml
```

---

## 4. 部署验证与状态检查

### 查看 Pod 与 Service 状态

```bash
# 查看 Pod 状态及日志
kubectl get pods -l app.kubernetes.io/name=web-collection
kubectl logs -l app.kubernetes.io/name=web-collection --tail=100 -f

# 查看 Service 与 Ingress
kubectl get svc,ingress -l app.kubernetes.io/name=web-collection
```

### 验证健康检查接口

通过 Port-Forward 或 Ingress 域名测试接口：

```bash
# 转发端口到本地测试
kubectl port-forward svc/web-collection-service 8787:80

# 访问健康检查
curl http://localhost:8787/health
# 返回 {"ok":true}

# 访问白标配置冒烟
curl http://localhost:8787/api/brand
```

---

## 5. 伸缩与更新策略

- **副本数扩缩容**：通过修改 `deployment.yaml` 的 `replicas` 或运行 `kubectl scale deployment web-collection-api --replicas=3` 实现。
- **滚动更新**：使用 `kubectl set image deployment/web-collection-api api=your-registry.domain.com/library/web-collection:v0.5.1` 进行零停机平滑更新。
