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

  await store.saveSourceMap({ release: '1.2.3', file: 'app.js', map: gen.toJSON() })
  await store.recordEvents([
    { type: 'error', release: '1.2.3', name: 'TypeError', message: 'boom', stack: 'TypeError: boom\n    at boom (/assets/app.js:1:10)' },
    { type: 'replay', release: '1.2.3', sessionId: 'sid', url: 'https://example.com', events: [{ type: 0, data: {}, timestamp: Date.now() }] }
  ])

  const issue = (await store.getSummary()).issues[0]
  assert.equal(issue.original.source, 'src/App.vue')
  assert.equal((await store.getReplay('sid')).length, 1)
})
