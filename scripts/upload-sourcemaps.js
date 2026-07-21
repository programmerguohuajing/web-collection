import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const options = parseArgs(process.argv.slice(2))
const directory = options.dir || 'dist'
const endpoint = String(options.endpoint || process.env.WEB_COLLECTION_ENDPOINT || 'http://127.0.0.1:8787').replace(/\/$/, '')
const appId = options.appId || process.env.WEB_COLLECTION_APP_ID
const release = options.release || process.env.WEB_COLLECTION_RELEASE

if (!appId || !release) {
  console.error('缺少参数：--app-id、--release（也可使用 WEB_COLLECTION_APP_ID / WEB_COLLECTION_RELEASE 环境变量）')
  process.exit(1)
}

const files = await findMapFiles(directory)
if (!files.length) {
  console.error(`未在 ${directory} 中找到 .map 文件`)
  process.exit(1)
}

for (const path of files) {
  const map = JSON.parse(await readFile(path, 'utf8'))
  const file = map.file || basename(path, '.map')
  const response = await fetch(`${endpoint}/api/sourcemaps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, release, file, map })
  })
  if (!response.ok) throw new Error(`${path} 上传失败：${response.status} ${await response.text()}`)
  console.log(`已上传 ${appId}/${release}/${file}`)
}

console.log(`SourceMap 上传完成，共 ${files.length} 个文件`)

async function findMapFiles(path) {
  const entries = await readdir(path, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => {
    const fullPath = join(path, entry.name)
    return entry.isDirectory() ? findMapFiles(fullPath) : entry.name.endsWith('.map') ? [fullPath] : []
  }))
  return nested.flat()
}

function parseArgs(args) {
  const result = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    if (name) result[name] = args[index + 1]
  }
  return result
}
