# ==========================================
# Stage 1: Builder
# ==========================================
FROM node:20-alpine AS builder

WORKDIR /app

# 安装 pnpm (项目 package.json 指定 pnpm@11.7.0)
RUN npm install -g pnpm@11.7.0

# 复制 package 配置文件
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/mcp/package.json ./apps/mcp/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/sdk-electron/package.json ./packages/sdk-electron/
COPY packages/sdk-react-native/package.json ./packages/sdk-react-native/
COPY packages/ai/package.json ./packages/ai/

# 安装依赖
RUN pnpm install

# 复制源代码
COPY . .

# 构建前端 Web 控制台 与 SDK 产物
RUN pnpm --filter @web-collection/web build && pnpm --filter @web-collection/sdk build

# ==========================================
# Stage 2: Runner
# ==========================================
FROM node:20-alpine AS runner

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
