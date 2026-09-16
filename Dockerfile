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
# Stage 2: Runner
# ==========================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787 \
    WEB_DIST=/app/apps/web/dist \
    SDK_DIST=/app/packages/sdk/dist

# 从 builder 阶段复制全量所需文件
COPY --from=builder /app /app

EXPOSE 8787

# Pod / 容器健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8787/health || exit 1

CMD ["node", "apps/api/src/index.js"]
