import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

copy('apps/web/dist', 'apps/web/dist')
copy('packages/sdk/dist', 'packages/sdk/dist')
copy('apps/api/src', 'apps/api/src')
copy('apps/api/package.json', 'apps/api/package.json')
copy('package.json', 'package.json')
copy('pnpm-workspace.yaml', 'pnpm-workspace.yaml')
copy('pnpm-lock.yaml', 'pnpm-lock.yaml')
copy('ecosystem.config.cjs', 'ecosystem.config.cjs')

function copy(from, to) {
  const source = join(root, from)
  if (!existsSync(source)) return
  cpSync(source, join(out, to), { recursive: true })
}
