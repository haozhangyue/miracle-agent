# 10_AgentHealth 与多 Agent 状态机设计

## 1. 目标

本文件定义 Miracle 的 Agent 健康、状态机、权限矩阵和协同监控。它解决的是用户在复杂长任务中最容易失去掌控感的问题：

- 哪个 Agent 正在执行？
- 哪个 Agent 卡住了？
- 卡住原因是什么？
- 等待哪个节点、产物、凭证或审核？
- 哪些 Agent 有权限继续下游？

## 2. AgentHealth v0

```yaml
agent_id: tts-agent
name: TTS Agent
status: blocked
current_run: 2026-W24_Codex_ClaudeCode
current_node: D_tts_caption
heartbeat_at: 2026-06-17T14:30:00+08:00
last_event_at: 2026-06-17T14:31:10+08:00
blocked_reason: missing_tts_credentials
waiting_for:
  - credential: VOLC_TTS_API_KEY
runtime_adapter: codex
provider: volc-tts
equipped_libraries:
  - tts-caption-library
outputs_ready: []
recovery_actions:
  - 配置 VOLC_TTS_API_KEY
  - 切换备用 TTS provider
  - 跳过 TTS 进入无音频审看版
```

必填字段：

| 字段 | 说明 |
|---|---|
| `agent_id` | Agent 唯一 ID。 |
| `status` | 当前状态。 |
| `current_node` | 当前节点。 |
| `heartbeat_at` | 最近心跳。 |
| `blocked_reason` | 阻塞原因。 |
| `waiting_for` | 等待对象。 |
| `runtime_adapter` | 实际执行平台。 |
| `provider` | 模型或外部服务。 |
| `equipped_libraries` | 装备组件库。 |
| `recovery_actions` | 可恢复动作。 |

并发说明：

- 上述 AgentHealth v0 表示一个具体运行上下文中的健康投影，不代表 Agent 角色只能参与
  一个 Run。
- 智能体中心需要按 AgentSpec 聚合多个活跃执行、排队任务和阻塞任务。
- P2 只定义聚合展示需求；P3 再定义 runtime/session、执行实例、并发容量和投影身份键。

## 3. Agent 状态机

```text
idle -> queued -> running -> done
running -> waiting -> running
running -> reviewing -> done
running -> blocked -> queued
running -> failed -> queued
reviewing -> queued
```

状态含义：

| 状态 | 含义 | 允许用户动作 |
|---|---|---|
| `idle` | 空闲，可接任务。 | 分配节点、装备组件库。 |
| `queued` | 已排队，等待执行。 | 调整优先级、取消。 |
| `running` | 正在执行。 | 查看实时事件、暂停。 |
| `waiting` | 等待上游、审核、凭证或外部服务。 | 查看等待对象、补输入。 |
| `blocked` | 缺条件，无法继续。 | 修复凭证、替换 provider、跳过。 |
| `reviewing` | Agent 正在执行审核工作，不表示 Gate 尚未决定。 | 查看审核任务。 |
| `done` | 本节点完成。 | 查看产物、进入下游。 |
| `failed` | 执行失败。 | 重试、替换组件、查看日志。 |

状态命名边界：

- `reviewing` 是 Agent 状态，表示 Agent 正在执行审核任务。
- `pending_review` 属于 GateInstance 和 ArtifactManifest，不属于 GateDecision。
- GateInstance 只保存 `pending_review / decided / invalidated`；临时无法审核属于
  attention/blocking reason，不是 GateInstance 状态。
- NodeRun 完成生成后进入 `done`，不进入 `pending_review` 或 `approved`。
- 审核驳回时，创建不可变 GateDecision 并把 ArtifactManifest 标为 `rejected`；
  返工在原 NodeRun 下创建新的 NodeAttempt，Agent 进入 `queued`。

非法状态跳转必须拒绝并写入审计事件。例如：

- `GateInstance.pending_review` 和 `ArtifactManifest.pending_review` 不能进入下游。
- `blocked` 不能直接标记 `done`。
- `failed` 不能绕过 retry/reconcile 创建已批准产物。

## 4. Agent 活跃度与停滞判断

健康级别：

| 级别 | 判断 | UI |
|---|---|---|
| healthy | 最近有事件，节点正常推进。 | 绿色 |
| slow | 超过预期耗时但仍有事件。 | 黄色 |
| stalled | 长时间无事件。 | 橙色 |
| blocked | 明确缺输入/凭证/审核。 | 红色 |
| failed | 工具或 provider 失败。 | 红色 |

示例：

```yaml
health_rule:
  stalled_after_minutes: 20
  slow_after_expected_ratio: 1.5
  blocked_requires_reason: true
```

## 5. PermissionMatrix v0

权限矩阵定义 Agent 能做什么。

```yaml
permission_matrix:
  content-agent:
    can_read:
      - artifacts.clean_events
      - artifacts.topic_strategy
    can_write:
      - artifact_manifests.md_master
    can_call_tools:
      - read_files
      - write_markdown
      - web_reference
    can_message:
      - editor-agent
      - review-agent
    can_auto_downstream: false
  review-agent:
    can_read: ["*"]
    can_write:
      - gate_decisions
      - artifact_status_updates
      - audit_events
    can_approve_gates: true
```

权限维度：

- 文件读。
- 文件写。
- 产物创建。
- 工具调用。
- MCP 调用。
- provider 使用。
- Agent 间通信。
- 审核门批准。
- 是否允许自动下游。

## 6. Agent Health Dashboard

Dashboard 推荐 5 个区域：

```text
左侧：Agent 列表与健康卡
中间：当前任务流转链
右侧：当前 Agent 详情
下方：事件流 / 工具调用 / 审计日志
顶部：全局状态、运行中、阻塞、待审核、失败数量
```

健康卡展示：

- Agent 名称。
- 当前状态。
- 当前节点。
- runtime adapter。
- provider。
- 装备组件库。
- 最近事件时间。
- 等待对象。
- 恢复动作。

## 7. 任务流转链

任务详情必须显示完整流转链：

```text
A 情报采集 -> B MD 母稿 -> Gate B 审核 -> C0 脚本池 -> C 分镜 -> D TTS blocked
```

每个节点展示：

- NodeRun 状态。
- 当前 NodeAttempt 和历史 Attempts。
- Agent。
- ArtifactManifest 实例和状态。
- GateInstance、GateDecision 和绑定的 artifact hash。
- 耗时。
- 错误或阻塞。

## 8. 模型热切换

模型热切换不是随意切换，而是受节点和权限约束。

切换前检查：

- 新 provider 是否满足节点能力需求。
- 是否有凭证。
- 是否允许当前 Agent 使用。
- 是否会影响成本。
- 是否需要重新 dry-run。

记录事件：

```yaml
event_id: evt_000205
sequence: 205
run_id: run_20260618_001
event_type: provider_switched
event_category: audit
subject:
  type: node_run
  id: run001_B_md_master
actor:
  type: user
  id: local_user
timestamp: 2026-06-18T11:10:00+08:00
payload:
  agent_id: content-agent
  node_id: B_md_master
  from: gpt-5-codex
  to: claude-sonnet
  reason: 用户要求提高长文质量
```

## 9. 组件装备面板

Agent 组件装备面板展示：

- 当前装备组件库。
- 可选组件库。
- 每个组件库包含哪些 skill/tool/MCP/provider。
- 权限风险。
- 是否 experimental。
- 最近成功率。

装备变更必须写入 audit event。

## 10. 审核返工循环

审核返工由 GateInstance、GateDecision、ArtifactManifest 和新的 NodeAttempt 共同表达：

```text
GateInstance: pending_review -> decided
GateDecision: approved -> bound artifact ID/hash downstream_allowed
GateDecision: rejected
ArtifactManifest: pending_review -> rejected
Rejected -> same NodeRun creates new NodeAttempt -> queued
Comment -> GateComment / audit TraceEvent; GateInstance stays pending_review
```

驳回必须包含：

- 驳回原因。
- 返回节点。
- 修改建议。
- 是否保留当前草稿。

批准后文件 hash 变化时，原 GateDecision 不适用于修改后的文件；系统必须创建新的
ArtifactManifest 和 GateInstance，不能复用旧批准。

## 11. TraceEvent 与 AuditEvent

AuditEvent 是统一 TraceEvent envelope 的受保护子类型，使用
`event_category: audit`。Agent 状态变化可以是 runtime event，权限变化、危险操作、
人工审核和恢复动作必须是 audit event。

```yaml
event_id: evt_000108
sequence: 108
run_id: run_20260618_001
event_type: agent_blocked
event_category: runtime
subject:
  type: node_run
  id: run001_D_tts
actor:
  type: system
  id: orchestrator
timestamp: 2026-06-18T10:42:00+08:00
payload:
  node_id: D_tts_caption
  agent_id: tts-agent
  reason: missing_tts_credentials
  recovery_actions:
    - 配置 VOLC_TTS_API_KEY
    - 切换备用 TTS provider
```

所有事件必须包含 `event_id`、`sequence`、`event_type`、`event_category`、
`subject`、`actor`、`timestamp` 和 `payload`。run 内事件还必须包含 `run_id`；
Registry、Local Service 等 run 外事件允许为空。审计事件不得静默覆盖，且必须对
凭证、token、cookie 和私密输入脱敏。

## 12. MVP 边界

MVP 必做：

- AgentHealth v0 字段。
- Agent 状态机。
- PermissionMatrix 文档契约。
- Health Dashboard 低保真结构。
- blocked / failed / reviewing 三类关键状态可视化。

暂不做：

- 真实心跳服务。
- 自动进程管理。
- 复杂 RBAC。
- 多用户在线协作。
