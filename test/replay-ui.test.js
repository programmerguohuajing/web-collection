import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workspaceRoot = new URL('../', import.meta.url)

test('会话回放点击分段时先重组基础会话并等待 rrweb 首帧可见', async () => {
  const [panel, repository, worker, dashboard] = await Promise.all([
    readFile(new URL('apps/web/src/components/ReplayPanel.vue', workspaceRoot), 'utf8'),
    readFile(new URL('apps/api/src/repositories/replays-repo.js', workspaceRoot), 'utf8'),
    readFile(new URL('cloudflare/worker.js', workspaceRoot), 'utf8'),
    readFile(new URL('apps/web/src/dashboard.js', workspaceRoot), 'utf8')
  ])
  assert.match(panel, /import \{ Replayer \} from '@rrweb\/replay'/)
  assert.match(panel, /fullsnapshot-rebuilded/)
  assert.match(repository, /coalesce\(nullif\(base_session_id, ''\), session_id\)/)
  assert.match(repository, /where base_session_id = \?/)
  assert.match(worker, /const replayKey="coalesce\(nullif\(base_session_id,''\),session_id\)"/)
  assert.doesNotMatch(worker, /performance\.now\(\) - startTime > 25/)
  assert.match(dashboard, /const cacheKey = `\$\{teamId\}:\$\{String\(replayKey\)\}`/)
  assert.match(panel, /normalizeReplayPayload\(payload\)/)
  assert.match(panel, /await waitForInitialRender\(currentReplayer\)/)
  assert.match(panel, /ensureReplayFrameVisible\(width, height\)/)
  assert.match(panel, /iframe\.style\.display = 'inherit'/)
  assert.match(panel, /player\?\.destroy\(\)/)
})
