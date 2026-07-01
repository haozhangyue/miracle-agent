# 23_P3MVP任务拆解与验收计划

> 文档状态：P3 MVP 实施拆解。
>
> 目标：把 P3 设计转成可进入工程实现的任务、验收标准和测试场景。

## 1. MVP 总边界

MVP 做：

1. 本地 Web + Node.js Local Sidecar。
2. 本地文件读写。
3. WorkflowSpec/DomainPack/Registry 的本地加载。
4. Validate / Dry-run。
5. 静态或手动 Run Trace 展示。
6. 首页、Run、Attention、Agent Collaboration、审核抽屉的核心链路。
7. 用 `content-production-v0` 验证第一条样本。
8. 用 `image-generation`、`script-writing`、`research-analysis` 验证模型可扩展。

MVP 不做：

1. 真实后台调度器。
2. 多租户、账号、计费。
3. 云同步。
4. 完整商业化后端。
5. 所有 Runtime Adapter 的真实执行。
6. 移动端 / APP。

## 2. 实施阶段

```text
P3D-01 文档与模型基线
-> P3D-02 本地数据与 Sidecar API
-> P3D-03 前端工作台核心页面
-> P3D-04 Validate / Dry-run / Attention 投影
-> P3D-05 Agent Collaboration / Artifact / Gate Review
-> P3D-06 MVP 验收与 P4 实现准备
```

## 3. 任务拆解

### MVPS01 WorkflowSpec YAML v0

目标：

让工作流可版本化、可 diff、可进入 Git。

实现任务：

| ID | 任务 | 验收 |
|---|---|---|
| MVPS01-01 | 定义 WorkflowSpec YAML 文件结构 | 包含 id、domain、version、nodes、edges、gates、artifacts、provider_policy、layouts。 |
| MVPS01-02 | 定义 NodeSpec 通用字段 | 不出现 Flow A-G 专属字段。 |
| MVPS01-03 | 定义 DomainPack、RoleProfile、WorkflowTemplate 文件结构 | 能描述内容生产、生图、研究三个领域。 |
| MVPS01-04 | 定义本地 registry 目录约定 | 能列出 builtin/local_project/local_registry 模板。 |

### MVPS02 Flow A-G Importer

目标：

用现有“热点工具更新”验证真实流程导入，但不把它写死。

实现任务：

| ID | 任务 | 验收 |
|---|---|---|
| MVPS02-01 | 抽取 `content-production-v0` 模板 | Flow A-G 作为模板标签和 layout 分组存在。 |
| MVPS02-02 | 生成 WorkflowSpec 样例 | 通过引用完整性检查。 |
| MVPS02-03 | 生成 AgentSpec 和 ComponentLibrary 样例 | Agent 装备组件库，不直接绑定单工具。 |
| MVPS02-04 | 补充非内容生产样例 | 至少包含 image-generation、research-analysis、script-writing。 |

### MVPS03 Validate / Dry-run

目标：

启动前发现凭证、审核门、provider、成本和风险。

实现任务：

| ID | 任务 | 验收 |
|---|---|---|
| MVPS03-01 | 实现 Spec 引用校验设计 | 检查 node、edge、artifact、gate、provider 引用。 |
| MVPS03-02 | 实现 CredentialCheckResult 设计 | 缺凭证返回 blocked 风险和恢复动作。 |
| MVPS03-03 | 实现 DryRunPlan 输出结构 | 输出执行计划、风险、成本区间、审核门。 |
| MVPS03-04 | 验证可选分支影响 | EdgeSpec 必须表达 `required`、`join_policy.wait_if_active`、`max_wait`、`on_timeout` 和 `on_no_qualified_artifact`，跳过 optional branch 不影响 required 主链路。 |
| MVPS03-05 | 定义启动 Run 协议 | `POST /runs` 创建 RunSpec、冻结 WorkflowSnapshot、生成初始 NodeRun 并写入 `run_created`。 |

### MVPS04 Node DAG View

目标：

先保证严谨执行链路可见。

实现任务：

| ID | 任务 | 验收 |
|---|---|---|
| MVPS04-01 | 定义 DAG 数据投影 | 从 RunSpec + WorkflowSnapshot + NodeRun 生成节点和边。 |
| MVPS04-02 | 定义阶段过滤器 | 来自 layout，不参与执行依赖。 |
| MVPS04-03 | 定义 NodeRun 状态展示 | NodeRun、NodeAttempt、GateInstance、ArtifactManifest 状态归属明确。 |
| MVPS04-04 | 定义节点详情面板 | 显示输入、输出、Agent、Provider、Attempt、恢复动作。 |

### MVPS05 Agent Collaboration View

目标：

展示 Agent 健康、等待、阻塞、交接。

实现任务：

| ID | 任务 | 验收 |
|---|---|---|
| MVPS05-01 | 定义 AgentHealthProjection | 支持 active_runs、current_node_runs、queued_node_runs。 |
| MVPS05-02 | 定义 HandoffContract | 交接必须绑定 Artifact 或 Gate。 |
| MVPS05-03 | 定义 Collaboration Links | 能表达上游、下游、等待对象和阻塞传播。 |
| MVPS05-04 | 映射 P2F-07 页面数据 | 当前 Agent Collaboration 原型每个区块都有数据来源。 |

### MVPS06 Artifact Board

目标：

管理内容、音频、视频、分发和其他业务产物。

实现任务：

| ID | 任务 | 验收 |
|---|---|---|
| MVPS06-01 | 定义 ArtifactType registry | 支持 markdown、image、video、audio、dataset、prototype、report。 |
| MVPS06-02 | 定义 ArtifactManifest | 包含 version、path、hash、status、review_status、producer。 |
| MVPS06-03 | 定义 Artifact preview 策略 | 不同类型使用不同预览方式。 |
| MVPS06-04 | 定义版本规则 | 审核返工创建新版本，不覆盖旧版本。 |

### MVPS07 Gate Review UI

目标：

支持批准、驳回、评论、阻塞和返工。

实现任务：

| ID | 任务 | 验收 |
|---|---|---|
| MVPS07-01 | 定义 GateInstance 和 GateDecision 接口 | pending_review 属于 GateInstance，不属于 GateDecision。 |
| MVPS07-02 | 定义审核抽屉数据结构 | 显示 artifact version/hash、证据、下游影响。 |
| MVPS07-03 | 定义驳回后续动作 | 创建 rework attempt 或新 Artifact version。 |
| MVPS07-04 | 定义审计事件 | 每次 decision 生成事件。 |

### MVPS08 Infinite Canvas Prototype

目标：

用空间方式组织内容、素材、产物、分支。

实现任务：

| ID | 任务 | 验收 |
|---|---|---|
| MVPS08-01 | 定义 CanvasLayout | layout 不参与执行依赖。 |
| MVPS08-02 | 定义画布对象类型 | task、agent、artifact、node、zone、version_branch。 |
| MVPS08-03 | 定义画布对象到 Spec 的发布规则 | 从草稿对象生成 Workflow draft。 |
| MVPS08-04 | 定义与 DAG 同步规则 | 同一 graph，不保存两套流程。 |

### MVPS09 Visual/Spec Sync

目标：

让 UI 和 YAML/JSON 保持一致。

实现任务：

| ID | 任务 | 验收 |
|---|---|---|
| MVPS09-01 | 定义 spec diff 格式 | UI 操作生成 diff。 |
| MVPS09-02 | 定义 file watcher 输入 | 文件变更反映回 UI。 |
| MVPS09-03 | 定义冲突策略 | stable 工作流不自动覆盖。 |
| MVPS09-04 | 定义 validate-before-save | 保存前运行引用完整性检查。 |

### MVPS10 Evolution Board v0

目标：

把失败、返工、重复修改变成进化建议。

实现任务：

| ID | 任务 | 验收 |
|---|---|---|
| MVPS10-01 | 定义 RetroSignal | 来源包括失败、返工、用户审核意见、成本、耗时。 |
| MVPS10-02 | 定义 EvolutionCandidate | 新节点、新组件库、provider fallback、prompt 改写。 |
| MVPS10-03 | 定义 sandbox 验证状态 | draft、evaluating、approved、rejected。 |
| MVPS10-04 | 定义发布策略 | 用户批准后发布新版 WorkflowSpec 或 ComponentLibrary。 |

## 4. 后端与本地服务任务

| ID | 任务 | 验收 |
|---|---|---|
| SIDE-01 | 定义 Local Sidecar API contract | 与 `21` 中 API 对齐。 |
| SIDE-02 | 定义 workspace handle 和路径边界 | UI 不拿任意绝对路径。 |
| SIDE-03 | 定义本地 `.miracle/` 目录 | domains、registry、workflows、runs、artifacts。 |
| SIDE-04 | 定义 Event Journal 追加规则 | Run 事件只追加，不覆盖。 |
| SIDE-05 | 定义 Adapter Contract | CLI、HTTP/API、MCP 共享输入输出结构。 |
| SIDE-06 | 定义安全检查 | localhost、session token、Origin/CSRF、短时确认票据。 |

## 5. 前端任务

| ID | 页面 | 验收 |
|---|---|---|
| UI-01 | AppShell | 支持 workspace、role、domain、系统健康。 |
| UI-02 | 首页 | 待处理、继续运行、快速启动、最近交付可由 API 驱动。 |
| UI-03 | 新任务/Dry-run | 工作流选择方式和执行策略分离。 |
| UI-04 | Run 工作区 | Run header、阶段过滤、节点详情、事件抽屉可由数据驱动。 |
| UI-05 | Attention | 根因聚合、关联对象、安全动作、生命周期可展示。 |
| UI-06 | Agent Collaboration | AgentHealth、交接合同、阻塞传播可展示。 |
| UI-07 | Gate Review | 审核决策保留历史，只更新 artifact review_status，不覆盖产物内容或版本。 |
| UI-08 | Artifact Board | 按类型、运行、状态查看产物。 |

## 6. 扩展性验收场景

### 6.1 内容生产

```text
采集 -> 清洗 -> 母稿 -> 脚本 -> 分镜 -> TTS -> 视频 -> 分发 -> 复盘
```

验收：

1. 能表达 required 和 optional 分支。
2. 能表达 `wait_if_active`、`max_wait`、`on_timeout` 和 `on_no_qualified_artifact`。
3. TTS 缺凭证能生成 NodeRun blocked 和 AttentionItem。
4. Markdown 分发不受视频 optional 分支影响。

### 6.2 生图

```text
需求输入 -> Prompt 策划 -> 图像生成 -> 审核 -> 放大/变体 -> 交付
```

验收：

1. ArtifactType 支持 prompt、image、review_note。
2. ProviderPolicy 支持 image provider fallback。
3. 审核驳回生成新 image version。

### 6.3 AI 剧本

```text
主题 -> 人设 -> 大纲 -> 分集剧本 -> 审核 -> 分镜
```

验收：

1. ArtifactType 支持 character_sheet、outline、episode_script、storyboard。
2. 子工作流可表达分集并行。
3. reviewer 角色默认看到待审核脚本。

### 6.4 研究分析

```text
问题定义 -> 资料采集 -> 事实核验 -> 分析报告 -> 引用审计
```

验收：

1. ArtifactType 支持 dataset、evidence_table、report、citation。
2. Attention 能表达引用冲突。
3. Gate Review 能阻止证据不足的报告进入交付。

### 6.5 岗位视角

验收：

| 角色 | 必须可见 |
|---|---|
| 运营 | 任务、发布、风险、恢复动作。 |
| 编辑 | 稿件、审核、返工、证据。 |
| 设计师 | Prompt、视觉资产、变体、版本。 |
| 研究员 | 资料、引用、证据链、报告。 |
| 管理者 | 成本、进度、风险、吞吐。 |

## 7. 测试计划

文档测试：

```bash
rg "有条件通[过]|P2 修订收[口]|先完成 P2 修[订]" README.md 07_后续对接路线图与任务拆解.md 17_文档资产关联与AI阅读导航.md 18_P2原型评审纪要与修订清单.md VERSION_HISTORY.md
rg "最终商业后端|Flow A-G" 19_P3技术详细设计总纲与扩展性原则.md 20_P3核心数据模型与领域扩展设计.md 21_P3本地服务API与后端演进设计.md 22_P3前端架构与工作台状态设计.md 23_P3MVP任务拆解与验收计划.md
```

模型测试：

1. `content-production-v0` 可表达。
2. `image-generation-v0` 可表达。
3. `research-report-v0` 可表达。
4. `drama-script-v0` 可表达。
5. RoleProfile 能改变默认投影，但不改变运行事实。

API 测试：

1. 每个页面有明确 API。
2. 每个写动作有 receipt 或 event。
3. 每个错误有 code、object、recoverable、suggested_actions。
4. Local Sidecar 与 Cloud Control Plane 职责不混淆。

## 8. P4 入口条件

进入 P4 MVP 实现前必须满足：

1. `19-23` 文档完成并通过一致性检查。
2. README、17、07、VERSION_HISTORY 已同步。
3. P2 原型结论为完全通过。
4. Local Sidecar 和商业化后端演进边界明确。
5. Flow A-G 明确只是样本，不是核心模型边界。
6. MVPS01-MVPS10 有任务、验收和暂不做事项。
7. Run 启动、Gate Detail、AdapterResult、EdgeSpec join_policy 和 Orchestrator 单写入边界已收口。
