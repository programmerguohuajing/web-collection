# ==========================================
# Stage 1: Builder
# ==========================================
FROM node:22-alpine AS builder

WORKDIR /app

# 安装 pnpm (项目 package.json 指定 pnpm@11.7.0)
RUN npm install -g pnpm@11.7.0

# 复制全量源代码 (.dockerignore 已自动过滤 node_modules 及构建产物)
COPY . .

# 安装工作区依赖
RUN pnpm install

# 构建前端 Web 控制台 与 SDK 产物
RUN pnpm --filter @web-collection/web build && pnpm --filter @web-collection/sdk build

# ==========================================
# Stage 2: Runner (All-in-One 开箱即用模式)
# ==========================================
FROM node:22-alpine AS runner

WORKDIR /app

# 安装内嵌 PostgreSQL 数据库服务与 su-exec 权限工具
RUN apk add --no-cache postgresql postgresql-contrib su-exec

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    WEB_DIST=/app/apps/web/dist \
    SDK_DIST=/app/packages/sdk/dist

# 从 builder 阶段复制全量所需文件
COPY --from=builder /app /app

# 给予入口脚本执行权限
RUN chmod +x /app/docker-entrypoint.sh

# 暴露接口端口与 PostgreSQL 持久化数据卷
EXPOSE 8787 5432
VOLUME ["/var/lib/postgresql/data"]

# Pod / 容器健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8787/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
