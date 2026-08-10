# Miracle 用户可感知版本变更

> 文档用途：只记录用户和管理员能感知的功能、操作、配置和兼容变化
>
> 当前发布版本：`v0.9.0`
>
> 技术历史真相：仓库根目录 `VERSION_HISTORY.md`

## 1. 如何阅读

升级前重点查看：

1. “操作变化”：是否需要改变日常步骤。
2. “启动与配置”：是否新增环境变量或迁移。
3. “数据兼容”：旧 Run、Workflow 和 Artifact 是否可继续读取。
4. “已知限制”：本版本仍然不能做什么。

## 2. 未发布：角色化说明书与 Web 帮助中心

### 新增功能

- 将系统资料拆为使用者、管理员、开发维护者、故障排查和用户版本变化五类手册。
- 现有 `40` 收敛为帮助总入口。
- Web 侧边栏新增“帮助与手册”，支持角色分类、搜索、文章目录、截图、流程图和深链。

### 操作优化

- 普通使用者不再需要从长篇工程说明中寻找创建任务和审核步骤。
- 管理员可以独立查看启动、凭证、Provider、数据和恢复说明。
- 页面帮助和仓库 Markdown 使用同一内容真相。

### 启动与配置

- 默认 Web/Sidecar 启动方式不变。
- Help API 是只读旁路，不新增凭证。

### 数据兼容

- 不修改 Workflow、Run、Artifact、Gate 和 Event schema。
- 不修改现有任务执行行为。

## 3. v0.9.0 多运行时与模型 Adapter 基线

**发布日期：** 2026-08-01

### 新增功能

- Codex 多节点连续真实执行，节点间按 Artifact 版本和 SHA-256 交接。
- Scheduler 在 Gate 暂停，批准后重算 ExecutionPlan 并恢复下游。
- Retry 支持错误分类、fixed/exponential 退避、次数/时间/成本预算和重启恢复。
- 接入 DeepSeek、Kimi、MiniMax Provider Driver；DeepSeek 完成真实脱敏 smoke。
- Provider Router 支持确定性候选选择、同类 Model API Fallback 和跨 kind 人工确认。
- Run、Attention 和 Artifact 增加 runtime、Profile、model、usage、成本和 Attempt 时间线。

### 操作优化

- 用户能看到“为什么选择某个 Provider、为什么拒绝其他候选”。
- Retry 到期、预算耗尽和人工停止有明确投影。
- Fallback 使用二次确认，避免误切换运行时。
- 一个根因聚合为一个 Attention，相关对象统一展开。

### 问题修复

- 修复 Gate 与其他 P0 blocker 并存时恢复动作被遮蔽。
- 修复旧 RetryState 锁竞争、陈旧 schedule 和 unknown 重复派发风险。
- 修复恢复过程中 Provider Profile 身份丢失或错误猜测。
- 修复 Web Attempt adapter 身份、成本区间和长 Gate ID 布局问题。

### 操作变化

- 下游节点不再只凭上游“完成”执行，而是校验指定 Artifact 版本/hash。
- Retry/Fallback 不覆盖失败 Attempt；用户在时间线查看完整历史。
- Codex 切换到 Model API 必须核对 Decision 后二次确认。

### 启动与配置

- 真实 Codex 仍需 `MIRACLE_ENABLE_REAL_CODEX=1`。
- Model API 真实调用需 `MIRACLE_ENABLE_MODEL_API=1` 和目标 Provider credential_ref。
- 当前 Kimi Profile 使用 `MOONSHOT_API_KEY`。

### 数据兼容

- 旧 routing decision 和 retry intent 可按兼容规则读取/迁移。
- 缺失精确 Profile 的旧 Attempt 不会被系统猜测为某个同 Provider Profile。

### 已知限制

- Kimi、MiniMax 默认仍为 `configured_unverified`。
- 不接 OpenAI 官方 API。
- Hermes/OpenClaw Adapter 未实现。
- 云端控制平面、多租户、账号、权限和计费未实现。

## 4. v0.8.0 真实工作流工程接入基线

**发布日期：** 2026-07-16

### 新增功能

- Historical Importer 支持真实历史 Run preview/commit 和只读 projection。
- Web 可以查看 W24/W23 等历史 Run、DAG、Agent、Artifact、Gate 和证据缺口。
- 新任务先创建 RunDraft，再 Dry-run、确认和启动。
- AdapterContract、Codex CLI 健康检查、隔离 workspace 和真实单节点执行落地。
- 真实 Codex 输出可提交 Markdown Artifact、pending Gate 和 Trace。

### 操作优化

- 启动前能修改主题和 optional 分支，并重新 Dry-run。
- Historical Run 明确标记只读和 source confidence，不与 Miracle 原生 Run 混淆。
- Codex health 只显示状态、版本和原因码，不显示凭证。

### 问题修复

- 修复长 Run/Node/Artifact ID 导致事件审计文本重叠。
- 修复历史审批证据缺失时错误显示 approved 的风险。
- 增强导入幂等、并发锁、receipt 自愈和 symlink 路径检查。

### 操作变化

- “新任务”不会直接创建正式 Run，必须经过 RunDraft、Dry-run 和 confirmation。
- Historical Run 禁止调度、Gate 决策、返工和 Retry。

### 启动与配置

- Historical Import 要求仓库外 `MIRACLE_WORKSPACE_DIR` 和显式 `MIRACLE_IMPORT_ROOTS`。
- 真实 Codex 要求仓库外 runtime workspace 和显式 opt-in。

### 数据兼容

- fixture Run 继续可用。
- 历史缺失事件只生成 projection，不伪造 TraceEvent。

## 5. v0.7.0 本地 MVP 验收基线

**发布日期：** 2026-07-02

### 新增功能

- React Web、Node.js Local Sidecar、packages/core 和 fixture workspace 形成可运行系统。
- 首页、新任务、Dry-run、Run、Attention、Agent、Artifact、Gate 和 Canvas 草稿可用。
- React Flow DAG、Artifact 预览、GateDecision projection 和 Mock Runner 闭环。
- Gate approve/reject/request_changes、返工版本和 Scheduler 连续推进。
- 独立 task-baseline 页面显示任务、依赖、Git 和证据文件。

### 操作优化

- 用户能在同一个 Run 上下文查看节点、事件、Agent、Artifact 和 Gate。
- Attention 按根因聚合。
- Canvas 节点草稿可生成 NodeSpec draft 和 spec diff。

### 操作变化

- 使用 `npm run dev` 同时启动 Web 与 Sidecar。
- 默认 Web 为 `5174`，Sidecar 为 `4317`。

### 已知限制

- 当时主要使用 fixture 和 Mock Runner。
- 无限画布、Spec Sync 和 Evolution 仍不完整。
- 不提供移动端、云端和多租户。

## 6. 版本维护模板

每次发布复制以下结构：

```markdown
## vX.Y.Z 版本名称

### 新增功能
### 操作优化
### 问题修复
### 操作变化
### 启动与配置
### 数据兼容
### 已知限制
```

纯内部重构且没有用户操作影响时，在 `VERSION_HISTORY.md` 记录，并明确“无手册影响”，无需
为本文件制造无意义条目。
