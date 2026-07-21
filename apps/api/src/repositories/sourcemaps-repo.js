/**
 * @file sourcemaps 表数据访问层
 * 提供SourceMap 文件的上传（upsert）和查询操作。
 */

import { all, run } from '../db.js'

/**
 * 插入或更新 SourceMap 记录（upsert）。
 * 同一 release + file 组合重复上传时覆盖旧记录。
 */
export async function upsertSourceMapRow({ appId, releaseName, fileName, mapJson, createdAt }) {
  await run(
    `insert into sourcemaps (app_id, release_name, file_name, map_json, created_at)
     values (?, ?, ?, ?::jsonb, ?)
     on conflict(app_id, release_name, file_name) do update set map_json = excluded.map_json, created_at = excluded.created_at`,
    [appId, releaseName, fileName, mapJson, createdAt]
  )
}

/**
 * 按 release 和文件名查询 SourceMap。
 * @param {string} releaseName - 版本号
 * @param {string} fileName - JS 文件名
 * @returns {Promise<object|null>} 包含 map_json 的行或 null
 */
export async function getSourceMapRow(appId, releaseName, fileName) {
  const rows = await all('select map_json from sourcemaps where app_id = ? and release_name = ? and file_name = ? limit 1', [appId, releaseName, fileName])
  return rows[0] || null
}
