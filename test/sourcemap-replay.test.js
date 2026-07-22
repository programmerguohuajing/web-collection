import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceMapGenerator } from 'source-map-js'

test('sourcemap resolves errors and replay events are stored by session', async () => {
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'web-collection-'))
  const store = await import(`${new URL('../apps/api/src/store.js', import.meta.url).href}?t=${Date.now()}`)
  const gen = new SourceMapGenerator({ file: 'app.js' })
  gen.addMapping({ generated: { line: 1, column: 10 }, original: { line: 5, column: 2 }, source: 'src/App.vue', name: 'boom' })

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const appId = `test-${suffix}`
  const release = `1.2.3-${suffix}`
  const sessionId = `sid-${suffix}`
  await store.saveSourceMap({ appId, release, file: 'app.js', map: gen.toJSON() })
  const replayTimestamp = Date.now()
  await store.recordEvents([
    { type: 'error', appId, release, name: 'TypeError', message: `boom-${suffix}`, stack: 'TypeError: boom\n    at boom (/assets/app.js:1:10)' },
    { type: 'replay', appId, release, sessionId, ts: replayTimestamp, url: 'https://example.com', events: [{ type: 4, data: {}, timestamp: replayTimestamp }] },
    { type: 'replay', appId, release, sessionId, ts: replayTimestamp, url: 'https://example.com', events: [{ type: 2, data: {}, timestamp: replayTimestamp }] }
  ])

  const issue = (await store.getSummary({ appId })).issues[0]
  assert.equal(issue.original.source, 'src/App.vue')
  assert.deepEqual((await store.getReplay(sessionId)).map(event => event.type), [4, 2])

  const { run } = await import('../apps/api/src/db.js')
  await run('delete from alert_history where app_id = ?', [appId])
  await run('delete from replay_events where session_id = ?', [sessionId])
  await run('delete from issues where app_id = ?', [appId])
  await run('delete from events where app_id = ?', [appId])
  await run('delete from sourcemaps where app_id = ?', [appId])
  await run('delete from applications where app_id = ?', [appId])
})
