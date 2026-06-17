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
| `reviewing` | 等待人工审核。 | 批准、驳回、评论。 |
| `done` | 本节点完成。 | 查看产物、进入下游。 |
| `failed` | 执行失败。 | 重试、替换组件、查看日志。 |

状态命名边界：

- `reviewing` 是 Agent 状态，表示 Agent 或用户正在处理审核动作。
- `pending_review` 是 Gate / Artifact / NodeRun 状态，表示产物等待审核。
- UI 可以把 `pending_review` 节点显示为“审核中”，但底层状态不要混写。
- 审核驳回时，`rejected` 写入 Gate / Artifact / NodeRun；被分配返工的 Agent 进入 `queued`。

非法状态跳转必须拒绝并写入审计事件。例如：

- `pending_review` 不能直接进入下游。
- `blocked` 不能直接标记 `done`。
- `failed` 不能绕过 retry/review 进入 `approved`。

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
      - artifacts.md_master_draft
      - artifacts.md_master_approved
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

- 状态。
- Agent。
- 产物。
- 审核门。
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
event: provider_switched
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

审核门状态，属于 Gate / Artifact / NodeRun，不属于 AgentHealth：

```text
pending_review -> approved -> downstream_allowed
pending_review -> rejected -> queued
pending_review -> blocked -> waiting
pending_review -> comment -> pending_review
```

驳回必须包含：

- 驳回原因。
- 返回节点。
- 修改建议。
- 是否保留当前草稿。

## 11. Audit Events

Agent 状态和权限变化必须审计：

```json
{
  "ts": "2026-06-17T14:30:00+08:00",
  "event": "agent_blocked",
  "agent_id": "tts-agent",
  "node_id": "D_tts_caption",
  "reason": "missing_tts_credentials",
  "recovery_actions": ["配置 VOLC_TTS_API_KEY", "切换备用 TTS provider"]
}
```

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
