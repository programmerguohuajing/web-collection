# 概览：AI 诊断功能 PRD（含 RAG 知识库规划）

## 完成内容
- 基于代码探查（双后端/Cloudflare 为真实后端、trace 仅前端 span、零 AI 资产），规划了 AI 诊断功能的完整 PRD。
- 交付物：`outputs/ai-diagnosis-prd.md`

## 关键决策（用户已拍板）
- 模型：混合模式（国内默认 + 复杂场景路由海外，统一 Model Gateway，海外通道强制 PII 脱敏）
- RAG 来源：历史已解决 issues + 内部 runbook + 项目/SDK 文档 + 源码（四类全要）
- 部署：独立 AI Worker，与采集主链路隔离
- 入口：控制台内嵌「AI 诊断」按钮 + 开放诊断 API（v1 不做告警自动触发）

## 核心结构
- 问题陈述 / 目标(G1–G5) / 非目标 / 用户故事 / 需求(P0–P2) / RAG 详细设计(6.1–6.8) / 成功指标 / 开放问题(Q1–Q6) / 里程碑(M0–M5)

## 关键风险与待决
- **Q1（阻塞）**：issues 表无"解法"字段，RAG 只能拿症状拿不到解法 → 需加 resolution_notes 或统一进 runbook
- **Q2**：实时链路仅前端 span，跨服务根因需先打通后端 span 上报
- 模型/embedding 供应商与成本、海外出境合规、留存期限待定

## 下一步
- 拍板 Q1–Q4 → 进入 M1 知识库底座建设
