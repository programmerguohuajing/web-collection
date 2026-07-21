import { config } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '.env') })

await ensureDatabase()

const { ensureSchema } = await import('../db.js')

await ensureSchema()
console.log('database schema initialized')

async function ensureDatabase() {
  const targetUrl = new URL(
    process.env.DATABASE_URL ||
    process.env.PG_URL ||
    `postgresql://${encodeURIComponent(process.env.PGUSER || 'postgres')}:${encodeURIComponent(process.env.PGPASSWORD || '')}@${process.env.PGHOST || '127.0.0.1'}:${Number(process.env.PGPORT || 5432)}/${process.env.DB_NAME || process.env.PGDATABASE || 'web_collection'}`
  )
  const dbName = decodeURIComponent(targetUrl.pathname.slice(1))
  if (!dbName || dbName === 'template1') return

  const adminUrl = new URL(targetUrl)
  adminUrl.pathname = '/template1'
  const pool = new Pool({ connectionString: adminUrl.toString() })
  try {
    const { rowCount } = await pool.query('select 1 from pg_database where datname = $1', [dbName])
    if (!rowCount) await pool.query(`create database ${quoteIdent(dbName)}`)
  } finally {
    await pool.end()
  }
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}
