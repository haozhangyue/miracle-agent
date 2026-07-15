# 09_WorkflowSpec 与 Registry 技术草案

## 1. 目标

本文件把 Miracle 的工作流从“概念规划”推进到可版本化、可校验、可 dry-run、可导入真实项目的 `WorkflowSpec YAML v0`。

设计原则：

- WorkflowSpec 是模板与编排真相；运行事实由 RunSpec、WorkflowSnapshot、NodeRun、
  NodeAttempt、TraceEvent、ArtifactManifest、GateInstance、GateDecision、
  CredentialCheckResult 承载。
- UI、CLI、SDK 都只是编辑器或视图。
- 执行依赖只看 `edges`，画布位置不影响执行。
- 工作流必须可进入 Git、可 diff、可回滚、可注册到 Registry。
- MVP 先支持本地优先，不依赖云端数据库。

## 2. WorkflowSpec YAML v0

最小结构：

```yaml
schema_version: miracle.workflow.v0
id: content-production-v0
name: 热点工具更新内容生产全流程
version: 0.1.0
category: content_production
status: stable
description: 官方源事实到 MD 母稿、脚本、分镜、TTS、视频、分发和复盘

registry_meta:
  source: local_project
  owner: miracle-agent
  path: workflows/content-production-v0.workflow.yaml
  imported_from: /Users/zhangyue/Documents/Obsidian Vault/热点工具更新

provider_policy:
  default_runtime_adapter: codex
  allowed_runtime_adapters: [codex, hermes, openclaw, claude_code, official_api]
  default_provider: gpt-5-codex
  fallback_order: [claude_code, official_api]

nodes: []
edges: []
gates: []
artifacts: []
layouts:
  dag: {}
  canvas: {}
```

必填字段：

| 字段 | 说明 |
|---|---|
| `id` | 工作流唯一 ID。 |
| `name` | 用户可读名称。 |
| `version` | 语义化版本，用于升级和回滚。 |
| `category` | 任务类型，如 content、video、research、coding。 |
| `nodes` | 节点定义列表。 |
| `edges` | 执行依赖边。 |
| `gates` | 审核门定义。 |
| `artifacts` | 产物契约。 |
| `provider_policy` | runtime adapter 和 provider 默认策略。 |
| `layouts` | UI 布局，不参与执行逻辑。 |
| `registry_meta` | 模板来源和注册信息。 |

## 3. NodeSpec v0

NodeSpec 是“节点契约”，不是单个执行记录。它必须同时服务于 validate、dry-run、DAG 可视化、Agent 分配和产物追踪。

字段模板：

```yaml
id: node_id
name: 用户可读节点名
type: agent
agent_candidates: []
recommended_libraries: []
capability_requirements: []
inputs: []
outputs: []
join_policy: null
review_gate: null
failure_policy:
  retry: 0
  on_missing_input: blocked
  on_tool_failure: failed
  on_quality_reject: rejected
subworkflow_enabled: false
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 节点唯一 ID。 |
| `name` | 是 | 用户可读名称。 |
| `type` | 是 | 节点类型，取值见下方“节点类型”。 |
| `agent_candidates` | 否 | 可执行该节点的 Agent 候选。 |
| `recommended_libraries` | 否 | 推荐组件库。 |
| `capability_requirements` | 否 | 节点需要的能力标签。 |
| `inputs` | 否 | 输入契约，建议使用对象数组。 |
| `outputs` | 否 | 输出契约，建议使用对象数组。 |
| `join_policy` | 否 | required/optional 输入的启动和等待策略。 |
| `review_gate` | 否 | 绑定 GateSpec ID；不等同于 `review_gate` 节点类型。 |
| `failure_policy` | 否 | 缺输入、工具失败、质量驳回时的状态策略。 |
| `subworkflow_enabled` | 否 | 是否允许展开子工作流。 |

示例：内容 MD 母稿节点。

```yaml
id: B_md_master
name: 内容 MD 母稿
type: transform
agent_candidates: [content-agent, editor-agent]
recommended_libraries: [content-packaging-library]
capability_requirements:
  - content.longform_draft
  - fact.safe_writing
inputs:
  - name: approved_clean_events
    artifact_spec_id: clean_events
    required: true
    selector:
      run_scope: current
      status: approved
      strategy: latest_approved
  - name: topic_strategy_input
    artifact_spec_id: topic_strategy
    required: true
    selector:
      run_scope: current
      strategy: latest
outputs:
  - artifact_spec_id: md_master
review_gate: B_md_master_gate
failure_policy:
  retry: 1
  on_missing_input: blocked
  on_tool_failure: failed
  on_quality_reject:
    gate_decision: rejected
    requeue_node: B_md_master
subworkflow_enabled: true
```

节点类型：

| 类型 | 用途 |
|---|---|
| `start` | 任务入口。 |
| `source` | 数据源、用户输入、外部输入。 |
| `agent` | Agent 执行任务。 |
| `tool` | 调用普通工具或脚本。 |
| `mcp_tool` | 调用 MCP tool。 |
| `transform` | 生成、清洗、改写、转换。 |
| `branch` | 条件分支。 |
| `loop` | 循环或批量处理。 |
| `review_gate` | 人工或自动审核。 |
| `artifact` | 显式产物节点。 |
| `subworkflow` | 子工作流入口。 |
| `end` | 正常结束。 |
| `terminate` | 显式失败或中止。 |

说明：

- `type: review_gate` 表示审核节点本身。
- `review_gate: B_md_master_gate` 表示当前业务节点绑定一个 GateSpec。
- 两者可以共存，但含义不同：前者是节点类型，后者是审核契约引用。

## 4. EdgeSpec v0

```yaml
- id: edge_A_to_B
  from: A_fact_intelligence
  to: B_md_master
  required: true
  condition:
    gate_spec_id: A_fact_gate
    decision_in: [approved, auto-approved]
  passes_artifacts:
    - clean_events
    - topic_strategy
```

规则：

- `edges` 是唯一执行依赖来源。
- `required: true` 的边参与节点启动条件；optional edge 只提供可选输入。
- 布局位置、画布分组、卡片距离不影响执行顺序。
- 条件分支必须写明 `condition`，不能隐藏在节点 prompt 中。
- 条件必须声明状态归属，例如 `gate_spec_id + decision_in` 或
  `artifact_spec_id + status_in`，禁止使用含义不明的 `status in [...]`。
- Gate 条件运行时解析到 selected artifact 对应的 GateInstance，不能复用其他版本
  的 GateDecision。

## 5. GateSpec v0

```yaml
id: B_md_master_gate
node: B_md_master
mode: manual
reviewer: user
allow_downstream_decisions: [approved, auto-approved]
actions: [approve, reject, comment, block, skip]
reject_to: B_md_master
required_before:
  - C0_script_pool
```

审核门类型：

| 类型 | 说明 |
|---|---|
| `manual` | 用户审核。 |
| `auto` | 自动检查。 |
| `conditional` | 根据条件决定 manual 或 auto。 |
| `skip` | 本轮跳过。 |

GateSpec 字段语义：

- `actions` 是 UI、CLI 或 API 可以发起的动作，只允许
  `approve / reject / comment / block / skip`。
- 动作执行后，除 comment 外，分别形成
  `approved / rejected / blocked / skipped` GateDecision；自动审核形成
  `auto-approved`。
- `allow_downstream_decisions` 使用 GateDecision 的结果枚举，不使用动作枚举。
- `required_before` 只允许约束通过 required edge 消费该审核产物的下游节点。
  optional edge 的等待和放行由目标节点的 join policy 与 selector 决定。

## 6. ArtifactSpec v0

```yaml
id: md_master
name: MD 母稿
kind: markdown
path_template: runs/{run_id}/03_内容母稿/{artifact_version}/MD母稿.md
produced_by: B_md_master
consumed_by: [C0_script_pool, G_distribution_retro]
review_policy:
  mode: manual
  gate_id: B_md_master_gate
```

产物原则：

- ArtifactSpec 是模板产物契约，不保存真实路径、hash 或运行审核状态。
- 产物必须知道来源节点和下游消费者。
- 大文件只记录路径或外部链接，不强行进入 Git。
- 模板编辑器中的产物占位卡绑定 ArtifactSpec。

`review_policy.mode`：

| mode | 行为 |
|---|---|
| `none` | Attempt succeeded 后 Manifest 直接进入 approved。 |
| `auto` | validators 全部通过后 approved，失败按 `on_fail` 处理。 |
| `manual` | Manifest 进入 pending_review，并创建 GateInstance。 |
| `conditional` | 运行时按风险规则解析为 auto 或 manual。 |

## 7. RunSpec 与 WorkflowSnapshot v0

创建真实 run 时必须冻结所依据的工作流版本和解析结果：

```yaml
run_id: run_20260618_001
workflow_id: content-production-v0
workflow_version: 0.1.0
workflow_hash: sha256:abc123
workflow_snapshot:
  path: runs/run_20260618_001/workflow.snapshot.yaml
resolved_components:
  B_md_master: content-packaging-library@0.3.0
  D_tts_caption: tts-caption-library@0.2.1
resolved_provider_policy:
  path: runs/run_20260618_001/provider-policy.snapshot.json
created_at: 2026-06-18T10:00:00+08:00
status: running
attention:
  - pending_review
  - blocked
```

规则：

- snapshot 在 run 生命周期内不可变。
- resume、retry、replay 均使用 snapshot，不重新读取当前 stable 模板。
- 用户明确升级运行版本时，记录 migration TraceEvent，并生成新的执行计划。
- Run 主状态使用 `created / queued / running / paused / cancelling / cancelled /
  failed / completed / aborted`。
- `pending_review / blocked / reconciliation_required` 作为 attention flags，可并存。
- completed 要求所有 required NodeRun、GateInstance 和 ArtifactManifest 满足完成条件。

## 8. ArtifactManifest v0

ArtifactManifest 是某次 NodeAttempt 实际产生的产物实例：

```yaml
artifact_id: artifact_run001_md_master_v1
artifact_spec_id: md_master
run_id: run_20260618_001
node_run_id: run001_B_md_master
attempt_id: B_md_master_attempt_1
artifact_version: 1
path: runs/run_20260618_001/03_内容母稿/v1/MD母稿.md
hash: sha256:def456
size: 18420
status: pending_review
produced_by: B_md_master
source_event_id: evt_000108
created_at: 2026-06-18T10:42:00+08:00
```

规则：

- NodeAttempt 产生 ArtifactManifest，不产生 ArtifactSpec。
- Manifest 必须反向引用 ArtifactSpec。
- 重试默认产生新 artifact version，不静默覆盖旧实例。
- Artifact Board 的运行视图绑定 ArtifactManifest。
- 路径模板必须包含 `{artifact_version}` 或 `{attempt_id}`。
- 可维护 ArtifactAlias 指向 latest/latest approved，但执行输入仍要解析成具体 artifact ID。

## 9. Artifact Selector 与 resolved inputs v0

NodeSpec 只声明选择策略：

```yaml
inputs:
  - name: approved_md_master
    artifact_spec_id: md_master
    required: true
    selector:
      source_scope: edges
      run_scope: current
      status: approved
      strategy: latest_approved
```

可选 strategy：

```text
latest_approved / first_approved / explicit / all_matching / merge
```

Orchestrator 创建 NodeAttempt 前解析为具体实例：

```yaml
resolved_inputs:
  approved_md_master:
    artifact_id: md_master_run001_v3
    hash: sha256:333
    selected_by: latest_approved
```

规则：

- required selector 无匹配时阻止创建 Attempt。
- optional selector 无匹配时解析为 absent，不选择 rejected/draft 产物。
- selector 默认 `source_scope: edges`，只能选择入边传递且可达的 ArtifactSpec。
- run-wide 查询必须显式使用 `source_scope: run`，并由 validate 给出风险提示。
- `explicit` 必须由用户或上游提供 artifact ID。
- 当前 Attempt 的 resolved inputs 创建后不可漂移。

## 10. GateInstance、GateDecision 与 GateComment v0

GateInstance 绑定某次 run 的具体产物版本：

```yaml
gate_instance_id: run001_B_gate_v2
gate_spec_id: B_md_master_gate
run_id: run_20260618_001
node_run_id: run001_B_md_master
artifact_ids:
  - md_master_run001_v2
status: pending_review
```

最终决定不可变，并绑定 artifact ID 和 hash：

```yaml
decision_id: decision_run001_B_v2_approve
gate_instance_id: run001_B_gate_v2
decision: approved
reviewer:
  type: user
  id: local_user
decided_at: 2026-06-18T11:00:00+08:00
artifact_bindings:
  - artifact_id: md_master_run001_v2
    hash: sha256:222
```

规则：

- GateInstance 状态只允许 `pending_review / decided / invalidated`。
- `pending_review` 属于 GateInstance，不属于 GateDecision。
- GateDecision 只允许 `approved / auto-approved / rejected / blocked / skipped`。
- comment 写入 GateComment 或 `event_category: audit` 的 TraceEvent。
- 文件 hash 变化后，原决定不再适用，创建新 ArtifactManifest 和 GateInstance。
- 临时不可审核写入 attention/blocking reason，不增加 GateInstance.blocked 状态。
- 下游必须校验 GateDecision 的 artifact binding，不能只看 GateSpec ID。

## 11. ProviderPolicy v0

```yaml
provider_policy:
  default_runtime_adapter: codex
  node_overrides:
    D_tts_caption:
      runtime_adapter: official_api
      provider: volc-tts
      fallback_order: [macos_say_preview]
      credential_required: [VOLC_TTS_API_KEY]
    E_visual_video:
      runtime_adapter: codex
      provider: hyperframes-local
```

ProviderPolicy 管理：

- 默认 runtime adapter。
- 默认 provider。
- 节点级 override。
- fallback 顺序。
- 凭证要求。
- 成本和质量偏好。

## 12. LayoutSpec v0

```yaml
layouts:
  dag:
    B_md_master:
      x: 420
      y: 160
  canvas:
    zones:
      content:
        label: 内容区
        x: 800
        y: 120
        width: 520
        height: 360
    cards:
      B_md_master:
        zone: content
        x: 860
        y: 180
```

布局规则：

- `layouts.dag` 服务流程节点视图。
- `layouts.canvas` 服务无限画布。
- layout diff 不应改变执行顺序。
- 如果 UI 删除节点卡，必须明确是“隐藏卡片”还是“删除 NodeSpec”。

## 13. WorkflowRegistry v0

Registry 负责模板发现、版本、来源和发布。

```yaml
registries:
  local_project:
    type: local_project
    path: ./workflows
  local_registry:
    type: local_registry
    path: ~/.miracle/registries/default
  github_templates:
    type: github_repo
    repo: haozhangyue/miracle-agent-workflows
    ref: main
  builtin:
    type: builtin_template
```

模板状态：

```text
draft / experimental / stable / deprecated / blocked
```

Registry 能力：

- 列出模板。
- 拉取模板。
- 发布模板。
- 标记 stable / deprecated。
- 回退版本。
- 比较本地覆盖和远端模板。

## 14. Validate / Dry-run / Estimate

### validate

输入：

```bash
miracle validate content-production-v0.workflow.yaml
```

检查：

- YAML 结构是否完整。
- 节点 ID 是否唯一。
- edge 是否指向存在节点。
- NodeSpec 输入和输出引用的 ArtifactSpec 是否存在。
- ArtifactSpec 的 produced_by/consumed_by 是否引用存在节点。
- NodeSpec review_gate 是否引用存在 GateSpec。
- NodeSpec review_gate 与其输出 ArtifactSpec 的 manual/conditional
  `review_policy.gate_id` 是否一致。
- GateSpec 的 node/reject_to/required_before 是否引用存在节点。
- GateSpec actions 是否使用动作枚举，allow_downstream_decisions 是否使用决定枚举。
- GateSpec required_before 是否只指向通过 required edge 消费审核产物的下游节点。
- EdgeSpec passes_artifacts 是否引用存在 ArtifactSpec。
- required input 是否存在传递对应 ArtifactSpec 的 required edge。
- optional input 若由 edge 提供，该 edge 是否明确为 optional。
- selector 是否只选择 edge 可达产物；`source_scope: run` 是否显式声明。
- join_policy 是否覆盖 required/optional 输入，等待策略是否合法。
- 同一个 ArtifactSpec 是否存在未声明 merge/version 策略的多个 producer。
- required credential 是否声明。
- layout 是否引用存在节点。

输出：

```yaml
status: valid
errors: []
warnings:
  - D_tts_caption requires VOLC_TTS_API_KEY; no CredentialCheckResult exists yet
```

### dry-run

输入：

```bash
miracle dry-run content-production-v0.workflow.yaml --input topic="Codex updates"
```

输出：

- 预计节点执行顺序。
- 参与 Agent。
- 需要的组件库。
- 需要的 provider。
- 人工审核门。
- 可能阻塞项。

### estimate

输出：

- 预计耗时。
- 预计成本区间。
- 大文件产物。
- 高风险节点。
- fallback 路径。

凭证规则：

- CredentialSpec 只声明凭证契约，可进入 Git。
- dry-run 输出 CredentialCheckResult，属于本地运行事实。
- 真实执行前再次检查凭证，不复用过期检查结果。

## 15. NodeRun、NodeAttempt、AdapterResult 与幂等协议 v0

NodeRun 状态：

```text
not_started / queued / running / paused / blocked / reconciling /
cancelled / failed / skipped / done
```

NodeRun 是固定聚合实例；NodeAttempt 才是一次真实执行：

```yaml
node_run:
  node_run_id: run001_D_tts
  run_id: run_20260618_001
  node_id: D_tts_caption
  status: running
  current_attempt_id: tts_run001_D_attempt_2
  attempt_count: 2

node_attempt:
  attempt_id: tts_run001_D_attempt_2
  node_run_id: run001_D_tts
  operation_id: tts_run001_D_r1_sha256_storyboard222_real
  business_revision: 1
  input_fingerprint: sha256:storyboard222
  execution_mode: real-run
  status: succeeded
  provider: backup_tts
  resolved_inputs:
    approved_storyboard:
      artifact_id: storyboard_run001_v2
      hash: sha256:storyboard222
  artifact_ids: [audio_run001_v2]
```

NodeAttempt 终态：

```text
succeeded / failed / timed_out / cancelled / aborted / unknown
```

Adapter 不直接写 Event Journal 或投影，只返回结果 envelope：

```yaml
operation_id: tts_run001_D_r1_sha256_storyboard222_real
attempt_id: tts_run001_D_attempt_2
status: succeeded
provider_receipt: volc_request_92837
artifacts:
  - artifact_spec_id: tts_audio
    path: audio/final.wav
    hash: sha256:789
events:
  - event_type: provider_call_completed
failure: null
```

由 Orchestrator 统一接收并写入 Event Journal，再生成 NodeAttempt、NodeRun、
ArtifactManifest、GateInstance 等可重建投影。

幂等规则：

- 网络重试、provider fallback、核对确认未执行后的重试复用 `operation_id`。
- 审核返工、用户主动重跑、resolved input 变化或 preview 转 real-run 创建新
  `business_revision` 和新 `operation_id`。
- MVP 按 `node_run_id + business_revision + input_fingerprint + execution_mode`
  派生 operation ID，不新增 NodeOperation 持久化对象。
- `attempt_id` 表示一次真实执行尝试，每次重试都生成新 ID。
- 外部副作用节点必须保存 `provider_receipt`。
- 执行前按 operation_id 检查是否已有成功结果。
- 结果不明确时，NodeAttempt 以 `unknown` 终止，NodeRun 进入 `reconciling`。
- ReconciliationRecord 和 TraceEvent 追加核对结果，不覆盖 unknown Attempt。
- 只有核对为 `confirmed_not_executed` 时才允许创建新的副作用 Attempt。
- 节点必须区分 `dry-run / preview / real-run`。

暂停规则：

- 底层会话或进程可原地恢复时，复用当前 Attempt。
- 底层进程已终止、provider 重试、fallback、审核返工或重新执行时，新建 Attempt。

统一事件 envelope 使用通用 subject：

```yaml
event_id: evt_000108
sequence: 108
run_id: run_20260618_001
event_type: node_completed
event_category: runtime
subject:
  type: node_run
  id: run001_D_tts
actor:
  type: system
  id: orchestrator
timestamp: 2026-06-18T10:42:00+08:00
payload: {}
```

AuditEvent 是 `event_category: audit` 的受保护 TraceEvent 子类型。
`subject.type` 可取 `run / node_run / node_attempt / artifact / gate_instance /
credential / workflow / registry / local_service`。Registry 等 run 外事件允许
`run_id: null`，不得虚构 node ID。

## 16. Event Journal 与崩溃提交协议 v0

权威源与投影：

```text
Event Journal 是权威追加日志。
NodeRun / NodeAttempt / ArtifactManifest / GateInstance / Run 状态是可重建投影。
```

提交协议：

```text
allocate NodeAttempt identity and freeze inputs
-> append attempt_dispatched
-> call provider
-> append adapter_result_received
-> project ArtifactManifest / NodeAttempt / NodeRun
-> append adapter_result_committed
```

恢复规则：

- 每个 run 使用一个 append-only JSONL journal。
- sequence 由 Orchestrator 单写入器分配，按 run 全局递增。
- event_id 用于去重；重复 event_id 视为幂等成功。
- 重放投影严格按 sequence 处理。
- 不存在 dispatched 时，可以正常调度。
- 存在 dispatched 但不存在 received 时，进入 reconcile，不直接重试 provider。
- 存在 received 但不存在 committed 时，不重新调用 provider，只补齐投影并提交。
- committed 只表示 received 对应的全部投影已完成，不承载唯一业务结果。
- fsync、文件锁、分片和 SQLite 索引细节留到 P3。

事件示例：

```yaml
event_type: attempt_dispatched
run_id: run_20260618_001
operation_id: tts_run001_D_r1_sha256_storyboard222_real
attempt_id: tts_run001_D_attempt_2
subject:
  type: node_attempt
  id: tts_run001_D_attempt_2
payload:
  adapter_id: official_api
  provider: volc_tts
  execution_mode: real-run
  resolved_inputs:
    approved_storyboard:
      artifact_id: storyboard_run001_v2
      hash: sha256:storyboard222
```

```yaml
event_type: adapter_result_received
operation_id: tts_run001_D_r1_sha256_storyboard222_real
attempt_id: tts_run001_D_attempt_2
payload:
  status: succeeded
  adapter_id: official_api
  provider: volc_tts
  provider_receipt: volc_request_92837
  duration_ms: 80320
  cost:
    currency: CNY
    amount: 0.42
  artifacts:
    - artifact_id: audio_run001_v2
      artifact_spec_id: audio_manifest
      path: runs/run001/06_音频字幕/tts_run001_D_attempt_2/audio_manifest.json
      hash: sha256:audio222
    - artifact_id: captions_run001_v2
      artifact_spec_id: captions
      path: runs/run001/06_音频字幕/tts_run001_D_attempt_2/captions
      hash: sha256:captions222
  failure: null
  runtime_events:
    - event_type: provider_call_completed
```

```yaml
event_type: adapter_result_committed
operation_id: tts_run001_D_r1_sha256_storyboard222_real
attempt_id: tts_run001_D_attempt_2
payload:
  received_event_id: evt_adapter_result_received_001
```

`adapter_result_received.payload` 必须保存完整、可重建且已脱敏的 AdapterResult，
包括 adapter/provider、receipt、耗时、成本、全部 artifact descriptor、failure 和
runtime events；凭证、token、cookie 和私密输入不得进入 Journal。

投影使用稳定键 upsert：

| 投影 | 稳定键 |
|---|---|
| NodeAttempt | `attempt_id` |
| NodeRun | `node_run_id` |
| ArtifactManifest | `artifact_id` |
| GateInstance | `gate_instance_id` |
| GateDecision | `decision_id` |
| ReconciliationRecord | `reconciliation_id` |

同一稳定键且内容一致视为幂等成功，不增加 attempt_count、不重复创建 Manifest 或
GateInstance；同一稳定键内容冲突时进入 `projection_conflict`，停止自动提交。

## 17. Flow A-G 正式可校验样例

```yaml
schema_version: miracle.workflow.v0
id: content-production-v0
name: 热点工具更新内容生产全流程
version: 0.1.0
category: content_production
status: stable
nodes:
  - id: A_fact_intelligence
    name: 情报采集与事实核验
    type: agent
    agent_candidates: [intelligence-agent, verification-agent]
    recommended_libraries: [official-source-library, fact-verification-library]
    outputs:
      - artifact_spec_id: raw_items
      - artifact_spec_id: clean_events
  - id: B_md_master
    name: 内容 MD 母稿
    type: transform
    inputs:
      - name: clean_events_input
        artifact_spec_id: clean_events
        required: true
        selector:
          source_scope: edges
          run_scope: current
          status: approved
          strategy: latest_approved
    outputs:
      - artifact_spec_id: md_master
    review_gate: B_md_master_gate
  - id: C0_script_pool
    name: 脚本池生成与评审
    type: agent
    inputs:
      - name: approved_md_master
        artifact_spec_id: md_master
        required: true
        selector:
          source_scope: edges
          run_scope: current
          status: approved
          strategy: latest_approved
    outputs:
      - artifact_spec_id: selected_scripts
  - id: C_storyboard
    name: PPT 与视频分镜
    type: transform
    inputs:
      - name: selected_scripts_input
        artifact_spec_id: selected_scripts
        required: true
        selector:
          source_scope: edges
          run_scope: current
          status: approved
          strategy: latest_approved
    outputs:
      - artifact_spec_id: storyboard
    review_gate: C_storyboard_gate
  - id: D_tts_caption
    name: TTS 与字幕
    type: tool
    inputs:
      - name: approved_storyboard
        artifact_spec_id: storyboard
        required: true
        selector:
          source_scope: edges
          run_scope: current
          status: approved
          strategy: latest_approved
    outputs:
      - artifact_spec_id: audio_manifest
      - artifact_spec_id: captions
    review_gate: D_tts_gate
  - id: E_visual_video
    name: HyperFrames 视觉视频
    type: tool
    inputs:
      - name: approved_captions
        artifact_spec_id: captions
        required: true
        selector:
          source_scope: edges
          run_scope: current
          status: approved
          strategy: latest_approved
    outputs:
      - artifact_spec_id: hyperframes_project
  - id: F_final_render
    name: 最终渲染
    type: tool
    inputs:
      - name: hyperframes_project_input
        artifact_spec_id: hyperframes_project
        required: true
        selector:
          source_scope: edges
          run_scope: current
          strategy: latest
    outputs:
      - artifact_spec_id: render_manifest
      - artifact_spec_id: final_video
    review_gate: F_render_gate
  - id: G_distribution_retro
    name: 分发复盘
    type: transform
    join_policy:
      start_when: required_inputs_ready
      optional_inputs:
        wait_policy: wait_if_active
        max_wait: 30m
        on_terminal_without_artifact: continue_without_optional
        on_timeout: require_user_decision
    inputs:
      - name: approved_md_master
        artifact_spec_id: md_master
        required: true
        selector:
          source_scope: edges
          run_scope: current
          status: approved
          strategy: latest_approved
      - name: approved_final_video
        artifact_spec_id: final_video
        required: false
        selector:
          source_scope: edges
          run_scope: current
          status: approved
          strategy: latest_approved
    outputs:
      - artifact_spec_id: distribution_pack
      - artifact_spec_id: retro_report
edges:
  - id: edge_A_B
    from: A_fact_intelligence
    to: B_md_master
    passes_artifacts: [clean_events]
    required: true
  - id: edge_B_C0
    from: B_md_master
    to: C0_script_pool
    passes_artifacts: [md_master]
    required: true
  - id: edge_B_G
    from: B_md_master
    to: G_distribution_retro
    passes_artifacts: [md_master]
    required: true
  - id: edge_C0_C
    from: C0_script_pool
    to: C_storyboard
    passes_artifacts: [selected_scripts]
    required: true
  - id: edge_C_D
    from: C_storyboard
    to: D_tts_caption
    passes_artifacts: [storyboard]
    required: true
  - id: edge_D_E
    from: D_tts_caption
    to: E_visual_video
    passes_artifacts: [captions]
    required: true
  - id: edge_E_F
    from: E_visual_video
    to: F_final_render
    passes_artifacts: [hyperframes_project]
    required: true
  - id: edge_F_G
    from: F_final_render
    to: G_distribution_retro
    passes_artifacts: [final_video]
    required: false
gates:
  - id: B_md_master_gate
    node: B_md_master
    mode: manual
    allow_downstream_decisions: [approved, auto-approved]
    actions: [approve, reject, comment, block, skip]
    reject_to: B_md_master
    required_before: [C0_script_pool]
  - id: C_storyboard_gate
    node: C_storyboard
    mode: manual
    allow_downstream_decisions: [approved, auto-approved]
    actions: [approve, reject, comment, block, skip]
    reject_to: C_storyboard
    required_before: [D_tts_caption]
  - id: D_tts_gate
    node: D_tts_caption
    mode: manual
    allow_downstream_decisions: [approved, auto-approved]
    actions: [approve, reject, comment, block, skip]
    reject_to: D_tts_caption
    required_before: [E_visual_video]
  - id: F_render_gate
    node: F_final_render
    mode: manual
    allow_downstream_decisions: [approved, auto-approved]
    actions: [approve, reject, comment, block, skip]
    reject_to: F_final_render
artifacts:
  - id: raw_items
    kind: markdown
    path_template: runs/{run_id}/01_事实底稿/{artifact_version}/raw_items.md
    produced_by: A_fact_intelligence
    consumed_by: []
    review_policy:
      mode: none
  - id: clean_events
    kind: markdown
    path_template: runs/{run_id}/02_事实核验/{artifact_version}/clean_events.md
    produced_by: A_fact_intelligence
    consumed_by: [B_md_master]
    review_policy:
      mode: auto
      validators: [file_exists, schema_valid, sources_present]
      on_pass: approved
      on_fail: rejected
  - id: md_master
    kind: markdown
    path_template: runs/{run_id}/03_内容母稿/{artifact_version}/MD母稿.md
    produced_by: B_md_master
    consumed_by: [C0_script_pool, G_distribution_retro]
    review_policy:
      mode: manual
      gate_id: B_md_master_gate
  - id: selected_scripts
    kind: directory
    path_template: runs/{run_id}/04_脚本池/{artifact_version}
    produced_by: C0_script_pool
    consumed_by: [C_storyboard]
    review_policy:
      mode: auto
      validators: [file_exists, schema_valid]
      on_pass: approved
      on_fail: rejected
  - id: storyboard
    kind: markdown
    path_template: runs/{run_id}/05_分镜/{artifact_version}/storyboard.md
    produced_by: C_storyboard
    consumed_by: [D_tts_caption]
    review_policy:
      mode: manual
      gate_id: C_storyboard_gate
  - id: audio_manifest
    kind: json
    path_template: runs/{run_id}/06_音频字幕/{attempt_id}/audio_manifest.json
    produced_by: D_tts_caption
    consumed_by: [E_visual_video]
    review_policy:
      mode: manual
      gate_id: D_tts_gate
  - id: captions
    kind: directory
    path_template: runs/{run_id}/06_音频字幕/{attempt_id}/captions
    produced_by: D_tts_caption
    consumed_by: [E_visual_video]
    review_policy:
      mode: manual
      gate_id: D_tts_gate
  - id: hyperframes_project
    kind: directory
    path_template: runs/{run_id}/07_视频工程/{attempt_id}
    produced_by: E_visual_video
    consumed_by: [F_final_render]
    review_policy:
      mode: none
  - id: render_manifest
    kind: json
    path_template: runs/{run_id}/08_最终渲染/{attempt_id}/render_manifest.json
    produced_by: F_final_render
    consumed_by: [G_distribution_retro]
    review_policy:
      mode: manual
      gate_id: F_render_gate
  - id: final_video
    kind: external_media
    path_template: runs/{run_id}/08_最终渲染/{attempt_id}/final_video.mp4
    produced_by: F_final_render
    consumed_by: [G_distribution_retro]
    review_policy:
      mode: manual
      gate_id: F_render_gate
  - id: distribution_pack
    kind: markdown
    path_template: runs/{run_id}/09_分发/{artifact_version}/distribution_pack.md
    produced_by: G_distribution_retro
    consumed_by: []
    review_policy:
      mode: none
  - id: retro_report
    kind: markdown
    path_template: runs/{run_id}/10_复盘/{artifact_version}/retro_report.md
    produced_by: G_distribution_retro
    consumed_by: []
    review_policy:
      mode: none
provider_policy:
  default_runtime_adapter: codex
  allowed_runtime_adapters: [codex, hermes, openclaw, claude_code, official_api]
  node_overrides:
    D_tts_caption:
      runtime_adapter: official_api
      provider: volc-tts
      fallback_order: [macos_say_preview]
layouts:
  dag: {}
  canvas: {}
```

该样例是后续 schema、validate 和 importer 的首个正式验收样本。示例中的每个 input、
output、gate、producer、consumer 和 passes_artifacts 都必须通过引用完整性检查。

## 18. Pencil 节点插入样例

在 MD 母稿前插入 Pencil 原型节点：

```yaml
nodes:
  - id: prototype_pencil_before_md
    name: MD 前置 Pencil 原型
    type: mcp_tool
    recommended_libraries: [pencil-prototype-library]
    capability_requirements: [prototype.pencil, content.structure_design]
    inputs:
      - artifact_spec_id: clean_events
        required: true
      - artifact_spec_id: topic_strategy
        required: true
    outputs:
      - artifact_spec_id: content_structure_prototype
      - artifact_spec_id: visual_layout_snapshot
edges:
  - from: A_fact_intelligence
    to: prototype_pencil_before_md
  - from: prototype_pencil_before_md
    to: B_md_master
```

## 19. TTS blocked 样例

```yaml
node_run:
  node_run_id: run001_D_tts
  node_id: D_tts_caption
  status: blocked
  current_attempt_id: null
  attempt_count: 0
  blocked_reason: missing_tts_credentials
  missing_credentials: [VOLC_TTS_API_KEY]
  recovery_actions:
    - 配置 VOLC_TTS_API_KEY
    - 切换备用 TTS provider
    - 跳过 TTS，仅生成无配音审看版
```

## 20. MVP 边界

MVP 必做：

- WorkflowSpec YAML v0。
- 本地 Registry v0。
- validate / dry-run / estimate 文档契约。
- Flow A-G 导入样例。

暂不做：

- 真实 CLI。
- 云端模板市场。
- 多用户权限。
- 自动迁移旧 run。
