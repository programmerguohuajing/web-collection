#!/usr/bin/env bash
# D4 白标 · 私有化自托管状态检查脚本
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
PORT="${PORT:-8787}"

echo "==> pm2 status"
pm2 status web-collection-api || true

echo "==> /health"
curl -fsS "http://127.0.0.1:${PORT}/health" || echo "  [WARN] health 不可达"

echo "==> /brand.js 响应头"
curl -sI "http://127.0.0.1:${PORT}/brand.js" | grep -iE 'content-type|cache-control|etag' || echo "  [WARN] /brand.js 不可达"
