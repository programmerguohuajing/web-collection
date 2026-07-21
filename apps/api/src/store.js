/**
 * @file 数据存储层
 * 事件写入、错误聚合、SourceMap 解析、会话回放记录及报表汇总的核心业务逻辑。
 * 所有写入操作先经过 ensureSchema 初始化，确保表结构存在。
 */

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { SourceMapConsumer } from 'source-map-js'
import { countEventRows, insertEventRow, listEventRows, trimEventRows } from './repositories/events-repo.js'
import { countIssueRows, getIssueRow, listIssueRows, resolveIssueRow, upsertIssueRow } from './repositories/issues-repo.js'
import { countReplaySessions, insertReplayEventRow, listReplayEventRows, listReplaySessions } from './repositories/replays-repo.js'
import { getSourceMapRow, upsertSourceMapRow } from './repositories/sourcemaps-repo.js'
import { ensureSchema } from './db.js'
import { mapEvent } from './mappers/event-mapper.js'
import { mapIssue } from './mappers/issue-mapper.js'
import { mapReplay } from './mappers/replay-mapper.js'
import { buildSummary } from './services/summary-service.js'
import { fingerprint, percentile, scorePerf } from './utils/domain.js'
import { parseJson } from './utils/json.js'
import { ensureApplication, processAlert, shouldCollect } from './governance.js'

/** 事件表最大保留行数，超过后自动裁剪旧数据 */
const maxEvents = Number(process.env.MAX_EVENTS || 50000)
/** Schema 初始化的 Promise，确保所有操作在表结构就绪后执行 */
const initPromise = ensureSchema()

export { fingerprint, percentile, scorePerf }

/**
 * 判断错误 issue 的状态。
 * 如果之前已解决但新版本中再次出现，则标记为回归（regression）。
 * @param {object|null} previous - 之前的 issue 记录
 * @param {object} event - 当前错误事件
 * @returns {string} issue 状态（open / resolved / regression）
 */
export function classifyIssue(previous, event) {
  if (previous?.status === 'resolved' && previous.release !== event.release) return 'regression'
  return previous?.status || 'open'
}

export async function recordEvents(inputs) {
  await initPromise
  const events = []
  for (const input of inputs) {
    const event = await recordEvent(input)
    if (event) events.push(event)
  }
  await trimEventsIfNeeded()
  return events
}

/**
 * 记录单条事件。
 * 回放类型事件走单独的写入逻辑，其他类型事件直接插入 events 表。
 * 错误类型事件额外触发 issue 聚合（upsertIssue）。
 * @param {object} input - 事件对象
 * @returns {Promise<object>} 带 id 和 ts 的事件对象
 */
export async function recordEvent(input) {
  await initPromise
  const event = { id: randomUUID(), ts: Date.now(), appId: 'default', release: 'unknown', ...input }
  await ensureApplication(event.appId, event.release)
  if (!await shouldCollect(event.appId, event.type)) return null
  if (event.type === 'replay') {
    await recordReplay(event)
    return event
  }
  await insertEventRow(event)
  const issue = event.type === 'error' ? await upsertIssue(event) : null
  if (event.type === 'error' || event.type === 'perf') {
    void processAlert(event, issue).catch(error => console.error('alert processing failed', error))
  }
  return event
}

/**
 * 查询最近的事件列表。
 * @param {number} [limit=100] - 返回条数上限
 * @returns {Promise<Array>} 事件数组（已映射为前端格式）
 */
export async function listEvents(limit = 100, filters = {}) {
  await initPromise
  const rows = await listEventRows(limit, filters, Number(filters.offset || 0))
  return rows.map(mapEvent)
}

export async function listEventsPage(filters = {}) {
  await initPromise
  const page = Math.max(1, Number(filters.page || 1))
  const pageSize = Math.max(1, Math.min(100, Number(filters.pageSize || 10)))
  const [rows, total] = await Promise.all([
    listEventRows(pageSize, filters, (page - 1) * pageSize),
    countEventRows(filters)
  ])
  return { items: rows.map(mapEvent), total, page, pageSize }
}

/**
 * 获取仪表盘汇总数据：事件列表、错误聚合、回放列表，
 * 交由 summary-service 构建完整报表。
 * @returns {Promise<object>} 汇总报表对象
 */
export async function getSummary(filters = {}) {
  await initPromise
  const [events, issuesById, replays] = await Promise.all([listEvents(5000, filters), readIssues(filters), listReplays(filters)])
  return buildSummary(events, issuesById, replays)
}

/**
 * 将指定 issue 标记为已解决。
 * @param {string} id - issue 指纹
 * @returns {Promise<object|null>} 更新后的 issue 对象
 */
export async function resolveIssue(id) {
  await initPromise
  const issue = await getIssueRow(id)
  if (!issue) return null
  await resolveIssueRow(id, Date.now())
  return mapIssue(await getIssueRow(id))
}

/**
 * 保存 SourceMap 文件，用于错误堆栈还原。
 * @param {object} param0 - { release: 版本号, file: 文件名, map: SourceMap 对象 }
 * @returns {Promise<object>} 保存结果 { release, file }
 */
export async function saveSourceMap({ appId = 'default', release = 'unknown', file = '', map }) {
  await initPromise
  if (!map || typeof map !== 'object') throw new Error('bad sourcemap')
  const releaseName = safeName(release)
  const fileName = safeName(file || map.file || 'app.js')
  const safeAppId = safeName(appId)
  await ensureApplication(safeAppId, releaseName)
  await upsertSourceMapRow({ appId: safeAppId, releaseName, fileName, mapJson: JSON.stringify(map), createdAt: Date.now() })
  return { appId: safeAppId, release, file: fileName }
}

/**
 * 列出最近的会话回放摘要。
 * 每个分段已是独立 sessionId，直接列出所有记录即可。
 * @returns {Promise<Array>} 回放摘要数组
 */
export async function listReplays(filters = {}) {
  await initPromise
  const rows = await listReplaySessions(Number(filters.limit || 20), filters)
  return rows.map(mapReplay)
}

export async function listIssues(filters = {}) {
  await initPromise
  return Object.values(await readIssues(filters))
}

export async function listIssuesPage(filters = {}) {
  await initPromise
  const page = Math.max(1, Number(filters.page || 1))
  const pageSize = Math.max(1, Math.min(100, Number(filters.pageSize || 10)))
  const [rows, total] = await Promise.all([
    listIssueRows(filters, pageSize, (page - 1) * pageSize),
    countIssueRows(filters)
  ])
  return { items: rows.map(mapIssue), total, page, pageSize }
}

export async function listReplaysPage(filters = {}) {
  await initPromise
  const page = Math.max(1, Number(filters.page || 1))
  const pageSize = Math.max(1, Math.min(100, Number(filters.pageSize || 10)))
  const [rows, total] = await Promise.all([
    listReplaySessions(pageSize, filters, (page - 1) * pageSize),
    countReplaySessions(filters)
  ])
  return { items: rows.map(mapReplay), total, page, pageSize }
}

/**
 * 获取指定会话的完整回放事件流。
 * 每个分段已是独立 sessionId，直接查所有事件即可。
 * @param {string} sessionId - 会话 ID
 * @returns {Promise<Array>} 回放事件数组
 */
export async function getReplay(sessionId) {
  await initPromise
  const rows = await listReplayEventRows(safeName(sessionId))
  return rows.flatMap(row => parseJson(row.events_json) || [])
}

/** 确保数据库 Schema 已初始化（供外部调用） */
export async function initDatabase() {
  await initPromise
}

/**
 * 错误事件聚合：根据指纹查找已有 issue，合并用户列表、更新计数，
 * 尝试通过 SourceMap 还原源码位置，最后 upsert 到 issues 表。
 * @param {object} event - 错误事件
 */
async function upsertIssue(event) {
  const id = fingerprint(event)
  const previousRow = await getIssueRow(id)
  const previous = previousRow ? mapIssue(previousRow) : null
  const original = await resolveSourceMap(event)
  const user = { id: event.userId || event.deviceId || event.sessionId || '', name: event.userName || '', phone: event.userPhone || '' }
  const oldUsers = (previous?.users || []).map(item => typeof item === 'string' ? { id: item, name: '', phone: '' } : item)
  const users = [...oldUsers.filter(item => item.id !== user.id), user].filter(item => item.id || item.name || item.phone).slice(-100)
  const issue = {
    fingerprint: id,
    status: classifyIssue(previous, event),
    appId: event.appId,
    release: event.release,
    name: event.name,
    message: event.message,
    stack: trimStack(event.stack),
    url: event.url,
    props: event.props,
    breadcrumbs: event.breadcrumbs,
    original,
    users,
    affectedUsers: users.length,
    count: (previous?.count || 0) + 1,
    firstSeen: previous?.firstSeen || event.ts,
    lastSeen: event.ts,
    resolvedAt: previous?.resolvedAt || null
  }
  await upsertIssueRow(issue)
  return issue
}

/**
 * 记录会话回放事件：直接写入 replay_events 表，不再维护冗余的 replays 汇总表。
 * @param {object} event - 回放事件（包含 events 数组和可选的 segmentEndReason）
 */
async function recordReplay(event) {
  const events = Array.isArray(event.events) ? event.events.slice(0, 200) : []
  if (!event.sessionId || !events.length) return
  const sessionId = safeName(event.sessionId)
  await insertReplayEventRow({
    sessionId,
    userId: event.userId,
    userName: event.userName,
    userPhone: event.userPhone,
    createdAt: event.ts,
    url: event.url || null,
    release: event.release || null,
    endReason: event.segmentEndReason || undefined,
    eventsJson: JSON.stringify(events)
  })
}

/** 读取所有 issue 并以指纹为键组装成 Map */
async function readIssues(filters = {}) {
  const rows = await listIssueRows(filters, 5000)
  return Object.fromEntries(rows.map(row => {
    const issue = mapIssue(row)
    return [issue.fingerprint, issue]
  }))
}

/** 当事件总数超过 maxEvents 时裁剪最旧的数据 */
async function trimEventsIfNeeded() {
  if (maxEvents <= 0) return
  const total = await countEventRows()
  if (!Number.isFinite(total) || total <= maxEvents) return
  await trimEventRows(total - maxEvents)
}

/** 安全化文件名/标识符：取 basename 并替换非法字符为下划线 */
function safeName(value) {
  return basename(String(value || 'unknown')).replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** 截取堆栈前 8 行，避免过长堆栈影响存储和展示 */
function trimStack(stack = '') {
  return String(stack).split('\n').slice(0, 8).join('\n')
}

/**
 * 尝试通过 SourceMap 还原错误堆栈中的源码位置。
 * 先从事件 props 中提取源文件和行号，否则从 stack 字符串中正则匹配。
 * 如果找到对应的 SourceMap 文件，使用 source-map 库还原原始位置。
 * @param {object} event - 错误事件
 * @returns {Promise<object|null>} 还原后的源码位置信息
 */
async function resolveSourceMap(event) {
  const frame = firstFrame(event.stack || '', event.props)
  if (!frame) return null
  const row = await getSourceMapRow(safeName(event.appId || 'default'), safeName(event.release || 'unknown'), basename(frame.file))
  if (!row) return null
  const consumer = new SourceMapConsumer(parseJson(row.map_json))
  const pos = consumer.originalPositionFor({ line: frame.line, column: frame.column })
  consumer.destroy?.()
  return pos?.source
    ? {
        generatedFile: frame.file,
        generatedLine: frame.line,
        generatedColumn: frame.column,
        source: pos.source,
        line: pos.line,
        column: pos.column,
        name: pos.name
      }
    : null
}

/**
 * 从错误事件中提取第一帧的文件路径、行号、列号。
 * 优先使用 props 中的 source/line/column，否则从 stack 字符串中正则匹配。
 * @param {string} stack - 错误堆栈字符串
 * @param {object} props - 事件附加属性
 * @returns {object|null} { file, line, column }
 */
function firstFrame(stack, props = {}) {
  const source = props?.source || ''
  const line = Number(props?.line)
  const column = Number(props?.column)
  if (source && line) return { file: source, line, column: column || 0 }
  const match = String(stack).match(/(?:at\s+.*?\()?((?:https?:\/\/|\/)[^():\s]+):(\d+):(\d+)/)
  return match ? { file: match[1], line: Number(match[2]), column: Number(match[3]) } : null
}
