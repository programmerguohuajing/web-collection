#!/usr/bin/env bash
# D4 白标 · 私有化自托管启动脚本
# 复用现有 ecosystem.config.cjs（单 app web-collection-api），不另起进程模型。
set -euo pipefail

# 切到仓库根（deploy/self-hosted -> 根）
cd "$(dirname "$0")/../.."

# 载入 .env（供 PORT 等变量）
if [ -f .env ]; then set -a; . ./.env; set +a; fi
PORT="${PORT:-8787}"

echo "==> 启动 web-collection-api (pm2, env=production)"
pm2 start ecosystem.config.cjs --only web-collection-api --env production

echo "==> 等待 /health 就绪（最长 ~60s）..."
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "    /health OK"
    break
  fi
  sleep 2
done

echo "==> 冒烟 /brand.js ..."
if curl -fsS "http://127.0.0.1:${PORT}/brand.js" | head -1 | grep -q '__BRAND__'; then
  echo "    /brand.js OK"
else
  echo "    [WARN] /brand.js 未返回预期内容，请检查 branding-service 与 /brand.js 路由" >&2
  exit 1
fi

echo "==> 启动完成。控制台：http://127.0.0.1:${PORT}/"
