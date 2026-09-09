# PRD 09：账号 / 团队 / 角色体系（Account · Team · RBAC）

> 优先级：P0（战略地基） ｜ 里程碑：M3 前置 ｜ SDK 改动：无
> 修订：2026-09-03 初稿——落地 `outputs/capability-opportunities-next-horizon.md` 第 2 节 D2，并关闭 `docs/prd/README.md` 待决策项 D3
> 上位文档：`outputs/capability-opportunities-next-horizon.md`（D2/D3/D4）、`docs/prd/README.md`（全局设计原则 + 待决策 D3）
> 关联：`docs/prd/07-data-access-level.md`（直接下游）、`packages/access-level.js`、`apps/api/src/services/access-service.js`、`apps/web/src/views/settings/access-levels/index.vue`
> 依赖顺序：**先本 PRD（账号/团队/角色）→ 再 07 数据访问等级按成员授权**。07 的 FR-1/FR-3/FR-4/FR-5（M3-b）在本 PRD 的 P0 之后才具备落地条件。

## 0. 一句话定位

为 Web Collection 建立**最小可用的账号 / 团队 / 角色（RBAC）地基**：能注册登录、能建团队、能邀请成员、能按角色分配权限、能把应用（appId）归属到团队——从而解锁 07 数据访问等级的"按成员授权"，并为 D3 计量计费、D4 白标私有化提供租户载体。

---

## 1. 背景与定位

### 1.1 现状（代码核实结论）

| 维度 | 现状 | 证据 |
|---|---|---|
| 登录 / 账号 | **无**。控制台无登录页，无用户表、无口令、无会话 | `apps/web` 全站无鉴权路由；`packages/deployment-capabilities.js` 无 accounts 能力位 |
| 管理接口鉴权 | **单钥匙**：`x-api-key` 对齐环境变量 `ADMIN_API_KEY` | `apps/api/README.md` §环境变量表 |
| 原始 PII 查看授权 | **单钥匙**：`x-eys-raw-access` 对齐 `EYS_RAW_ACCESS_TOKEN` | `apps/api/src/privacy.js` `isAuthorizedRaw` |
| 数据访问等级 | **全局环境变量**：`DATA_ACCESS_LEVEL`（默认 L2，fail-close） | `apps/api/src/services/access-service.js` `currentAccessLevel()` |
| "成员" | **登记制**：`members` 表仅有 `id/name/role/access_level/last_active_at`，无邮箱、无身份、无法登录；`saveMemberLevel` 注释明确"接口层不重复校验身份" | `cloudflare/migrations/0017_prd_layers.sql`、`apps/api/src/db.js` |
| 应用归属 | `applications` 表有 `owner`（自由文本），**无 team_id**，任何持钥匙者可看全部 appId | `apps/api/src/db.js` |
| 前端入口 | `DashboardHeader.vue` 是一个 **Admin API Key 输入框**；`/access-levels` 页"＋ 登记成员"只是填名字 | `apps/web/src/components/DashboardHeader.vue`、`views/settings/access-levels/index.vue` |

**结论**：当前是"一把钥匙走天下"的单租户自用模式——**没有"这个人是谁、属于哪个团队、能做什么、能看多敏感的数据"这四个概念**。

### 1.2 为何现在立项（解锁三个下游）

- **07 数据访问等级**：07 前置明确写"依赖账号体系立项"，现状只能做"全局等级环境变量"这一半（M3-a）。没有成员身份，等级无法挂到人。
- **D3 用量计量 / 套餐**：计费主体是团队/租户，无团队即无计量对象。
- **D4 白标 / 私有化**：品牌、域名、隔离配置均按租户下发，无租户即无配置载体。

> 故 D2 虽工作量最大（估 后端 6d + 前端 4d），但属于**越晚做越阻塞**的地基项。

### 1.3 与现有单钥匙模式的关系与演进路径

前提：**采集侧完全不动**。`COLLECT_TOKEN` 与按应用的 `collect_key_hash`（`x-app-key`）属于"数据写入"通道，与"人"的账号体系是两条链路，本 PRD 不触碰。演进只发生在**管理/查询侧**（读取控制台的"人"）：

| 阶段 | ADMIN_API_KEY（`x-api-key`） | EYS_RAW_ACCESS_TOKEN | DATA_ACCESS_LEVEL |
|---|---|---|---|
| **M-a 兼容期**（本 PRD P0 交付时） | 保留，降级为"**系统密钥 / 引导 & CI 专用**"：仅可用于引导首个 Owner 账号、自动化脚本；映射为虚拟主体 `system`（全团队 Owner + L4），所有操作写审计并标记 `via=api_key` | 保留，但收敛为 L4 的**补充二次因子**（不再单独等同于"看原文"） | 保留为**未登录/匿名请求的兜底**（fail-close 落 L2） |
| **M-b 默认关闭** | 新部署默认 `ALLOW_ADMIN_API_KEY=false`，需显式开启；控制台不再提供输入框 | 建议废弃，语义并入 `access_level=L4` | 仅在 `accounts=false` 部署下生效 |
| **M-c 清理** | 随 D4 私有化交付评估是否彻底移除 | 移除 | 移除 |

- **能力开关**：`packages/deployment-capabilities.js` 的 `NODE_CAPABILITIES` / `WORKER_CAPABILITIES` 新增 `accounts` 布尔位（全局原则 #4 双后端一致）。`accounts=false` 时前端保持现有 API Key 输入框；`accounts=true` 时渲染登录页与用户菜单。现有自托管部署**默认 false，升级不破坏**。

### 1.4 非目标（明确不做什么）

- ❌ **不做支付 / 计费 / 套餐**（属 D3 计量定价，P2）
- ❌ **不做 SSO（OIDC/SAML）与 SCIM**（P2）
- ❌ **不改 SDK 采集逻辑、不改 events/schema**（零采集端改动）
- ❌ 不做组织（Organization）多层级嵌套——本期只做**扁平团队**；一个用户可属于多个团队，团队之间不嵌套
- ❌ 不做自定义角色 / 字段级权限（固定四角色，避免配置爆炸；自定义角色留 P2）
- ❌ 不改 07 的四级模型（L1~L4）与 `packages/access-level.js` 裁剪规则——本 PRD 只负责"把等级挂到成员身上"
- ❌ 不引入租户级静态加密（沿用 07 结论：TLS + 库内访问控制）

---

## 2. 目标与用户故事

### 2.1 产品目标

- **G1 · 有身份**：注册 / 登录 / 会话，管理接口 100% 可识别"是谁在调用"。
- **G2 · 有归属**：应用（appId）归属团队，跨团队数据默认不可见。
- **G3 · 有权限**：最小角色集（Owner / Admin / Member / Viewer）覆盖协作场景，且**角色（能做什么）与数据等级（能看多敏感）分离**。
- **G4 · 解锁 07**：把 `DATA_ACCESS_LEVEL` 从"全局环境变量"升级为"按成员取值"，并让等级变更有审计。

### 2.2 用户故事

- 作为**平台管理员（Owner）**，我希望用邮箱注册并创建团队、把公司的 5 个 appId 挂到团队下，以便把过去一把钥匙共享的现状收敛成可管理的协作空间。
- 作为**团队负责人（Admin）**，我希望通过邀请链接把研发和产品拉进团队并分别给 Member / Viewer 角色，以便新人当天就能看数据、但改不了采集配置。
- 作为**普通成员（Member）**，我希望登录后只看到本团队的应用与告警，并能配置告警规则和远程配置，以便日常排障不被其他团队数据干扰。
- 作为**只读/外部成员（Viewer）**，我希望被授予 L1 只读统计等级后能看大盘与告警，以便给客户做演示时**不接触任何用户明细**（IP / userId 在 API 层已被裁剪）。
- 作为**平台管理员（Owner）**，我希望把某位研发的数据等级从 L2 提到 L3 并看到审计记录，以便在合规检查时能说明"谁在什么时候、为什么获得了更高数据权限"。
- 作为**安全审计员**，我希望导出近 180 天的成员/角色/等级变更与敏感访问记录，以便通过客户安全审计。

---

## 3. 需求池

> P0 = 必须随首版交付（解锁 07）；P1 = 应做；P2 = 长尾。

### P0 · 账号、团队、成员、角色、应用归属

- **FR-1 账号**：邮箱 + 口令注册/登录；口令 `argon2id`（或 `scrypt`）加盐哈希存储，**绝不存明文/可逆加密**；邮箱唯一（大小写不敏感归一）。
- **FR-2 会话**：登录后下发会话凭据，Cookie `HttpOnly + Secure + SameSite=Lax`；访问令牌短期（≤2h）+ 刷新令牌可撤销；登出即失效（服务端可撤销，见 D8）。
- **FR-3 引导首个 Owner**：空库首次启动时，`ADMIN_API_KEY` 可用于创建第一个 Owner 账号；随后控制台引导关闭或降级该密钥。
- **FR-4 团队**：创建/编辑团队（名称 + slug）；一个用户可属于多个团队；扁平无嵌套。
- **FR-5 成员管理**：按团队邀请成员（邮箱 + 角色 + 数据等级）、移除成员、变更角色；**不变量：团队必须保留 ≥1 个 active Owner**，最后一个 Owner 不可自我降级/退出（须先转让）。
- **FR-6 角色与权限（最小 RBAC）**：固定四角色 `owner / admin / member / viewer`，权限矩阵见 §3.1。**不变量：任何人不得授予高于自身的角色或数据等级**。
- **FR-7 应用归属**：`applications` 增加 `team_id`；应用列表/查询按当前团队过滤；写入侧 `collect_key_hash` 鉴权不变（SDK 零改动）。存量应用迁移到默认团队（见 D6）。
- **FR-8 数据等级挂载**：`team_members.access_level` 取值沿用 07 的 `L1~L4`；角色与等级**默认派生、可覆盖**（Owner→L4、Admin→L3、Member→L2、Viewer→L1；Owner 可单独调整）。
- **FR-9 与 07 衔接**：`access-service.currentAccessLevel()` 改为 **按请求上下文取等级**（`req.auth.level`），未登录/未启用账号体系时回落到环境变量（fail-close L2）；`applyAccessLevel` 中间件与 `packages/access-level.js` 规则**零改动**。
- **FR-10 越权防护**：所有 `/api/*` 管理查询接口经身份中间件；非本团队成员访问他团队 appId → `403`；未登录 → `401`。采集与静态路由豁免（同现有 `MASK_SKIP_PREFIXES` 思路）。
- **FR-11 能力开关**：`accounts` 能力位进 `NODE_CAPABILITIES` / `WORKER_CAPABILITIES`；前端据此切换"API Key 输入框 / 登录态用户菜单"。
- **FR-12 迁移**：`members` 表保留不删（兼容 `/api/members`），新写入改走 `team_members`；提供一次性脚本把登记项写入默认团队（无邮箱者标记为"待认领"，不自动生成账号）。

### P1 · 权限细化、邀请体验、审计

- **FR-13 权限矩阵细化**：把 §3.1 矩阵落到代码常量（`packages/rbac.js` 共享，Node 与 Worker 同源于 `packages/`），避免两端漂移。
- **FR-14 邀请链接与过期**：邀请生成一次性 token（存哈希）、默认 7 天过期、可撤销、可重发；接受邀请时若邮箱已注册则直接加入。
- **FR-15 操作审计日志**：账号、团队、成员、角色、等级、应用归属等关键动作全量入 `audit_logs`（含 `actor / action / target / ip / ua / detail`），保留 **≥180 天**（与 07 审计保留期一致）；Owner/Admin 可查，仅本团队可见。
- **FR-16 登录安全**：失败限流（建议 5 次 / 15 分钟 / 邮箱 + IP）、口令最小长度与弱口令校验、会话列表与"踢下线"。
- **FR-17 账号自助**：修改口令、退出后失效全部会话、个人资料（昵称/邮箱）变更需口令确认。
- **FR-18 成员最后活跃与席位视图**：`last_active_at` 落库（登录/请求时更新），团队页展示近 30 天活跃数（仅计数，不计量、不计费——计费属 D3）。

### P2 · 企业级身份与隔离

- **FR-19 SSO**：OIDC / SAML 接入，支持强制团队级 SSO 与域名自动加入（需 D4 白标配合）。
- **FR-20 SCIM**：用户与组的自动开通/回收。
- **FR-21 多租户隔离增强**：团队级数据分区/独立库、租户级配置与白标载体（与 D4 合并设计）。
- **FR-22 自定义角色**：按权限点勾选的自定义角色与应用级（per-appId）角色覆盖。
- **FR-23 MFA**：TOTP / WebAuthn 二次因子，对 L4 成员可强制。

### 3.1 权限矩阵（P0 最小集）

| 能力 | Owner | Admin | Member | Viewer |
|---|:--:|:--:|:--:|:--:|
| 查看监测/分析/洞察数据 | ✅ | ✅ | ✅ | ✅ |
| 配置告警规则 / 远程配置 / 采集治理 | ✅ | ✅ | ✅ | ❌ |
| 创建/编辑/删除应用、轮换采集密钥 | ✅ | ✅ | ❌ | ❌ |
| 邀请 / 移除成员 | ✅ | ✅ | ❌ | ❌ |
| 变更成员角色 | ✅ | ✅（不可改 Owner） | ❌ | ❌ |
| 变更成员数据等级（≤ 自身等级） | ✅ | ✅ | ❌ | ❌ |
| 查看团队审计日志 | ✅ | ✅ | ❌ | ❌ |
| 团队设置 / 删除团队 | ✅ | ❌ | ❌ | ❌ |

> 数据敏感性（能看 L1~L4 多少）由 `access_level` 决定，与上表的"动作权限"正交；两者共同构成一次请求的授权判定。

---

## 4. 数据模型与接口影响

### 4.1 新增表（双端同构）

**Cloudflare D1**（新建 `cloudflare/migrations/0023_account_team.sql`；D1 无 `jsonb` → `TEXT(JSON)`，无 `bigserial` → `INTEGER PRIMARY KEY AUTOINCREMENT`）：

```sql
create table if not exists users (
  id            varchar(32) primary key,
  email         varchar(160) not null unique,   -- 归一为小写后入库
  name          varchar(64)  not null,
  password_hash varchar(255) not null,          -- argon2id
  status        varchar(16)  not null default 'active',  -- active | disabled
  created_at    bigint not null,
  updated_at    bigint not null,
  last_login_at bigint
);
create index if not exists idx_users_email on users(email);

create table if not exists teams (
  id         varchar(32) primary key,
  name       varchar(64) not null,
  slug       varchar(64) not null unique,
  created_by varchar(32),
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists team_members (
  team_id      varchar(32) not null,
  user_id      varchar(32) not null,
  role         varchar(16) not null default 'member',   -- owner|admin|member|viewer
  access_level varchar(2)  not null default 'L2',       -- 与 07 同源 L1~L4
  status       varchar(16) not null default 'active',   -- active | invited | disabled
  joined_at    bigint,
  created_at   bigint not null,
  updated_at   bigint not null,
  primary key (team_id, user_id)
);
create index if not exists idx_team_members_user on team_members(user_id);

create table if not exists invitations (
  id           varchar(32) primary key,
  team_id      varchar(32) not null,
  email        varchar(160) not null,
  role         varchar(16) not null default 'member',
  access_level varchar(2)  not null default 'L2',
  token_hash   varchar(64) not null,          -- 只存哈希
  expires_at   bigint not null,               -- 默认 7d
  invited_by   varchar(32),
  accepted_at  bigint,
  revoked_at   bigint,
  created_at   bigint not null
);
create index if not exists idx_invitations_team on invitations(team_id, created_at desc);

create table if not exists sessions (
  id         varchar(32) primary key,
  user_id    varchar(32) not null,
  token_hash varchar(64) not null,
  expires_at bigint not null,
  revoked_at bigint,
  ip         varchar(64),                     -- 敏感，展示侧受 07 分级约束
  user_agent varchar(255),
  created_at bigint not null
);
create index if not exists idx_sessions_user on sessions(user_id, created_at desc);

-- 通用审计（替代并超集 07 的 data_access_audit）
create table if not exists audit_logs (
  id          integer primary key autoincrement,
  team_id     varchar(32),
  actor_user_id varchar(32),
  actor_email varchar(160),                   -- 快照，用户删除后仍可追溯
  action      varchar(32) not null,           -- login|member_invite|member_remove|role_change
                                              -- |level_change|app_move|team_update|view_full_ip ...
  target_type varchar(32),
  target_id   varchar(64),
  detail_json text,
  ip          varchar(64),
  user_agent  varchar(255),
  created_at  bigint not null
);
create index if not exists idx_audit_logs_team_time on audit_logs(team_id, created_at desc);

-- 应用归属团队
alter table applications add column team_id varchar(32);
create index if not exists idx_applications_team on applications(team_id);
```

**Node / PostgreSQL**（`apps/api/src/db.js` `initDatabase()` 同构追加）：字段与索引一致，`detail_json jsonb`、`id bigserial primary key`；`applications` 用 `alter table applications add column if not exists team_id varchar(32)`（沿用现有"追加列"风格，避免破坏存量部署）。

- **保留期**：`users/teams/team_members` 随账号生命周期保留；`sessions` 过期即清理（建议 ≤30 天）；`audit_logs` **≥180 天**（与 07 审计一致）；`invitations` 接受/过期后保留 90 天。
- **`members` 表处置**：保留不删，`/api/members` 标记为 deprecated（只读），新写入走 `team_members`；一次性迁移脚本把登记项写入默认团队，缺邮箱者标记"待认领"。

### 4.2 与 `access-service.js` / 07 的衔接（关键）

| 07 现状 | 本 PRD 后的行为 |
|---|---|
| `currentAccessLevel()` 读环境变量 `DATA_ACCESS_LEVEL` | 改为 `resolveAccessLevel(req)`：① 已登录 → `team_members.access_level`；② 未登录或 `accounts=false` → 环境变量（fail-close L2） |
| `applyAccessLevel` 中间件按全局等级裁剪 | 裁剪逻辑**零改动**，只把入参从"全局常量"换成"请求者等级" |
| `GET /api/me/access-level` 返回全局等级 | 返回 `{ level, role, teamId, userId }`（未登录仍返回全局等级，保证前端不破） |
| 等级调整 `PUT /api/members/{id}/level` 无身份校验 | 迁移至 `PUT /api/teams/:teamId/members/:userId/access-level`，要求 Admin+ 且不得高于自身等级，写 `audit_logs` |
| `data_access_audit` | 并入 `audit_logs`（`target_type='data'`、`action='view_full_ip'`），保留期与查询入口不变 |

> **依赖顺序一句话**：07 的 FR-2（服务端裁剪，M3-a）已可独立落地；07 的 FR-1/FR-3/FR-4/FR-5（M3-b）**必须等本 PRD 的 P0 完成**。

### 4.3 接口（新增 / 变更）

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | `/api/auth/register` | 邮箱 + 口令注册（可关闭开放注册，见 D1） | 公开 |
| POST | `/api/auth/login` | 登录，下发会话 Cookie | 公开（限流） |
| POST | `/api/auth/logout` | 撤销当前会话 | 登录 |
| POST | `/api/auth/refresh` | 刷新访问令牌 | 登录 |
| GET | `/api/me` | 用户 + 所属团队 + 当前团队 + `role` + `accessLevel` | 登录 |
| GET | `/api/me/access-level` | **沿用 07 端点**，响应扩展 | 登录/匿名兼容 |
| POST | `/api/teams` | 创建团队（创建者自动 Owner/L4） | 登录 |
| GET/PUT | `/api/teams/:teamId` | 团队信息 / 改名改 slug | Member 读 / Owner 写 |
| GET | `/api/teams/:teamId/members` | 成员列表（角色/等级/状态/最后活跃） | Member+ |
| PUT | `/api/teams/:teamId/members/:userId/role` | 变更角色 | Admin+（不可改 Owner） |
| PUT | `/api/teams/:teamId/members/:userId/access-level` | 变更数据等级（≤自身） | Admin+ |
| DELETE | `/api/teams/:teamId/members/:userId` | 移除成员 | Admin+ |
| POST | `/api/teams/:teamId/invitations` | 创建邀请（返回一次性链接） | Admin+ |
| GET | `/api/teams/:teamId/invitations` | 待接受邀请列表 | Admin+ |
| DELETE | `/api/teams/:teamId/invitations/:id` | 撤销邀请 | Admin+ |
| POST | `/api/invitations/:token/accept` | 接受邀请（可匿名，登录/注册后加入） | 公开 |
| POST | `/api/teams/:teamId/applications` | 把 appId 归入团队 | Admin+ |
| GET | `/api/teams/:teamId/audit` | 团队审计日志（≥180d） | Admin+ |
| GET | `/api/members`（**deprecated**） | 保留只读，指向默认团队成员 | 向后兼容 |

- **中间件**：新增身份中间件，在现有 `createMaskingMiddleware()` 与 07 裁剪中间件**之前**解析 `req.auth = { userId, teamId, role, level, via }`；采集（`/api/collect*`）、静态资源、健康检查豁免（与现有 skip 前缀一致）。
- **双后端一致**（全局原则 #4）：Node(PG) 与 Cloudflare(D1) 同表同接口同能力位；若 Worker 侧排期紧张，可降级为"Worker 侧沿用 `ADMIN_API_KEY` + 全局等级"，但**能力位必须报 `accounts=false`**，由前端隐藏团队入口，绝不上报未实现能力。

---

## 5. UI 设计稿描述

### 5.1 新增页：团队与成员 `/teams`（`apps/web/src/views/settings/team/index.vue`）

页头沿用现有 `page-heading` + `caliber-note`（口径透明原则）风格：

> **口径说明**：角色决定"能做什么"，数据等级决定"能看多敏感"；两者独立配置。所有成员/角色/等级变更写入审计日志，保留 ≥180 天。

分区（自上而下，Element Plus 组件）：

1. **团队概览卡**：团队名 / slug / 成员数 / 应用数 / 我的角色徽标 / 我的数据等级徽标（`L1~L4` 复用现有 `.lvl-badge` 样式）；右上角「团队设置」（仅 Owner）。
2. **应用归属区**：`el-table`（应用名 / appId / 平台 / 采集密钥状态）+「＋ 接入应用」；支持把 appId 在团队间移动（Admin+，写审计）。
3. **成员表**：列 = 成员（昵称 + 邮箱）/ 角色（`el-select` 内联切换，Admin+ 可编辑）/ 数据等级（`el-select` L1~L4，Admin+ 且 ≤自身）/ 状态（active / 待接受邀请）/ 最后活跃（复用现有 `activeLabel`）/ 操作（移除，Admin+）。**待接受邀请**以灰行 + "邀请中·7 天后过期"呈现。
4. **邀请抽屉**（`el-drawer`）：邮箱、角色、数据等级三项 + 生成链接；无邮件体系时提供"复制链接"按钮（P1 起支持邮件外发，见 D10）；链接只展示一次。
5. **权限矩阵卡**：复用现有 `lvl-grid` 卡片布局，横向四列展示 Owner/Admin/Member/Viewer 的能力勾选（§3.1 矩阵），只读。
6. **审计抽屉**：复用现有审计表格（时间 / 操作者 / 动作 / 对象），新增 `via` 列区分「控制台」与「API 密钥」。

### 5.2 与现有「成员与数据等级」页（`/access-levels`）的演进关系

**结论：合并，不并列。**

- `/teams` 承接原页的**成员列表 + 等级调整 + 审计**，并升级为真实账号 + 角色。
- `/access-levels` **降级为只读说明页**：保留 L1~L4 能力矩阵四卡（现状 `LEVELS` 常量原样复用）+「我的当前等级」徽标 + 一句引导"成员与等级管理已迁移至 团队与成员"；移除"＋ 登记成员"写入入口。
- 路由保留 `/access-levels` 至少一个大版本（避免书签/文档失效），页面内提供跳转按钮。
- 侧边导航：将「成员与数据等级」改名为「团队与成员」，与「系统设置 / 事件字典 / 采集治理」同组。

### 5.3 顶栏与登录

- 现状 `DashboardHeader.vue` 只有 Admin API Key 输入框；`accounts=true` 时替换为**用户菜单**：头像 / 邮箱 / 当前团队（`el-dropdown` 切换团队）/ 等级徽标 / 退出登录；`accounts=false` 时保持原输入框（零破坏）。
- 新增 `/login` 独立路由页（邮箱 + 口令 + 邀请接受入口），不套 `Layout`；未登录访问任意页 → 重定向登录并回跳。
- 首次启动（空库）：引导页创建首个 Owner，提示"创建后请在环境变量中关闭 ADMIN_API_KEY"。

---

## 6. 成功指标与合规考虑

### 6.1 成功指标

| # | 指标 | 目标 |
|---|---|---|
| S1 | 身份覆盖 | `accounts=true` 部署下，100% 管理/查询接口经身份中间件；无凭据请求 100% 401（自动化断言进 CI） |
| S2 | 隔离有效 | 非团队成员访问他团队 appId 100% 403（自动化断言进 CI） |
| S3 | 解锁 07 | 07 的 FR-1/FR-3/FR-4/FR-5 可在 P0 后一个迭代内直接落地，无需再改账号层 |
| S4 | 协作可用 | 邀请 7 日内接受率 ≥ 70%；团队内活跃成员 ≥ 3 的比例（上线 1 月后）≥ 50% |
| S5 | 不破坏存量 | `accounts=false` 时全站行为与今天完全一致（回归用例全绿）；SDK 采集链路零改动 |

### 6.2 安全与合规（PIPL / 个保法）

- **口令**：`argon2id`（或 `scrypt`）加盐哈希；禁止明文、禁止可逆加密、禁止写入日志；传输全链路 TLS。
- **会话**：Cookie `HttpOnly + Secure + SameSite=Lax`；短期访问令牌 + 可撤销刷新令牌；登出/改密即失效全部会话；登录失败限流。
- **最小必要**：仅收集邮箱与昵称（不收集手机号、真实姓名、身份证）；注册即明示《隐私说明》并留存同意记录（`audit_logs`）。
- **个人信息主体权利**：账号导出与注销接口随本 PRD 预留字段与审计位，完整工作流由 **D1（DSR）** 落地；注销后 `actor_email` 快照保留以维持审计可追溯（审计目的优先于删除，需在隐私说明中明示）。
- **审计**：成员/角色/等级/应用归属变更 100% 入 `audit_logs`，保留 **≥180 天**；日志中 IP 属敏感字段，其**展示**同样受 07 等级约束（存全量、看分级）。
- **等保/审计友好**：所有经 `ADMIN_API_KEY` 的操作标记 `via=api_key`，可被单独筛选与关闭（§1.3 M-b）。

---

## 7. 待确认问题（D 系列决策点）

| # | 决策 | 现状 / 建议 |
|---|---|---|
| D1 | 是否强制登录？是否开放注册？ | 建议：`accounts` 能力位默认 **false**（存量自托管零破坏），新部署默认 true；**开放注册默认关闭**，改为邀请制 + 首个 Owner 引导 |
| D2 | `ADMIN_API_KEY` 是否保留兼容、默认开关命名？ | 建议保留为 `ALLOW_ADMIN_API_KEY`（M-a 默认 true，M-b 默认 false），仅用于引导与 CI |
| D3 | 最小角色集（Owner/Admin/Member/Viewer）是否够用？ | 建议够用；自定义角色与应用级角色留 P2（FR-22） |
| D4 | 本期是否做 SSO（OIDC/SAML）？ | 建议 **不做**，P2（FR-19）；但数据模型预留 `users` 外部身份字段扩展位 |
| D5 | 团队模型：单团队 vs 多团队 vs 组织层级？ | 建议**扁平多团队**（用户可属多团队，团队不嵌套）；组织层级留 P2 |
| D6 | 应用归属：appId 是否强制归属团队？存量如何迁移？ | 建议强制；存量应用迁入"默认团队"（首個 Owner 创建时自动建），`owner` 自由文本列保留不动 |
| D7 | 数据等级与角色的关系？ | 建议**由角色派生默认值 + Owner 可覆盖**（正交但可派生）；等级变更受"不得高于自身"约束 |
| D8 | 会话实现：无状态 JWT vs 服务端 session 表？ | 建议**服务端 session 表 + 短 JWT**（可即时撤销，利于合规与"踢下线"）；D1 已体现在表设计 |
| D9 | 双后端是否同批？ | 建议 Node(PG) 先行，Worker(D1) 同批跟进；不同批时能力位必须报 `accounts=false`（全局原则 #4） |
| D10 | 邀请通道：邮件外发 vs 仅链接复制？ | 建议 P0 仅链接复制（无 SMTP 依赖，与现状"无邮件体系"一致）；P1 接告警通道的邮件/Webhook 复用 |
| D11 | 与 07 的排期顺序？ | **本 PRD P0 → 07 M3-b**（先账号、后按成员授权）；07 M3-a（裁剪中间件）可与本 PRD 并行 |
| D12 | `members` 表与 `/api/members` 何时下线？ | 建议本 PRD 起标记 deprecated，一个大版本后移除；`/access-levels` 同步降级为只读说明页 |

---

## 附录 A：授权判定伪代码（供研发落地，非实现）

```js
// 中间件链顺序：身份 → 租户隔离 → 现有 privacy 掩码 → 07 等级裁剪
function resolveAuth(req) {
  const session = readSession(req)                       // Cookie / Bearer
  if (session) {
    const member = getTeamMember(session.userId, session.teamId)
    return { via: 'session', userId: session.userId, teamId: session.teamId,
             role: member.role, level: normalizeLevel(member.access_level) }
  }
  if (allowAdminApiKey() && timingSafeEqual(req.get('x-api-key'), env.ADMIN_API_KEY)) {
    return { via: 'api_key', userId: 'system', teamId: null, role: 'owner', level: 'L4' }
  }
  return null                                            // 401
}

function authorize(req, { permission, appId } = {}) {
  const auth = resolveAuth(req)
  if (!auth) throw unauthorized()
  if (auth.via === 'api_key' && !allowAdminApiKey()) throw unauthorized()
  if (appId && !appBelongsToTeam(appId, auth.teamId)) throw forbidden()   // 跨团队隔离
  if (permission && !ROLE_MATRIX[auth.role]?.includes(permission)) throw forbidden()
  return auth
}
```

> 说明：以上为**签名与集成点建议**（非实现），交付物为本 PRD；编码实现由研发按此签名落地。
