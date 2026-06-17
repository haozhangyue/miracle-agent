# 09_WorkflowSpec 与 Registry 技术草案

## 1. 目标

本文件把 Miracle 的工作流从“概念规划”推进到可版本化、可校验、可 dry-run、可导入真实项目的 `WorkflowSpec YAML v0`。

设计原则：

- Spec 是唯一真相，UI、CLI、SDK 都只是编辑器。
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
  - id: clean_events
    kind: artifact
    required: true
  - id: topic_strategy
    kind: artifact
    required: true
outputs:
  - id: md_master_draft
    kind: markdown
  - id: md_master_approved
    kind: markdown
review_gate: B_md_master_gate
failure_policy:
  retry: 1
  on_missing_input: blocked
  on_tool_failure: failed
  on_quality_reject: rejected
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
  condition: status in ["approved", "auto-approved"]
  passes_artifacts:
    - clean_events
    - topic_strategy
```

规则：

- `edges` 是唯一执行依赖来源。
- 布局位置、画布分组、卡片距离不影响执行顺序。
- 条件分支必须写明 `condition`，不能隐藏在节点 prompt 中。

## 5. GateSpec v0

```yaml
id: B_md_master_gate
node: B_md_master
mode: manual
reviewer: user
allow_downstream_statuses: [approved, auto-approved]
decisions: [approve, reject, comment, block]
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

## 6. ArtifactSpec v0

```yaml
id: md_master_approved
name: MD 母稿已审核版
kind: markdown
path_template: runs/{run_id}/03_内容母稿/MD母稿_已审核.md
produced_by: B_md_master
consumed_by: [C0_script_pool, G_distribution_retro]
review_required: true
status_source: B_md_master_gate
```

产物原则：

- 产物必须知道来源节点和下游消费者。
- 大文件只记录路径或外部链接，不强行进入 Git。
- 产物卡与 ArtifactSpec 严格绑定，避免画布上出现不可追踪素材。

## 7. ProviderPolicy v0

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

## 8. LayoutSpec v0

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

## 9. WorkflowRegistry v0

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

## 10. Validate / Dry-run / Estimate

### validate

输入：

```bash
miracle validate content-production-v0.workflow.yaml
```

检查：

- YAML 结构是否完整。
- 节点 ID 是否唯一。
- edge 是否指向存在节点。
- gate 是否绑定存在节点。
- artifact 是否有 producer。
- required credential 是否声明。
- layout 是否引用存在节点。

输出：

```yaml
status: valid
errors: []
warnings:
  - D_tts_caption requires VOLC_TTS_API_KEY but current environment is unchecked
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

## 11. Flow A-G 导入样例

```yaml
id: content-production-v0
nodes:
  - id: A_fact_intelligence
    name: 情报采集与事实核验
    type: agent
    agent_candidates: [intelligence-agent, verification-agent]
    recommended_libraries: [official-source-library, fact-verification-library]
    outputs:
      - id: raw_items
        kind: markdown
      - id: clean_events
        kind: markdown
  - id: B_md_master
    name: 内容 MD 母稿
    type: transform
    inputs:
      - id: clean_events
        kind: artifact
        required: true
    outputs:
      - id: md_master_draft
        kind: markdown
      - id: md_master_approved
        kind: markdown
    review_gate: B_md_master_gate
  - id: C0_script_pool
    name: 脚本池生成与评审
    type: agent
    inputs:
      - id: md_master_approved
        kind: artifact
        required: true
    outputs:
      - id: selected_scripts
        kind: directory
  - id: C_storyboard
    name: PPT 与视频分镜
    type: transform
    inputs:
      - id: selected_scripts
        kind: artifact
        required: true
    outputs:
      - id: storyboard_draft
        kind: markdown
    review_gate: C_storyboard_gate
  - id: D_tts_caption
    name: TTS 与字幕
    type: tool
    inputs:
      - id: storyboard_draft
        kind: artifact
        required: true
    outputs:
      - id: audio_manifest
        kind: json
      - id: captions
        kind: directory
    review_gate: D_tts_gate
  - id: E_visual_video
    name: HyperFrames 视觉视频
    type: tool
    inputs:
      - id: captions
        kind: artifact
        required: true
    outputs:
      - id: hyperframes_project
        kind: directory
  - id: F_final_render
    name: 最终渲染
    type: tool
    inputs:
      - id: hyperframes_project
        kind: artifact
        required: true
    outputs:
      - id: render_manifest
        kind: json
      - id: final_video
        kind: external_media
    review_gate: F_render_gate
  - id: G_distribution_retro
    name: 分发复盘
    type: transform
    inputs:
      - id: md_master_approved
        kind: artifact
        required: true
      - id: final_video
        kind: artifact
        required: false
    outputs:
      - id: distribution_pack
        kind: markdown
      - id: retro_report
        kind: markdown
edges:
  - from: A_fact_intelligence
    to: B_md_master
  - from: B_md_master
    to: C0_script_pool
  - from: C0_script_pool
    to: C_storyboard
  - from: C_storyboard
    to: D_tts_caption
  - from: D_tts_caption
    to: E_visual_video
  - from: E_visual_video
    to: F_final_render
  - from: F_final_render
    to: G_distribution_retro
```

## 12. Pencil 节点插入样例

在 MD 母稿前插入 Pencil 原型节点：

```yaml
nodes:
  - id: prototype_pencil_before_md
    name: MD 前置 Pencil 原型
    type: mcp_tool
    recommended_libraries: [pencil-prototype-library]
    capability_requirements: [prototype.pencil, content.structure_design]
    inputs:
      - id: clean_events
        kind: artifact
        required: true
      - id: topic_strategy
        kind: artifact
        required: true
    outputs:
      - id: content_structure_prototype
        kind: document
      - id: visual_layout_snapshot
        kind: image
edges:
  - from: A_fact_intelligence
    to: prototype_pencil_before_md
  - from: prototype_pencil_before_md
    to: B_md_master
```

## 13. TTS blocked 样例

```yaml
node_run:
  node_id: D_tts_caption
  status: blocked
  blocked_reason: missing_tts_credentials
  missing_credentials: [VOLC_TTS_API_KEY]
  recovery_actions:
    - 配置 VOLC_TTS_API_KEY
    - 切换备用 TTS provider
    - 跳过 TTS，仅生成无配音审看版
```

## 14. MVP 边界

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
