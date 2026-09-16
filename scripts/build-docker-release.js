#!/usr/bin/env node

/**
 * 本地 / CI 辅助脚本：构建指定 Release 版本的 Docker 容器镜像。
 * 自动读取 package.json 版本，并添加 vX.Y.Z 和 latest 标签。
 *
 * 用法:
 *   node scripts/build-docker-release.js
 *   node scripts/build-docker-release.js --push --registry my-registry.com/my-user
 *   node scripts/build-docker-release.js --dry-run
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'))

const args = process.argv.slice(2)
const isDryRun = args.includes('--dry-run')
const shouldPush = args.includes('--push')

let registry = ''
const regIdx = args.indexOf('--registry')
if (regIdx !== -1 && args[regIdx + 1]) {
  registry = args[regIdx + 1].replace(/\/$/, '') + '/'
}

const version = pkg.version || '0.5.0'
const tagVersion = `v${version}`
const imageName = 'web-collection'

const targetImageTag = `${registry}${imageName}:${tagVersion}`
const targetImageLatest = `${registry}${imageName}:latest`

console.log(`[Docker Release Build]`)
console.log(`- 项目版本: ${version}`)
console.log(`- 目标镜像 Tag: ${targetImageTag}`)
console.log(`- 最新镜像 Tag: ${targetImageLatest}`)

const buildCmd = `docker build -t ${targetImageTag} -t ${targetImageLatest} -f ${join(rootDir, 'Dockerfile')} ${rootDir}`

if (isDryRun) {
  console.log(`\n[DRY RUN] 将执行指令:`)
  console.log(buildCmd)
  if (shouldPush) {
    console.log(`docker push ${targetImageTag}`)
    console.log(`docker push ${targetImageLatest}`)
  }
  process.exit(0)
}

// 检查 Docker Daemon 守护进程是否在运行
try {
  execSync('docker info', { stdio: 'ignore' })
} catch {
  console.error(`\n❌ 构建失败: 未检测到正在运行的 Docker 服务 (Daemon)。`)
  console.error(`💡 解决方法:`)
  console.error(`  1. 请打开 Windows 系统的 "Docker Desktop" 应用程序。`)
  console.error(`  2. 等待界面左下角/系统托盘显示状态为 "Docker Desktop is running" (绿灯)。`)
  console.error(`  3. 重新在终端运行: pnpm run docker:build\n`)
  process.exit(1)
}

try {
  console.log(`\n开始构建镜像...`)
  execSync(buildCmd, { stdio: 'inherit', cwd: rootDir })
  console.log(`\n✅ 镜像构建成功: ${targetImageTag}, ${targetImageLatest}`)

  if (shouldPush) {
    console.log(`\n推送镜像至 Registry...`)
    execSync(`docker push ${targetImageTag}`, { stdio: 'inherit', cwd: rootDir })
    execSync(`docker push ${targetImageLatest}`, { stdio: 'inherit', cwd: rootDir })
    console.log(`✅ 镜像推送完成!`)
  }
} catch (err) {
  console.error(`\n❌ 构建失败:`, err.message)
  process.exit(1)
}
