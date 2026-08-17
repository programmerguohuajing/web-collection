# SDK Release 补 tgz 修复记录

## 事实澄清
- 8 个 GitHub Release：仅 `v0.1.5/0.1.6/0.1.7` 带 `web-collection-sdk-{ver}.tgz`。
- `v0.1.10 / v0.1.14 / v0.1.15 / v0.1.16 / v0.2.2` 这 5 个 release **缺 tgz**。
- 用户说的「0.1.7 之后断了」准确：是重构发布工作流时把 `pnpm pack` 上传 tgz 的步骤一起删了。

## 根因
`release-npm.yml` 重构后（上次只补了 tag + Release 两步）**没有打包上传 tgz 的步骤**。
（注：0.1.7 时代 tgz 命名是 `web-collection-sdk-{ver}.tgz`，来自 `pnpm pack` 产物。）

## 修复：工作流补 tgz（未来永久生效）
`release-npm.yml` 新增步骤「Pack and upload SDK tgz」：
- `pnpm pack`（在 `packages/sdk`，产出 `web-collection-sdk-{ver}.tgz`，沿用历史命名风格）；
- 在「建 GitHub Release」之后，用 `gh release upload` 作为 asset 上传；
- 带存在性保护：已存在则 `--clobber` 覆盖，避免重复上传报错；release 不存在则跳过。

commit `6351e70` 已推 main。从此每次 tag 发布都会自动附带 tgz。

## 回填：5 个已有 release 的 tgz
| 版本 | tgz 来源 |
|---|---|
| v0.1.10 | npm 下载真实包 `sdk-0.1.10.tgz` → 重命名 `web-collection-sdk-0.1.10.tgz` |
| v0.1.15 | 同上（npm） |
| v0.1.16 | 同上（npm） |
| v0.2.2 | 同上（npm） |
| v0.1.14 | **从未发布到 npm** → 从 `v0.1.14` tag 源码 worktree 重建：`pnpm build` + `npm pack` → `web-collection-sdk-0.1.14.tgz` |

现 8 个 release 全部带 `web-collection-sdk-{ver}.tgz`。

## 遗留（待你决定）
- `v0.1.14` 有 GitHub Release + tag，但 **npm 上从没有这个版本**（registry 返回 `version not found: 0.1.14`）。
  已为其补上 tgz（从 tag 源码重建），但 npm 侧仍缺整个包。如需彻底一致，应把 0.1.14 也 `pnpm publish` 到 npm（需先处理该版本当时为何没发）。
- 另：npm 上 `0.1.0~0.1.4`、`0.1.8/0.1.9`、`0.1.11/0.1.12/0.1.13`、`0.2.1` 这些版本**根本没有 GitHub Release**；本次未动（你只要求「后边版本带 tgz」）。如需每个 npm 版本都有 Release + tgz，可再补。

## 沙箱踩坑（供下次参考）
- `pnpm pack` 在 safe-delete 沙箱下因临时目录 trash 失败 → 用 `npm pack` 绕过（直接写 cwd，不 trash）。
- `gh release upload` 用 `/tmp/...` 绝对路径报 "not a git repository"（Git Bash /tmp 映射问题）→ 把 tgz 复制到仓库目录内再上传。
- 沙箱内写盘可能不持久（unsandboxed 才落盘）→ 重建 0.1.14 的 build+pack+upload 整段放在一条 unsandboxed 命令完成。
