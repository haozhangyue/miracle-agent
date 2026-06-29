# 25_P4第二轮_DAG预览Gate投影与Canvas草稿交付说明

> 文档状态：P4 第二轮 MVP 交付说明。  
> 交付范围：React Flow DAG、Artifact Detail 预览、Gate 决策投影、Infinite Canvas 草稿态。

## 1. 本轮交付内容

P4 第二轮在第一轮可运行主链路上补齐四个关键体验：

| 能力 | 状态 | 说明 |
|---|---|---|
| React Flow DAG | 已实现 | Run 工作区从列表升级为只读流程图，显示节点状态、Agent、required/optional 边和布局说明。 |
| Artifact Detail 预览 | 已实现 | Artifact Board 支持 Manifest 主从结构，右侧预览 markdown、json、text；缺失和二进制产物显示原因。 |
| Gate 决策投影 | 已实现 | Gate Detail 返回 projection，审核后展示下游 NodeRun 影响、事件收据和 Artifact 审核状态投影。 |
| Infinite Canvas 草稿态 | 已实现 | Workflow canvas draft 可读取、移动卡片、保存草稿，并展示 spec diff preview。 |

本轮仍不做真实 Runner、云端、多租户、账号、计费和移动端适配。

## 2. 新增和调整的接口

```text
GET  /api/v0/runs/:runId/dag
GET  /api/v0/artifacts/:artifactId
GET  /api/v0/gates/:gateId
POST /api/v0/gates/:gateId/decision
GET  /api/v0/workflows/:workflowId/canvas-draft
POST /api/v0/workflows/:workflowId/canvas-draft
```

接口边界：

- DAG 是 `WorkflowSnapshot + NodeRun` 的投影，不是新的执行真相。
- Artifact Detail 读取 `ArtifactManifest` 和本地文件预览；预览失败不改变产物状态。
- Gate 决策仍只写入 `GateDecision` 和事件；projection 说明影响，不直接覆盖 Artifact。
- Canvas draft 只写 layout 草稿和 spec diff preview，不改变 workflow 执行依赖。

## 3. Fixture 更新

新增轻量预览文件：

- `fixtures/mvp-workspace/.miracle/artifacts/clean_events_v1.json`
- `fixtures/mvp-workspace/.miracle/artifacts/script_draft_v1.md`

新增初始画布草稿：

- `fixtures/mvp-workspace/.miracle/drafts/canvas-content-production-v0.json`

## 4. 前端页面变化

| 页面 | 变化 |
|---|---|
| Run 工作区 | 流程视图使用 React Flow，节点点击后仍联动 Node Detail。 |
| Artifact Board | 表格选择产物后打开 Detail Preview，展示 Manifest、hash、路径和正文预览。 |
| Gate Review | 增加决策投影区域，展示审批/驳回对下游节点的影响。 |
| Infinite Canvas | 从占位页升级为草稿编辑页，支持移动节点卡和保存草稿。 |

## 5. 验收重点

1. `Run` 页面能看到 React Flow 图形化 DAG，required 与 optional 边可区分。
2. 点击 DAG 节点后，右侧 Node Detail 能刷新。
3. `Artifact` 页面能预览 markdown、json、text 文件；missing/binary 有明确说明。
4. `Gate Review` 页面能看到 projection，并在决策后展示 receipt。
5. `Canvas` 页面能移动卡片并保存到 `drafts/canvas-content-production-v0.json`。

## 6. 截图证据

| 页面 | 截图 |
|---|---|
| React Flow DAG | `assets/reviews/p4-mvp-round2/01-react-flow-dag.png` |
| Artifact Detail Preview | `assets/reviews/p4-mvp-round2/02-artifact-detail-preview.png` |
| Gate Projection | `assets/reviews/p4-mvp-round2/03-gate-projection.png` |
| Infinite Canvas Draft | `assets/reviews/p4-mvp-round2/04-infinite-canvas-draft.png` |

## 7. 当前边界

- React Flow 只读展示，不支持在 Run 中改 WorkflowSnapshot。
- Canvas 草稿不等于正式 WorkflowSpec 发布。
- Gate projection 是推演视图，不代表 Orchestrator 已执行下游推进。
- Artifact 预览只读取本地文本类文件，不提供媒体播放器。
