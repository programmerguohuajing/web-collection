import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * D3 计量 / D4 白标 —— Worker 侧运行时 QA（lead QA 固化）：
 * 1. meteringIncrementW 的 usage_daily upsert SQL 在真实 SQLite（node:sqlite 模拟 D1）下验证
 *    聚合累加 / 主键冲突覆盖 / 跨日分行（迁移 0035 全量应用）。
 * 2. brandScriptW 渲染契约：门禁关闭 → null 脚本；开启 → 11 个 CSS 变量 + __BRAND__ 注入 +
 *    XSS 转义（`<` 不裸出现）+ DB > env 优先级。
 *
 * node:sqlite 在 Node 22 需 --experimental-sqlite；不可用时整文件跳过（不影响常规测试链）。
 */

const here = dirname(fileURLToPath(import.meta.url))

test('D3/D4 Worker 运行时 QA', async (t) => {
  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    return t.skip('node:sqlite 不可用（需 Node 22 + --experimental-sqlite），跳过运行时 QA')
  }
  const worker = await import('../cloudflare/worker.js')
  assert.equal(typeof worker.meteringIncrementW, 'function')
  assert.equal(typeof worker.brandScriptW, 'function')
  assert.equal(typeof worker.brandPaletteW, 'function')

  // ---------- D3：usage_daily upsert 真跑 ----------
  const db = new DatabaseSync(':memory:')
  const migration = readFileSync(join(here, '..', 'cloudflare', 'migrations', '0035_metering.sql'), 'utf-8')
  db.exec(migration)

  const makeEnv = (extraBrand = {}) => ({
    WHITE_LABEL_ENABLED: '1',
    DB: {
      prepare(sql) {
        return {
          // D1 链式：prepare(sql).bind(...).run()/first()/all()
          bind(...args) {
            const stmt = db.prepare(sql)
            return {
              run: async () => { stmt.run(...args); return { meta: {} } },
              first: async () => stmt.get(...args) ?? null,
              all: async () => stmt.all(...args)
            }
          },
          // 无 bind 直调（brandScriptW 的 settings 查询）
          first: async () => db.prepare(sql).get() ?? null,
          all: async () => db.prepare(sql).all()
        }
      }
    },
    ...extraBrand
  })

  const env = makeEnv()
  const day = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ''))
  await worker.meteringIncrementW(env, 'team1', 'app-a', 'events', 10)
  await worker.meteringIncrementW(env, 'team1', 'app-a', 'events', 5)
  await worker.meteringIncrementW(env, 'team1', 'app-a', 'replay_sessions', 1)
  await worker.meteringIncrementW(env, '', 'default', 'events', 3) // 单租户 team_id=''

  const rows = db.prepare('select team_id, app_id, metric, day, value from usage_daily order by metric').all()
  assert.equal(rows.length, 3, '同键聚合 + 不同 metric 分行')
  const events = rows.find(r => r.metric === 'events' && r.app_id === 'app-a')
  assert.equal(events.value, 15, '同键两次增量应聚合为 15')
  assert.equal(events.team_id, 'team1')
  assert.equal(events.day, day)
  const replay = rows.find(r => r.metric === 'replay_sessions')
  assert.equal(replay.value, 1)
  const single = rows.find(r => r.team_id === '')
  assert.equal(single.value, 3, "单租户空 team_id 独立成行")

  // ---------- D4：brandScriptW 渲染契约 ----------
  const disabled = await worker.brandScriptW({}, {})
  assert.equal(await disabled.text(), 'window.__BRAND__ = null;', '未开启门禁输出 null 脚本')

  const envWithDb = makeEnv()
  // settings 表由 0035 之外的迁移建；这里手建最简结构
  db.exec('create table if not exists settings (id integer primary key, config_json text)')
  db.prepare('insert into settings (id, config_json) values (1, ?)').run(JSON.stringify({
    brand: { name: '客户品牌</script><img src=x onerror=alert(1)>', primaryColor: '#E91E63', logoUrl: 'javascript:alert(1)' }
  }))
  const response = await worker.brandScriptW({}, envWithDb)
  const script = await response.text()
  assert.match(script, /window\.__BRAND__ = /)
  assert.match(script, /\\u003c\/script\\u003e/, 'name 中的 </script> 必须被转义（防外层标签截断）')
  assert.ok(!script.includes('</script>'), '全脚本不得出现裸 </script>')
  assert.match(script, /#e91e63/, '主色应被 normalize 成小写 6 位')
  const setProps = script.match(/document\.documentElement\.style\.setProperty/g) || []
  assert.equal(setProps.length, 11, '应恰好写入 11 个 CSS 变量')
  assert.ok(!/javascript:/.test(script), 'XSS：非法 URL 必须被 brandSafeUrlW 剥离')
  assert.match(script, /document\.title = "客户品牌/)

  // ---------- D4：DB > env 优先级 ----------
  const envPriority = makeEnv({ BRAND_NAME: '出厂名' })
  const scriptPriority = await (await worker.brandScriptW({}, envPriority)).text()
  assert.match(scriptPriority, /客户品牌/)
  assert.doesNotMatch(scriptPriority, /出厂名/)

  // ---------- D4：主色派生数学 sanity ----------
  const palette = worker.brandPaletteW('#4f46e5')
  assert.notEqual(palette.hover, '#4f46e5')
  assert.equal(palette.light9, palette.soft)
  assert.equal(palette.dark2, palette.hover)
  assert.match(palette.ring, /^rgba\(79, 70, 229, \.18\)$/)
})
