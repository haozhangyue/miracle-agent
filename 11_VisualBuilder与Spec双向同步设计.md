# 11_VisualBuilder 与 Spec 双向同步设计

## 1. 目标

Miracle 必须避免“UI 一套、配置文件一套”的割裂。无限画布、流程节点视图、YAML/JSON 配置、未来 CLI/SDK 都应编辑同一份 spec。

核心原则：

```text
WorkflowSpec / AgentSpec / ComponentSpec 是可版本化配置真相
Visual Builder 是编辑器
YAML/JSON 文件是编辑器
CLI/SDK 也是编辑器
RunSpec snapshot / NodeRun / TraceEvent / ArtifactManifest / GateDecision /
CredentialCheckResult 是运行事实真相
```

## 2. 同步对象

| 对象 | 来源 | 同步到 |
|---|---|---|
| WorkflowSpec | YAML / UI / Registry | DAG、Canvas、dry-run |
| NodeSpec | DAG / Canvas / YAML | 节点卡、画布卡、执行计划 |
| AgentSpec | Agent 面板 / YAML | Agent Dashboard、PermissionMatrix |
| ComponentSpec | Registry / YAML | 组件装备面板 |
| ArtifactSpec | 节点输出 / YAML | 模板产物占位、节点输出契约 |
| ArtifactManifest | NodeRun / Run Store | 运行态 Artifact Board、真实产物卡 |
| LayoutSpec | Canvas / DAG | UI 布局 |

## 3. 无限画布对象

| 对象 | 是否进入执行 | 对应 spec |
|---|---|---|
| 任务卡 | 可选 | NodeSpec |
| Agent 卡 | 是 | 模板态绑定 AgentSpec；运行态绑定 AgentHealth / AgentRun |
| 素材卡 | 可选 | 模板态绑定 ArtifactSpec / SourceSpec；运行态绑定 ArtifactManifest |
| 产物卡 | 是 | 模板态绑定 ArtifactSpec；运行态绑定 ArtifactManifest |
| 节点卡 | 是 | NodeSpec |
| 区域 | 否 | CanvasLayout |
| 版本分支 | 可选 | WorkflowSpec variant |
| 灵感卡 | 否 | CanvasNote |

规则：

- 非执行对象可只存在于 `layouts.canvas.notes`。
- 一旦对象转为节点，必须生成 NodeSpec。
- 模板编辑中的产物占位卡绑定 ArtifactSpec。
- 运行态产物卡必须绑定 ArtifactManifest，并反向显示 ArtifactSpec。
- Agent 卡如果参与执行，必须绑定 AgentSpec 或 AgentRun。

## 4. 从 UI 到 Spec

### 4.1 DAG 新增节点

用户在流程节点视图新增节点：

1. 创建 NodeSpec。
2. 创建或更新 EdgeSpec。
3. 如果有输出，创建 ArtifactSpec。
4. 在 CanvasLayout 中生成默认节点卡。
5. 生成 spec diff。

输出 diff 示例：

```yaml
added:
  nodes:
    - id: prototype_pencil_before_md
  edges:
    - from: A_fact_intelligence
      to: prototype_pencil_before_md
    - from: prototype_pencil_before_md
      to: B_md_master
```

### 4.2 Canvas 任务卡转节点

用户把灵感卡“先做 Pencil 原型”转成节点：

1. 系统要求补齐输入、输出、能力需求、组件库、Agent、插入位置。
2. 创建 NodeSpec。
3. 替换原画布卡类型为 `node_card`。
4. 更新 DAG。
5. 进入 dry-run 检查。

### 4.3 Artifact Board 绑定产物

模板设计态新增预期产物：

1. 创建 ArtifactSpec。
2. 绑定 `produced_by`、`consumed_by` 和 `path_template`。
3. 只显示占位，不伪造真实文件路径或审核状态。

运行态把文件或外部结果接入产物板：

1. 创建 ArtifactManifest，并绑定 `run_id`、`node_run_id` 和 `artifact_spec_id`。
2. 记录真实路径或外部链接、hash、source_event_id 和状态。
3. 外部参考标记 `external_only`。
4. 未绑定 ArtifactSpec 的实例不得直接进入自动下游，必须先人工映射。

## 5. 从 Spec 到 UI

文件变更后：

1. 解析 YAML/JSON。
2. validate。
3. 计算 spec diff。
4. 更新 DAG。
5. 更新 Canvas。
6. 更新模板产物占位；真实 run 的 Artifact Board 不因模板文件修改而重写。
7. 如果 layout 缺失，生成默认布局。

示例：

```text
用户在 YAML 增加 D_tts_caption.credential_required
-> Provider 面板显示缺凭证
-> Dry-run 标记 D 节点可能 blocked
-> Canvas 中 TTS 节点显示风险徽标
```

## 6. 冲突处理

冲突来源：

- UI 正在编辑，文件也被外部修改。
- 本地模板和 Registry 远端模板版本不同。
- stable 模板被 UI 直接修改。
- Canvas 删除节点卡但 YAML 仍有 NodeSpec。

处理策略：

| 冲突 | 处理 |
|---|---|
| UI 和文件同时改同一字段 | 显示 diff，让用户选择保留 UI / 文件 / 手动合并。 |
| stable 模板被直接修改 | 默认创建 local override，不覆盖 stable。 |
| Registry 有新版本 | 显示 changelog 和 breaking changes。 |
| layout 引用不存在节点 | validate warning，允许自动清理 layout。 |
| edge 引用不存在节点 | validate error，禁止运行。 |

## 7. Spec Diff

所有 UI 操作都应生成可读 diff。

```yaml
change_id: chg_20260617_001
source: visual_builder
actor: user
changes:
  - op: add_node
    node_id: prototype_pencil_before_md
  - op: add_edge
    from: A_fact_intelligence
    to: prototype_pencil_before_md
  - op: add_edge
    from: prototype_pencil_before_md
    to: B_md_master
impact:
  requires_dry_run: true
  affects_stable_workflow: false
```

## 8. 发布为模板

画布对象和工作流可以发布为模板，但必须满足：

- validate 通过。
- 没有本地绝对路径泄露。
- 没有密钥。
- 产物路径使用模板变量。
- 状态为 `draft` 或 `experimental`，不能直接发布为 stable。

发布流程：

```text
local override -> experimental template -> dry-run/sample run -> user approval -> stable template
```

## 9. Dry-run 预览

流程节点模式必须提供 dry-run 预览：

- 节点执行顺序。
- 参与 Agent。
- 需要 provider。
- 缺失凭证。
- 审核门。
- 预估风险。
- 可能生成的大文件。

Canvas 模式也要显示 dry-run 结果，但以风险徽标和任务区摘要呈现。

## 10. 示例：YAML 新增 Pencil 节点

```yaml
nodes:
  - id: prototype_pencil_before_md
    type: mcp_tool
    recommended_libraries: [pencil-prototype-library]
edges:
  - from: A_fact_intelligence
    to: prototype_pencil_before_md
  - from: prototype_pencil_before_md
    to: B_md_master
```

同步结果：

- DAG 中 A 和 B 之间出现 Pencil 节点。
- Canvas 的“原型区”出现 Pencil 节点卡。
- 模板视图预生成 `content_structure_prototype` ArtifactSpec 占位。
- 真实执行后，运行视图显示对应 ArtifactManifest 实例。
- Dry-run 标记需要 Pencil MCP。

## 11. MVP 边界

MVP 必做：

- UI 操作落成 spec diff 的规则。
- 文件变更回写 UI 的规则。
- Canvas 与 DAG layout 分离。
- ArtifactSpec 与 ArtifactManifest 分层绑定规则。
- 冲突处理策略文档。

暂不做：

- 真实多人协同冲突解决。
- 图形化 diff 工具。
- 云端模板市场。
- SDK 自动生成。
