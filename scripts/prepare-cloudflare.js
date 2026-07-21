import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'

const sdkDir = 'apps/web/dist/sdk'
rmSync(sdkDir, { recursive: true, force: true })
mkdirSync(sdkDir, { recursive: true })
cpSync('packages/sdk/dist', sdkDir, { recursive: true })

const iife = readFileSync(`${sdkDir}/web-collection-sdk.iife.js`, 'utf8')
if (!/\b(?:var|let|const) WebCollection\b/.test(iife)) throw new Error('IIFE SDK 未暴露 window.WebCollection')
