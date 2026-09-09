/**
 * @file D2 RBAC 单一真相源（Node API 与 Cloudflare Worker 同源引用，杜绝两端漂移）
 * - ROLE_MATRIX：动作权限矩阵（PRD 09 §3.1），角色决定「能做什么」
 * - 等级派生：角色 → 默认数据等级（07 四级模型 L1~L4），Owner 可单独覆盖
 * - 不变量：不得授予高于自身的角色/等级；团队须保留 ≥1 active Owner
 * 注意：数据敏感度（能看 L1~L4 多少）由 team_members.access_level 决定，与动作权限正交。
 */

export const ROLES = ['owner', 'admin', 'member', 'viewer']

/** 权限矩阵（§3.1）：键 = 权限点，值 = 允许的角色集合（owner 恒允许，不重复列出） */
export const ROLE_MATRIX = {
  viewData: ['admin', 'member', 'viewer'],
  configureAlerts: ['admin', 'member'],
  manageApplications: ['admin'],
  manageMembers: ['admin'],
  changeMemberRole: ['admin'],      // owner 变更由「不可改 Owner」约束单独控制
  viewAudit: ['admin'],
  manageTeam: [],                   // 仅 owner（空数组 = 除 owner 外无人）
  // D1 · DSR（PRD 13 §4）：查询/导出/擦除工单全链路仅 Admin+ 可操作（owner 恒允许）；
  // 审批制衡（审批人 ≠ 发起人）由服务层状态机额外强制，不靠矩阵表达
  dsrView: ['admin'],
  dsrCreate: ['admin'],
  dsrApprove: ['admin'],
  dsrExecute: ['admin'],
  // A3 · 实验分析（PRD 14 §5 P0-8）：查看全员可见；创建/编辑（含状态迁移）Admin+；归档/物理删除仅 Admin（owner 恒允许）
  expView: ['admin', 'member', 'viewer'],
  expCreate: ['admin', 'member'],
  expUpdate: ['admin', 'member'],
  expArchive: ['admin'],
  // D3 · 用量计量 & 套餐（PRD 15 §5 P0-8）：查看用量全员可见；改套餐/档位仅 Admin（owner 恒允许）。
  // 注：计量数据属账单凭证范畴，改配额直接影响客户可用量，故收紧到 Admin。
  meterView: ['admin', 'member', 'viewer'],
  meterManage: ['admin'],
  // D4 · 白标 / 私有化（PRD 16 §5 P0-6）：品牌配置是展示层内容，非敏感数据，查看全员可见；
  // 修改会影响全站品牌呈现，仅 Admin（owner 恒允许）
  brandView: ['admin', 'member', 'viewer'],
  brandManage: ['admin']
}

/** 角色 → 默认数据等级派生（Owner 可单独覆盖，FR-8） */
export const ROLE_DEFAULT_LEVEL = { owner: 'L4', admin: 'L3', member: 'L2', viewer: 'L1' }

const LEVEL_ORDER = ['L1', 'L2', 'L3', 'L4']

/** 角色权限值（owner 最高），用于「不得授予高于自身角色」判定 */
const ROLE_RANK = { viewer: 1, member: 2, admin: 3, owner: 4 }

export function isRole(role) { return ROLES.includes(role) }

export function roleRank(role) { return ROLE_RANK[role] || 0 }

/** 角色派生默认数据等级 */
export function defaultLevelForRole(role) { return ROLE_DEFAULT_LEVEL[role] || 'L2' }

/** 是否拥有某权限点（owner 恒允许） */
export function hasPermission(role, permission) {
  if (role === 'owner') return true
  return Boolean(ROLE_MATRIX[permission]?.includes(role))
}

/**
 * 能否把 targetRole 授予对方（actor 授予角色不得高于自身）。
 * @param {string} actorRole - 操作者当前角色
 * @param {string} targetRole - 拟授予的角色
 */
export function canGrantRole(actorRole, targetRole) {
  if (!isRole(targetRole)) return false
  return roleRank(actorRole) >= roleRank(targetRole)
}

/**
 * 能否把目标等级授予对方（不得高于自身等级）。
 * @param {string} actorLevel - 操作者等级（L1~L4）
 * @param {string} targetLevel - 拟授予等级
 */
export function canGrantLevel(actorLevel, targetLevel) {
  const a = LEVEL_ORDER.indexOf(actorLevel)
  const t = LEVEL_ORDER.indexOf(targetLevel)
  if (t < 0) return false
  return a >= t
}

/**
 * 变更角色合法性综合判定：admin+ 才能改角色、不能改 Owner、不能授予高于自身。
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkRoleChange(actorRole, targetCurrentRole, nextRole) {
  if (!hasPermission(actorRole, 'changeMemberRole')) return { ok: false, reason: '需要 Admin 及以上角色' }
  if (targetCurrentRole === 'owner') return { ok: false, reason: '不能变更 Owner 角色（须先转让）' }
  if (!canGrantRole(actorRole, nextRole)) return { ok: false, reason: '不能授予高于自身的角色' }
  return { ok: true }
}

/**
 * 变更数据等级合法性综合判定：admin+ 且不高于自身等级。
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkLevelChange(actorRole, actorLevel, nextLevel) {
  if (!hasPermission(actorRole, 'manageMembers')) return { ok: false, reason: '需要 Admin 及以上角色' }
  if (!canGrantLevel(actorLevel, nextLevel)) return { ok: false, reason: '不能授予高于自身的数据等级' }
  return { ok: true }
}
