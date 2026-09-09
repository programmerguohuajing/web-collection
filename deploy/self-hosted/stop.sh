#!/usr/bin/env bash
# D4 白标 · 私有化自托管停止脚本
set -euo pipefail
cd "$(dirname "$0")/../.."
pm2 stop web-collection-api
