# SDK 发布流程：tag / Release 缺失修复记录

## 事实澄清
- npm 上发布的是 **`0.2.2`**（registry `dist-tags.latest = 0.2.2`），**不存在 `2.2.0`**（请求返回 404）。
  若界面看到 `2.2.0`，应为误读或别处手动包；本仓库 / 本工作流从未发过 `2.2.0`。
- GitHub `v0.2.2` tag 与 Release **确实缺失**——真实待修项。

## 根因（架构缺陷）
`release-npm.yml` 同时保留 `workflow_dispatch` 走 `main` 直接发布，但工作流里
**没有「打 tag + 建 Release」步骤**。于是走 main 手动触发时：npm 发了，tag / Release 却没踪影。
而历史 `v0.1.x / v0.2.1` 有 tag，是因为那时由 tag 推送触发发布。

## 修复方案：tag 作为唯一真相源
重写 `release-npm.yml`：
- **仅由 `vX.Y.Z` tag 推送触发**（删除 `workflow_dispatch` 走 main 的路径）。
- 同一流程内：① 校验 `tag` 版本号 == `package.json` 版本；② 发布 npm（带幂等保护）；
  ③ `gh release create` 自动建 GitHub Release 并生成 notes。
- 从此 npm 版本 / git tag / GitHub Release 三者永远一致，不再漂移。

## 本次执行
1. 重写工作流，commit `bd35da3` → 推到 `main`（网络抖动重试后成功）。
2. 因 npm 已发 `0.2.2`（提交 `6221061`，即当时 main HEAD），补建 `v0.2.2`：
   - `gh api` 建 tag ref `refs/tags/v0.2.2` 指向 `6221061`；
   - `gh release create v0.2.2 --generate-notes` → 现为 **Latest Release**。

## 验证
- GitHub Release 列表：`v0.2.2`（Latest, 2026-08-14）；`v0.1.16`；`v0.1.15`。
- npm：`latest = 0.2.2`。
- 远程 tag：`v0.2.2` 已存在（指向 `6221061`）。

## 后续发布规范
- 发版动作 = `git tag vX.Y.Z && git push origin vX.Y.Z`（且 `package.json` 版本需先 bump 并合并到 main）。
- 由 tag 推送触发工作流，自动完成 npm 发布 + GitHub Release，无需手动建。

## 踩坑记录（沙箱）
- 本机 TUN 代理 `HTTPS_PROXY=127.0.0.1:7892`（Psychz 出口）对 github TLS 不稳定：
  git 走 Windows 原生 schannel + 代理 MITM 证书会 `schannel: failed to receive handshake`；
  `gh` CLI 走自身 Go TLS 栈反而能通。网络抖动时优先用 `gh api` 操作 tag/release，
  或等网络恢复再 `git push`。
