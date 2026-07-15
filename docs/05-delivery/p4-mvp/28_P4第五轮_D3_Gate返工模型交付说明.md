# 28_P4第五轮_D3_Gate返工模型交付说明

> 文档状态：P4 第五轮 D3 工程交付说明
>
> 对应任务：`plans/mvp-task-baseline/roadmap.json` 中的 `d3-rework-model`
>
> 结论：D3 Gate reject 返工模型已落地。当前只完成运行事实模型和 Sidecar API，不做返工 UI，UI 进入 D4。

## 1. 本轮目标

D3 解决的问题是：Gate 被驳回后，系统不能只把原产物标记为 rejected，还必须能形成可审计的返工链路。

本轮新增最小闭环：

```text
GateInstance rejected / request_changes
-> Rework NodeAttempt
-> New ArtifactManifest version
-> New GateInstance pending_review
-> 审核通过后恢复 required_before 下游节点
```

核心边界保持不变：

- `RunSpec` 仍是运行根对象。
- `WorkflowSnapshot` 仍是冻结工作流副本。
- `NodeAttempt`、`ArtifactManifest`、`GateInstance`、`TraceEvent` 仍只由 Sidecar Orchestrator 写入。
- Rework 不修改原 Artifact，不覆盖历史 GateDecision。

## 2. 新增接口

### 2.1 创建返工版本

```http
POST /api/v0/gates/:gateId/rework?run_id=:runId
```

请求示例：

```json
{
  "actor": "local_user",
  "comment": "补充事实来源后重新提交",
  "content": "# 可选的新产物正文"
}
```

响应示例：

```json
{
  "accepted": true,
  "rework_attempt_id": "attempt_op_rework_nr_run_B_md_master_1780000000000",
  "artifact": {
    "artifact_id": "art_run_B_md_master_md_master_v2",
    "version": 2,
    "review_status": "pending_review",
    "supersedes_artifact_id": "art_run_B_md_master_md_master_v1",
    "rework_of_gate_instance_id": "gate_art_run_B_md_master_md_master_v1"
  },
  "gate": {
    "gate_instance_id": "gate_art_run_B_md_master_md_master_v2",
    "status": "pending_review"
  },
  "next_suggested_actions": ["review_rework_gate"]
}
```

## 3. 状态写入规则

### 3.1 前置条件

只有满足以下条件时才能创建返工：

- GateInstance 状态为 `decided`。
- 最新 GateDecision 是 `reject` 或 `request_changes`。
- Gate target ArtifactManifest 存在。
- 目标 Artifact 的 producer NodeRun 存在。

否则返回 `409 gate_not_reworkable` 或 `404 not_found`。

### 3.2 写入对象

创建返工时，Orchestrator 会写入：

| 对象 | 写入规则 |
|---|---|
| `NodeAttempt` | 新增 `attempt_kind: rework`，状态为 `succeeded`。 |
| `ArtifactManifest` | 新增 version + 1 的产物，`review_status=pending_review`。 |
| `GateInstance` | 为新产物创建新的 `pending_review` Gate，不复用旧 Gate。 |
| `NodeRun` | producer NodeRun 回到 `reviewing`，下游 required_before 继续 `blocked`。 |
| `AttentionItem` | 新增返工产物待审核 Attention。 |
| `TraceEvent` | 追加 `rework_attempt_created`、`artifact_manifest_created`、`gate_pending_review`。 |

### 3.3 审核恢复规则

新 Gate 审核通过后：

1. 新 ArtifactManifest `review_status` 更新为 `approved`。
2. producer NodeRun 从 `reviewing` 进入 `done`。
3. `required_before` 中因为 Gate 等待而阻塞的下游节点重新判断 Edge selector。
4. 若 required 输入满足，下游 NodeRun 进入 `queued`。
5. 下游 NodeRun 的 `upstream_artifacts` 会包含新的返工产物版本。

## 4. 当前边界

本轮暂不做：

- Web 返工按钮和抽屉交互。
- 人工编辑器或 diff 预览。
- 真实 Runner 返工执行。
- 多轮复杂返工的 UI 时间线。

这些进入 D4 和后续迭代。

## 5. 测试覆盖

新增 Sidecar 集成测试：

```text
creates a rework attempt with a new artifact version after gate reject
```

覆盖链路：

```text
POST /runs
-> execute A_collect
-> execute B_md_master
-> reject generated gate
-> POST /gates/:gateId/rework
-> approve rework gate
-> assert C_script / G_distribution queued
```

重点断言：

- 旧 ArtifactManifest 变为 `rejected`。
- 新 ArtifactManifest 版本号递增，且记录 `supersedes_artifact_id`。
- 新 GateInstance 状态为 `pending_review`。
- producer NodeRun 回到 `reviewing`。
- 新 Gate 通过后，下游节点恢复为 `queued`。
- 下游 `upstream_artifacts` 指向新返工产物。

## 6. 下一步建议

建议后续并行推进：

| 任务 | 是否可并行 | 说明 |
|---|---:|---|
| D4 Gate reject 返工 UI 与事件审计 | 串行后续 | 依赖本轮 D3 模型。 |
| D5 最小 scheduler 设计 | 可并行 | 可基于现有 queued/blocking/Gate pause 语义设计。 |
| D7 Adapter 插件目录实体化 | 可并行 | 与返工 UI 无硬依赖。 |
| D8 Canvas 新增节点生成 NodeSpec draft | 可并行 | 属于 Visual/Spec 编辑链路。 |
| D9 Web run refresh/polling | 可并行 | 可独立增强运行反馈。 |

推荐下一步主线是 D4，同时并行准备 D5 设计。
