import { cpSync, mkdirSync, rmSync } from 'node:fs'

const sdkDir = 'apps/web/dist/sdk'
rmSync(sdkDir, { recursive: true, force: true })
mkdirSync(sdkDir, { recursive: true })
cpSync('packages/sdk/dist', sdkDir, { recursive: true })
