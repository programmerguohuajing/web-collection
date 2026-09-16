# Git Commit Specifications (Git 提交规范)

## 提交信息格式要求

在进行 Git 代码提交时，必须遵循以下 **英文类型前缀 + 中文描述** 规范：

### 1. 结构格式
`<type>(<scope>): <中文描述>`

### 2. 关键规则
- **类型前缀 (type)**：必须为标准英文单词（`fix`, `feat`, `docs`, `style`, `refactor`, `perf`, `test`, `chore` 等）。**严禁将左侧 type 翻译为中文**（例如：绝对不能写 `修复(ui):` 或 `新增(overview):`）。
- **描述内容 (description)**：必须使用中文，清晰描述提交的具体内容。
- **常见类型定义**：
  - `fix`: 修复问题/Bug
  - `feat`: 新功能开发
  - `docs`: 文档变动
  - `style`: 样式、格式调整
  - `refactor`: 代码重构（不改变功能与逻辑）
  - `perf`: 性能优化
  - `test`: 测试相关修改
  - `chore`: 构建配置、依赖管理等杂项

### 3. 正确示例
- `fix(ui): 修复概览趋势图长跨度时间桶格式化与 24h 空窗口回退`
- `feat(overview): 支持错误 & 请求趋势图例点击切换`
- `chore(deps): 更新依赖包`

### 4. 错误示例（严禁出现）
- ❌ `修复(前端): 调整样式` （错误原因：type 翻译为了中文）
- ❌ `fix(ui): adjust layout style` （错误原因：描述未包含中文）
