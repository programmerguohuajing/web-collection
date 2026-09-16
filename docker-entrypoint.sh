#!/bin/sh
set -e

# 判定是否需要启动内嵌 PostgreSQL：
# 未指定 DATABASE_URL，或者 DATABASE_URL 指向 127.0.0.1 / localhost 时启动内嵌 PostgreSQL
if [ -z "$DATABASE_URL" ] || echo "$DATABASE_URL" | grep -qE "(127\.0\.0\.1|localhost)"; then
  echo "--------------------------------------------------------"
  echo "  🚀 启动内嵌 PostgreSQL 数据库服务 (All-in-One 模式)"
  echo "--------------------------------------------------------"
  
  PGDATA="/var/lib/postgresql/data"
  mkdir -p "$PGDATA" /run/postgresql
  chown -R postgres:postgres "$PGDATA" /run/postgresql

  # 初次启动时初始化数据库
  if [ ! -d "$PGDATA/base" ]; then
    echo "=> 首次运行：初始化内嵌 PostgreSQL 数据目录..."
    su-exec postgres initdb -D "$PGDATA" --auth=trust > /dev/null
    
    echo "=> 临时启动 PostgreSQL 以创建默认数据库..."
    su-exec postgres pg_ctl -D "$PGDATA" -o "-k /run/postgresql" start > /dev/null
    
    su-exec postgres psql -v ON_ERROR_STOP=1 --username postgres <<-EOSQL > /dev/null
        CREATE DATABASE web_eys;
        ALTER USER postgres WITH PASSWORD 'postgres';
        GRANT ALL PRIVILEGES ON DATABASE web_eys TO postgres;
EOSQL
  else
    echo "=> 启动已存在的内嵌 PostgreSQL 数据库..."
    su-exec postgres pg_ctl -D "$PGDATA" -o "-k /run/postgresql" start > /dev/null || true
  fi

  export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/web_eys"
  
  # 循环检查 Postgres 是否就绪
  until su-exec postgres pg_isready -h 127.0.0.1 -p 5432 > /dev/null 2>&1; do
    echo "=> 等待 PostgreSQL 数据库就绪..."
    sleep 1
  done
  echo "=> 内嵌 PostgreSQL 数据库已准备就绪！"
else
  echo "--------------------------------------------------------"
  echo "  🌐 使用外部 DATABASE_URL: $DATABASE_URL"
  echo "--------------------------------------------------------"
fi

echo "=> 启动 Web Collection API 服务..."
exec node apps/api/src/index.js
