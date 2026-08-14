import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Cloudflare 漏斗读写统一使用 funnel_definitions', async () => {
  const worker = await readFile(new URL('../cloudflare/worker.js', import.meta.url), 'utf8')
  assert.doesNotMatch(worker, /(?:from|into|delete\s+from|update)\s+funnels\b/i)
  assert.match(worker, /from funnel_definitions/)
  assert.match(worker, /into funnel_definitions/)
})

test('D1 表名迁移通过 rename 保留已有漏斗数据', async () => {
  const migration = await readFile(new URL('../cloudflare/migrations/0006_rename_funnels.sql', import.meta.url), 'utf8')
  assert.match(migration, /alter table funnels rename to funnel_definitions/i)
  assert.doesNotMatch(migration, /drop\s+table|delete\s+from/i)
})

test('PostgreSQL 启动迁移复制旧表数据且不删除旧表', async () => {
  const database = await readFile(new URL('../apps/api/src/db.js', import.meta.url), 'utf8')
  assert.match(database, /to_regclass\('public\.funnels'\)/)
  assert.match(database, /insert into public\.funnel_definitions/)
  assert.match(database, /on conflict \(id\) do nothing/)
  assert.doesNotMatch(database, /drop table(?: if exists)? funnels/i)
})

test('D1 漏斗迁移增加转化时间窗 window_ms 列且不破坏数据', async () => {
  const migration = await readFile(new URL('../cloudflare/migrations/0007_funnel_window.sql', import.meta.url), 'utf8')
  assert.match(migration, /alter table funnel_definitions add column window_ms/i)
  assert.doesNotMatch(migration, /drop\s+table|delete\s+from/i)
})

test('Cloudflare 全量迁移统一使用 alert_history 实体表', async () => {
  const migrations = await Promise.all(
    ['0001_init.sql', '0002_alert_channels.sql', '0003_alert_status.sql', '0004_rename_alerts.sql']
      .map(name => readFile(new URL(`../cloudflare/migrations/${name}`, import.meta.url), 'utf8'))
  )
  const schema = migrations.join('\n')
  assert.match(migrations[0], /create table if not exists alert_history/i)
  assert.match(migrations[1], /references alert_history\(id\)/i)
  assert.doesNotMatch(schema, /(?:create|alter|drop)\s+(?:table|view)(?:\s+if\s+(?:not\s+)?exists)?\s+alerts\b/i)
})
