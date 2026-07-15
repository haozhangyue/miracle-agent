# Miracle 系统版本演进记录

> 本文件是 Miracle 项目的统一版本历史。它记录系统在规划、架构、产品和实现阶段的
> 主要演进，不替代 Git commit，而是把分散提交归并为可理解、可追踪的大版本。

## 1. 当前版本

| 项目 | 当前值 |
|---|---|
| 当前大版本 | `v0.7.0` |
| 版本名称 | P4 MVP 本地闭环验收基线 |
| 当前阶段 | P6-04 至 P6-06 已完成；运行版本仍为 v0.7.0，当前任务为 `P6-07` C_md_master 单节点真实执行 |
| 基线提交 | `1bd740f` |
| 基线日期 | 2026-06-18 |
| 最终评审 | 通过 |

## 2. 版本维护规则

### 2.1 版本号

采用语义化版本：

```text
主版本.次版本.修订版本
```

| 变更类型 | 版本规则 | 示例 |
|---|---|---|
| 系统定位、核心架构或兼容性发生根本变化 | 升级主版本 | `v0.x -> v1.0.0` |
| 新增一个完整阶段、模块或重要能力 | 升级次版本 | `v0.5.0 -> v0.6.0` |
| 不改变整体架构的修正、补充和一致性调整 | 升级修订版本 | `v0.5.0 -> v0.5.1` |

在进入可运行 MVP 前保持 `v0.x`；首个可安装、可运行、可验收的 MVP 发布为
`v1.0.0`。

### 2.2 每次版本记录必须包含

1. 版本号、版本名称、日期和对应 Git 提交区间。
2. 新增、更新、删除文件数量。
3. 变更摘要。
4. 按模块说明详细更新内容。
5. 兼容性、迁移或风险说明。
6. 验证结果。
7. 是否构成里程碑。

文件数量按该版本相对上一版本基线的 Git diff 统计；同一文件在版本内被多次提交，
最终只统计一次。

### 2.3 里程碑判定

出现以下任一情况时，必须新增里程碑：

- 系统定位或目标用户发生重要变化。
- 核心对象模型、执行协议或数据真相来源定型。
- 完成一个正式评审阶段并允许进入下一阶段。
- 交付首个可操作原型、首个真实 runner 或首个可发布版本。
- 发生需要迁移已有数据、Spec 或工作流的非兼容升级。

## 3. 版本总览

| 版本 | 日期 | 版本名称 | 新增 | 更新 | 删除 | 里程碑 |
|---|---|---|---:|---:|---:|---|
| `v0.1.0` | 2026-06-16 | 系统规划初版 | 9 | 0 | 0 | M1 项目规划基线 |
| `v0.2.0` | 2026-06-17 | Spec 优先技术规划 | 5 | 6 | 0 | M2 Spec-first 路线确立 |
| `v0.3.0` | 2026-06-17 | P0 评审与技术架构选型 | 7 | 3 | 0 | M3 技术架构基线 |
| `v0.4.0` | 2026-06-18 | 运行模型与执行协议收口 | 3 | 18 | 0 | M4 运行模型定型 |
| `v0.5.0` | 2026-06-18 | 架构最终评审基线 | 7 | 13 | 0 | M5 架构评审通过 |
| `v0.5.1` | 2026-06-18 | 版本演进记录机制 | 1 | 1 | 0 | - |
| `v0.7.0` | 2026-07-02 | P4 MVP 本地闭环验收基线 | 待统计 | 待统计 | 0 | M6 本地 MVP 验收通过 |

## 4. v0.7.0 发布记录

**版本：** `v0.7.0`
**发布日期：** 2026-07-02
**相对基线：** `1bd740f`
**当前文件变化：** 以最终 Git diff 统计为准。

### 变更摘要

- 新增 P2 第一版产品信息架构方案。
- 新增对象域与任务域 A/B 对照方案。
- 形成融合产品方案：任务型首页、Attention Queue、Run 工作区、Agent 一级入口和
  独立 Workflow 编辑态。
- 完成融合方案产品评审整改：拆分工作流选择与执行策略、移除 MVP Run patch、统一
  状态归属、补充 Attention 生命周期、明确工作流/资源库所有权和动态阶段过滤器。
- 将第一轮原型缩减为 6 个核心界面，并把 Agent Collaboration 作为独立测试。
- 明确跨 Run Agent 并发为 P2 展示需求，具体身份和容量协议延后到 P3。
- 新增文档资产关联图、有效性分级和 AI 最小读取路径。
- README 和路线图同步进入融合方案的 P2 原型阶段。
- 新增 P2 双轨共同设计简报，确保 Product Design 与 Pencil 使用同一产品输入。
- 新增三个 Product Design 视觉候选：行动中枢、Run 驾驶舱、态势与处置台。
- 新增 `P2F-01` 至 `P2F-06` 六页 Pencil 可编辑原型和页面导出图。
- 新增双轨原型评审表与内部初步对比结论，进入人工评审和融合决策。
- 完成人工选择和复审：Product Design A/B/C 三张图作为主视觉真相，本阶段聚焦 Web
  工作台交互，不做 APP/移动端兼容。
- 新增 P2 Web 工作台可点击原型，覆盖首页、新任务、Dry-run、Run 工作区、Attention 和
  审核抽屉。
- 新增桌面 Web 截图验证，确认 Product Design A/B/C 对应首页、Run 和 Attention 方向。
- 按最新人工决策完成原型视觉映射收口：A 固定用于首页，B 固定用于 Run 工作区，C 的
  根因联动固定用于 Attention。
- `fusion-clickable` 引入 `lucide-react` 图标库并重构三页桌面布局，重新生成
  `home-desktop.png`、`run-desktop.png`、`attention-desktop.png`。
- 完成 P2 Web 原型评审，生成 `18_P2原型评审纪要与修订清单.md`；最新结论为 P2
  原型完全通过，原问题项进入后续设计备忘和 P3 实现关注项。
- 新增 `P2F-07 Agent Collaboration` Web 页面原型，补充多 Agent 协同、交接合同、阻塞
  传播和恢复动作表达。
- 新增 P2 原型评审截图证据目录 `assets/reviews/p2-prototype-audit/`，保留首页、Run、
  Attention 和 Agent Collaboration 四个桌面截图。
- 补充 `14_技术架构选型与系统架构图.md` 的后端演进边界：明确 Node.js 是 MVP
  Local Sidecar，不是商业化云端主后端限定；商业化阶段建议拆分 Java/Kotlin 云端控制平面、
  Python/Node Worker 和队列化执行平面。
- 新增 P3 技术详细设计文档组 `19-23`：总纲与扩展性原则、核心数据模型、Local
  Sidecar API 与后端演进、前端架构与工作台状态、MVP 任务拆解与验收计划。
- P3 文档明确 Miracle 是通用 Agent OS，`content-production` 和 Flow A-G 只是第一条
  样本 Domain，不进入核心模型硬编码。
- 完成 P3 一致性修订：统一 `RunSpec / WorkflowSnapshot / RunManifest` 边界，移除
  `RunSnapshot` 作为核心对象；将审核真相收口到 `ArtifactSpec / GateSpec /
  GateInstance / GateDecision`，NodeSpec 仅保留 `review_gate_ref`。
- 补齐 `EdgeSpec.join_policy`、`POST /runs` 启动协议、`GET /gates/:id`、AdapterResult
  状态枚举和 operation/provider/artifact 对账字段。
- 明确 Agent/Adapter 不直接写 Event Journal，运行事实仍由 Sidecar Orchestrator 单写入。
- 新增 P4 第一轮 MVP 工程：`apps/web`、`apps/sidecar`、`packages/core`、
  `fixtures/mvp-workspace/.miracle` 和 P4 截图证据。
- MVP 已覆盖 MVPS01-MVPS07 可运行主链路，MVPS08-MVPS10 提供入口占位。
- 验证通过 `npm run typecheck`、`npm run test`、`npm run build`，并完成 Sidecar API
  smoke test 和 Playwright 页面截图。
- P4 第二轮新增 React Flow DAG 视图、Artifact Detail 文件预览、Gate 决策影响投影和
  Infinite Canvas 草稿态。
- 新增 `25_P4第二轮_DAG预览Gate投影与Canvas草稿交付说明.md`，同步记录新增接口、
  fixture、页面变化和验收重点。
- Sidecar 新增 `/runs/:id/dag`、`/workflows/:id/canvas-draft` 读写和增强后的
  Artifact/Gate Detail 响应；核心边界仍保持 Run/WorkflowSnapshot 只读、Canvas 草稿不
  影响执行依赖、Gate projection 不直接覆盖 Artifact。
- P4 第三轮新增 Sidecar API 集成测试，使用临时 workspace 启动真实 Sidecar，覆盖 DAG、
  Artifact 预览、Gate 决策幂等保护、Canvas 草稿保存和 Run 执行。
- 新增 Runner/Adapter 最小协议：`AdapterInvocation`、`AdapterResult`、
  `AdapterArtifactDescriptor`、`AdapterStatus` 和 Mock Runner 转换函数。
- Sidecar 新增 `POST /runs/:runId/nodes/:nodeRunId/execute`，由 Orchestrator 将 mock
  adapter 结果提交为 NodeAttempt、ArtifactManifest、GateInstance、TraceEvent 和
  NodeRun 状态变更；Runner 本身不直接写 Event Journal。
- 执行链路补充 selector-aware 下游推进和 NodeRun 本地 operation lock，避免未合格产物
  推进下游或并发请求重复提交运行事实。
- 新增 `26_P4第三轮_集成测试与Runner协议交付说明.md`，记录本轮接口、测试覆盖、
  当前边界和 P4 第四轮建议。
- P4 第四轮新增 Gate 决策真实推进：审核通过会更新目标 ArtifactManifest
  `review_status=approved`，生产节点从 `reviewing` 进入 `done`，并按 Edge selector
  推进下游；驳回会将目标产物标记为 `rejected` 并阻塞声明的下游节点。
- Run 工作区新增 NodeAttempt 展示和“执行当前节点”按钮，对接
  `POST /runs/:runId/nodes/:nodeRunId/execute`。
- Infinite Canvas 草稿新增发布能力，可生成新的 draft WorkflowSpec，并在写入前执行
  validate；stable WorkflowSpec 不被原地覆盖。
- 新增 Adapter 插件壳和 `/api/v0/adapters`，为 mock-local、Codex、Hermes、OpenClaw
  和官方 API adapter 预留扩展入口。
- 新增 `27_P4第四轮_Gate推进Canvas发布与执行UI交付说明.md`，记录本轮接口、状态
  写入规则、测试覆盖、当前边界和 P4 第五轮建议。
- 新增独立任务基线目录 `plans/mvp-task-baseline/`，梳理 P4 第五轮 MVP 十日计划、长期
  系统建设路线、串并行任务边界和任务基线看板验收规则；该目录不属于 Miracle 系统设计
  文档序列，也不进入系统 Web 工作台导航。
- 新增 `plans/mvp-task-baseline/roadmap.json`，作为独立任务基线页面的结构化计划数据源，
  登记阶段节点、D1-D10 执行计划、长期路线、并行泳道和同步规则。
- Sidecar 新增 `GET /api/v0/project/roadmap`，每次请求动态合并当前 Git HEAD、最近
  提交、未提交修改数量和证据文件存在/跟踪/最后提交状态。
- Sidecar 新增独立页面入口 `/task-baseline`，展示绿色完成点、大红当前点、灰色计划点、
  Git 同步状态、证据文件列表、MVP 日计划和长期系统构建路线。
- 新增任务基线页面截图证据 `plans/mvp-task-baseline/roadmap-page.png`。
- P4 第五轮 D3 新增 Gate reject 返工模型：`POST /api/v0/gates/:gateId/rework`
  会在 Gate 被 `reject` 或 `request_changes` 后创建 rework NodeAttempt、新
  ArtifactManifest version、新 GateInstance pending_review，并保留旧产物和旧 Gate 决策。
- 审核恢复规则补齐：返工 Gate 通过后，producer NodeRun 进入 `done`，被 Gate 阻塞的
  `required_before` 下游节点重新按 Edge selector 判断输入，满足条件后恢复为 `queued`，
  且 `upstream_artifacts` 指向新的返工产物版本。
- 新增 `28_P4第五轮_D3_Gate返工模型交付说明.md`，记录接口、状态写入规则、测试覆盖、
  当前边界和 D4/D5/D7/D8/D9 并行建议。
- P4 第五轮 D4 新增 Gate 返工 UI：Attention 可按关联 Gate 进入审核页，审核页支持
  Gate 列表切换、approve/reject/request_changes 决策、reject 后创建返工版本和返工 receipt。
- Run 工作区事件与审计新增语义高亮，明确展示 `rework_attempt_created`、
  `artifact_manifest_created`、`gate_pending_review` 和 `gate_decision_created` 等事件的
  subject 对象，便于反查 NodeRun、ArtifactManifest 和 GateInstance。
- 新增 `29_P4第五轮_D4_Gate返工UI与事件审计交付说明.md`，记录 D4 的页面入口、审计
  表达、当前边界和 D5 scheduler 主线建议。
- P4 第五轮 D5 新增最小 scheduler tick：`POST /api/v0/runs/:runId/scheduler/tick`
  支持 dry-run 决策和 commit 执行，扫描 queued NodeRun，遇到 pending_review Gate 的
  `required_before` 节点时只 pause，不越过人工审核门。
- Sidecar 抽出 `executeNodeRunOnce`，手动执行和 scheduler tick 共用同一套 Orchestrator
  写入路径，避免 NodeRun、NodeAttempt、ArtifactManifest、GateInstance 和 TraceEvent
  出现双写实现。
- Run 工作区新增“调度一次”按钮，事件审计新增 `scheduler_tick_started` 和
  `scheduler_tick_completed` 的中文标签。
- 新增 `30_P4第五轮_D5_最小Scheduler设计与Tick接口交付说明.md`，记录 scheduler
  tick API、Gate 暂停规则、测试覆盖和 D6 执行闭环建议。
- P4 第五轮 D6 新增 scheduler 连续执行闭环：`POST /api/v0/runs/:runId/scheduler/run`
  支持连续 tick、每轮重读 Run 状态、遇 pending_review Gate 暂停、执行失败停止。
- Scheduler 失败链路新增通用 Attention 聚合：`node:{node_run_id}:execution_failed`，
  并写入 `attention_item_created` 审计事件。
- Run 工作区新增“自动推进”按钮，事件审计新增 `scheduler_run_started`、
  `scheduler_run_completed` 和 `attention_item_created` 的中文标签。
- 新增 `31_P4第五轮_D6_Scheduler连续执行闭环交付说明.md`，记录连续推进 API、
  stop reason、失败 Attention、测试覆盖和 D7 Adapter 目录建议。
- P4 第五轮 D7 新增 Adapter 插件目录实体化：`.miracle/adapters/*.json` 成为本地
  Adapter manifest 数据源，覆盖 `mock-local`、`codex`、`hermes`、`openclaw` 和
  `official-api` 五类 adapter。
- 核心包新增 `AdapterManifest`、`AdapterCredentialRequirement`、`AdapterRegistryEntry`
  以及 manifest schema、credential check 和 adapter selection 函数。
- Sidecar `/api/v0/adapters` 改为返回 manifest registry、credential status、可执行状态和
  缺失凭证摘要；`dry-run` 增加 `adapter_routing`，用于启动前预览每个 Node 的 adapter
  承接情况。
- NodeRun 执行链路接入 adapter registry：默认内容生产主链路选择
  `codex-mock-compatible-adapter`，不可执行或缺能力时提交 failed AdapterResult，仍由
  Orchestrator 单写入 NodeAttempt、ArtifactManifest、GateInstance 和 TraceEvent。
- 新增 `32_P4第五轮_D7_Adapter插件目录实体化交付说明.md`，记录 manifest、凭证检查、
  Codex mock-compatible adapter、执行选择和 D8 建议。
- P4 第五轮 D8 新增 Canvas NodeSpec draft：Canvas node card 可生成结构化
  `node_spec_draft`，Sidecar 在保存前把草稿节点并入候选 WorkflowSpec 并执行
  validate-before-save。
- Canvas draft 发布逻辑增强：发布时生成新的 draft WorkflowSpec，新增节点进入
  `nodes`，稳定 Workflow 不被原地覆盖。
- P4 第五轮 D9 新增 Run 工作区轻量 polling：Run detail、DAG、Node Detail、Events
  和 Attention 会在 Run 页面挂载期间刷新，并提供自动刷新状态、立即刷新和暂停入口。
- Run 工作区新增状态计数和执行反馈卡，对 `running / queued / blocked / failed /
  done` 给出当前解释和恢复提示。
- 新增 `33_P4_MVP回归验收预备清单.md`，作为 D10 回归验收、截图证据和 task-baseline
  同步检查的预备资产，不代表 D10 已完成。
- 新增 `34_P4第五轮_D8_D9_Canvas节点草稿与Run刷新交付说明.md`，记录 D8/D9 的接口、
  UI、写入边界、验收场景和下一步 D10 建议。
- D10 MVP 回归验收通过：`npm run typecheck`、`npm run test`、`npm run build` 和
  `git diff --check` 均通过。
- API smoke 覆盖只读端点、临时 workspace 写入端点、Scheduler、Gate reject/rework
  和 Canvas draft/publish。
- 新增 `assets/reviews/p4-mvp/` 截图证据，覆盖首页、新任务、Dry-run、Run、Attention、
  Gate、Artifact、Agent、Canvas 和 task-baseline。
- 修复 Web Dry-run 页面请求方法，改为使用 Sidecar 定义的 POST dry-run。
- 修复 Canvas NodeSpec draft 生成链路，生成请求直接携带当前画布 `objects`，避免空
  状态覆盖服务端草稿，并补充 Sidecar 测试保护未保存 layout。
- 新增 `35_P4_MVP回归验收与版本收口报告.md`，作为 D10 通过结论和 `v0.7.0` 收口资产。

本节已作为 P4 MVP 工程验收后的 `v0.7.0` 版本记录收口。

## 4.1 未发布变更

- 新增 `36_P5真实工作流接入详细计划与任务拆解.md`，将 P5 从方向级计划拆分为
  `P5-01` 至 `P5-09` 的可执行任务。
- 同步 `07_后续对接路线图与任务拆解.md`、`README.md` 和
  `17_文档资产关联与AI阅读导航.md`，明确 P5 当前任务和阅读入口。
- 更新 `plans/mvp-task-baseline/roadmap.json`，将 P5 设置为当前阶段，并建立
  `P5-01` 至 `P5-09` 的任务节点。
- 新增 `37_P5-01真实工作区盘点报告.md`，确认 W24 为主样本、W23 为对照样本，并记录
  控制文件、产物文件、审核文件和对象映射候选。
- 同步 task-baseline：`P5-01` 标记完成，`current_node_id` 推进到 `p5-02`。
- 新增 `38_P5-02FlowAG对象映射设计.md`，完成 Flow A-G 到 WorkflowSpec、ArtifactSpec、
  GateSpec、AgentSpec、ComponentLibrary、Run projection 和可信度规则的映射。
- 同步 task-baseline：`P5-02` 标记完成，`current_node_id` 推进到 `p5-03`。
- 新增 `39_P5-03历史Run只读导入方案.md`，定义 historical importer 的输入输出、
  W24/W23 projection、source metadata、TraceEvent 边界和降级导入规则。
- 同步 task-baseline：`P5-03` 标记完成，`current_node_id` 推进到 `p5-04`。
- 新增 `40_Miracle系统操作使用说明书.md`，作为用户操作真相源，统一记录本地启动、
  功能菜单、典型操作、版本感知、常见问题和后续手册同步规则。
- 同步 README、文档阅读导航和 task-baseline 说明：后续重要迭代若影响用户操作或
  用户可感知功能，必须同步更新操作手册；若无操作影响，应在版本记录中明确说明。
- 新增 `41_P5-04审核策略映射设计.md`，完成 `approval_policy.yaml` 到
  GateSpec、GateInstance、GateDecision、Artifact review status、source_meta 和
  `F_final_render pending_review` 的映射规则。
- 同步 task-baseline：`P5-04` 标记完成，`current_node_id` 推进到 `p5-05`。
- 本次为 P5 导入设计文档更新，不改变本地启动命令和 Web 菜单操作。
- 新增 `42_P5-05Trace映射设计.md`，完成 `task_trace.json.steps` 到 NodeAttempt、
  `task_events.jsonl` 到 TraceEvent、GateDecision/TraceEvent 关联和 W23 缺 trace
  降级规则。
- 同步 task-baseline：`P5-05` 标记完成，`current_node_id` 推进到 `p5-06`。
- 本次为 P5 导入设计文档更新，不改变本地启动命令和 Web 菜单操作。
- 新增 `43_P5-06真实历史Run_UI展示验收方案.md`，完成真实历史 Run 在 Run、
  DAG、Agent、Artifact、Gate、Attention 中的展示验收口径、API smoke 范围和截图证据要求。
- 同步 task-baseline：`P5-06` 标记完成，`current_node_id` 推进到 `p5-07`。
- 本次为 P5 展示验收方案更新，不改变本地启动命令和 Web 菜单操作。
- 新增 `44_P5-07半自动新Run草案设计.md`，定义 RunDraft、WorkflowSnapshotDraft、
  RunDraftDryRunPlan、LaunchConfirmation、草案审计和 P5-08 启动边界；复用核心
  DryRunPlan 与既有 `POST /api/v0/runs`，避免形成两套计划和启动协议。
- 同步 task-baseline：`P5-07` 标记完成，`current_node_id` 推进到 `p5-08`。
- 本次为半自动启动协议设计更新，尚未实现 Run draft 页面或真实 Runner，不改变当前可运行
  Web 菜单和启动命令。
- 新增 `45_P5-08首个真实Adapter边界评估.md`，推荐 Codex CLI 作为首个真实 Adapter，
  定义 attempt workspace、Codex JSONL、输出校验、凭证、取消、超时、崩溃对账和官方
  Responses API 第二阶段边界。
- 同步 task-baseline：`P5-08` 标记完成，`current_node_id` 推进到 `p5-09`。
- 本次为 Adapter 选型和技术边界更新，尚未启用真实 Codex/API 调用，不改变当前 Web
  菜单和启动命令。
- 新增 `46_P5回归验收与阶段收口报告.md`，完成 P5-01 至 P5-08 证据、真实 W24/W23
  样本、工程测试、20 项 API smoke、页面截图和范围真实性验收。
- 修复 Sidecar roadmap API 测试硬编码旧 `p4-06` 当前节点的问题，改为验证当前节点存在且
  状态为 current。
- 同步 task-baseline：`P5-09` 标记完成，P5 阶段收口，`current_node_id` 推进到
  `p6-01`。
- 本次不升级运行版本；系统仍为 `v0.7.0`，P6 实装真实 historical importer 后再评估
  `v0.8.0`。
- 新增 `47_P6真实工作流工程实施计划与任务拆解.md`，采用 historical importer/真实 Run
  UI、RunDraft、Adapter Contract/Codex CLI 三轨并行方案，拆分 `P6-02` 至 `P6-08`。
- 明确真实源工作区只读、导入根目录白名单、大媒体不复制、historical mutation 409、
  Codex attempt workspace、超时/取消、fake/real 双层验收和 Orchestrator 单写入约束。
- 同步 README、路线图、AI 阅读导航、操作手册与 task-baseline；`P6-01` 标记完成，
  `current_node_id` 推进到 `p6-02`。
- 本次仅新增工程实施计划，不新增用户可运行功能，不升级 `v0.7.0`。
- 新增 `48_P6-02HistoricalImporter与Projection交付说明.md`，实现 W24/W23 historical
  preview/commit、source_meta、staging 原子写入、fingerprint 幂等和真实样本 smoke。
- 新增 `content-production-real-v0` WorkflowSpec 和 W24/W23 最小合成测试样本；真实交付包、
  大媒体和凭证不进入 Git。
- 将 RunSpec 收口为 executable/historical_readonly discriminated union；historical scheduler、
  node execute、Gate decision 和 rework 返回 `409 historical_run_read_only`。
- importer 改用流式内容 SHA-256 指纹，增加 import 级互斥锁、缺失回执自愈和仓库外
  runtime workspace 强制校验；Gate decision/rework 纳入 historical 只读保护回归。
- 修复 Artifact/Gate 缺少审批证据仍被投影为 `approved/decided` 的事实错误；增加 symlink
  workspace 防护、stale/corrupt lock 恢复、损坏控制数据 422 和缺失回执 404。
- 测试增至 Sidecar 34 项、Core 10 项；真实 W24 导入得到 27 条 source event 和 10 个
  historical attempt，W23 保持 0 source event/0 attempt，源文件哨兵未变化。
- 同步 task-baseline：`P6-02` 标记完成，`current_node_id` 推进到 `p6-03`。
- 本次新增 Sidecar API，但 Web 尚未展示真实 historical run，运行版本继续保持 `v0.7.0`。
- 新增 `49_P6-03真实Run_API与Web展示交付说明.md`，完成 W24/W23 historical Run 的只读
  Run API、Run/Attention/Agent/Artifact/Gate Web 展示、证据等级和来源缺口提示。
- 历史 Run 的跨页面选择会保持同一 `run_id`，隐藏执行、调度、审核和返工操作；新增真实 Run
  页面截图到 `assets/reviews/p6-real-run-ui/`，并补充 Artifact ID 稳定路径哈希避免非 ASCII
  路径归一化冲突。
- 测试增至 Sidecar 35 项、Core 10 项、Web 3 项；同步 task-baseline：`P6-03` 标记完成，
  `current_node_id` 推进到 `p6-04`，当前进入 P6-04 RunDraft API 与 Web。
- 完成 `P6-04` RunDraft API/Web：草案、Dry-run、确认/撤回/取消、审计与启动前交叉校验闭环；未选择的可选分支不再误报阻塞。
- 完成 `P6-05` Adapter Contract：Invocation/Result/Receipt 强关联，Sidecar 在提交运行事实前拒绝不匹配回执并恢复 NodeRun。
- 补齐 Provider、成本、预计时长和分支 startability 展示，增加终态保护、损坏状态检测与 stale lock 恢复。
- 同步 task-baseline：`P6-04`、`P6-05` 标记完成，`current_node_id` 推进到 `p6-06`；运行版本仍保持 `v0.7.0`。
- 完成 `P6-06` Codex CLI health、仓库外隔离 attempt workspace、只读输入 staging、输出边界、timeout/cancel 和 fake CLI 生命周期。
- 两轮安全审查修复 attempt/operation 路径穿越、目录 symlink、spawn error 竞态、sandbox 权限放宽及首次 receipt 持久化失败问题。
- 本机只读 smoke 确认 `codex-cli 0.144.2` 且登录可用；未执行真实内容任务。
- 同步 task-baseline：`P6-06` 标记完成，`current_node_id` 推进到 `p6-07`；运行版本仍保持 `v0.7.0`。
- 修复 monorepo 根级命令可能读取旧 `packages/core/dist` 的问题：`dev`、`test` 和
  `build` 现在先构建 Core，再启动或验证 Sidecar/Web，确保干净克隆和分支合并后的
  RunDraft/Codex 导出保持一致。

## 5. 里程碑

### M1 项目规划基线

Miracle 的系统定位、核心分层、组件体系、工作流编排、多 Agent 协同、双模式可视化、
智能进化和实施路线首次形成完整文档体系。

### M2 Spec-first 路线确立

WorkflowSpec 被确立为模板和编排真相，UI、DAG、无限画布和 YAML/JSON 统一为同一
Spec 的不同编辑视图；项目从概念规划进入可校验技术协议设计。

### M3 技术架构基线

完成 P0 架构评审、MVP 技术选型、系统架构图和运行态架构图，明确本地优先、
Orchestrator 单写入、Runtime Adapter 隔离及文件、数据库和 Git 的边界。

### M4 运行模型定型

经过三轮架构评审，完成 WorkflowSnapshot、RunSpec、NodeRun、NodeAttempt、
ArtifactManifest、GateInstance、GateDecision、selector 和 Event Journal 的职责
划分，核心运行模型具备可恢复和可审计语义。

### M5 架构评审通过

第四轮评审及最终复核完成外部副作用提交协议、operation 生命周期、可选分支 join、
审核动作与决定枚举、产物审核策略和投影重建规则的收口。当前架构允许进入产品信息
架构、原型设计和 P3 实现。

### M6 本地 MVP 验收通过

P4 D10 完成回归验收与版本收口，确认本地 Web、Local Sidecar、core、fixtures、Run、
Gate、Artifact、Attention、Agent、Canvas、Scheduler、Adapter manifest 和 task-baseline
形成可运行、可演示、可回归的 MVP 基线。

## 6. 详细版本记录

### v0.5.1 版本演进记录机制

**发布日期：** 2026-06-18
**提交：** `1bd740f`
**相对基线：** `e7eb1f0`
**文件变化：** 新增 1，更新 1，删除 0；共 2 个文件，新增 327 行、删除 0 行。
**里程碑：** 无，作为架构基线后的维护机制修订。

#### 变更摘要

- 新增统一的系统版本演进记录。
- README 增加版本历史入口和维护要求。
- 建立版本号、文件统计、详细变更、验证结果和里程碑的统一记录规范。

#### 验证结果

- 版本总览、里程碑和详细版本记录已覆盖 `v0.1.0` 至 `v0.5.1`。
- Git 提交区间、文件变化和架构里程碑可追溯。

### v0.5.0 架构最终评审基线

**发布日期：** 2026-06-18  
**提交区间：** `416bd62` 至 `e7eb1f0`，包含首尾提交  
**相对基线：** `72977b8`  
**文件变化：** 新增 7，更新 13，删除 0；共 20 个文件，新增 1440 行、删除 78 行。  
**里程碑：** M5 架构评审通过。

#### 变更摘要

- 完成第四次架构评审和最终复核。
- 建立外部调用 dispatched/received/committed 崩溃恢复协议。
- 明确 operation 与 attempt 的生命周期。
- 修复 Flow A-G 必需分支和可选分支的汇聚语义。
- 增加中文架构图和中英术语映射。

#### 详细更新

- 外部调用前写入 `attempt_dispatched`；只有 dispatched、没有 received 时进入
  reconciliation，禁止盲目重试。
- `adapter_result_received` 保存完整脱敏 AdapterResult；投影按稳定键幂等 upsert。
- 网络重试和 provider fallback 复用 operation；审核返工、用户重跑、输入变化和
  preview 转 real-run 创建新的 business revision 和 operation。
- Flow A-G 增加 `B -> G` required edge，`F -> G` 改为 optional edge。
- `wait_if_active` 增加最大等待时间、无合格产物终止策略和超时处理。
- GateSpec 使用 action 命令词，GateDecision 使用持久结果词。
- `ArtifactSpec.review_policy` 成为审核绑定真相。
- TraceEvent 使用通用 subject，不再要求所有事件虚构 node ID。
- GateInstance 状态收口为 `pending_review / decided / invalidated`。
- 新增 5 张中文架构图及确定性图片生成脚本。

#### 验证结果

- Flow A-G：8 nodes、8 edges、4 gates、12 artifacts。
- YAML 解析通过。
- 引用完整性检查通过。
- Gate/join 语义校验通过。
- 中文架构图视觉检查通过。

#### 兼容性说明

旧版 `decisions: [approve, ...]`、`default_release_status` 和无界
`wait_if_active` 不应继续用于后续实现。实现 Schema 时以本版本文档为准。

### v0.4.0 运行模型与执行协议收口

**发布日期：** 2026-06-18  
**提交区间：** `88a41eb` 至 `72977b8`，包含首尾提交  
**相对基线：** `bc43d3e`  
**文件变化：** 新增 3，更新 18，删除 0；共 21 个文件，新增 3336 行、删除 318 行。  
**里程碑：** M4 运行模型定型。

#### 变更摘要

- 完成前三轮架构评审。
- 将模板定义、运行聚合、真实尝试、产物实例和审核决定彻底分层。
- 建立运行快照、输入冻结、产物版本和事件恢复的基础协议。

#### 详细更新

- 引入不可变 WorkflowSnapshot 和 RunSpec。
- 确立 NodeSpec、NodeRun、NodeAttempt 三层关系。
- 重试、fallback 和返工只新增 NodeAttempt，不新增 DAG 节点。
- ArtifactSpec 与 ArtifactManifest 分离，路径包含版本或 attempt ID。
- 增加 GateInstance，GateDecision 绑定具体 artifact ID 和 hash。
- NodeAttempt 创建前解析并冻结 resolved input。
- Event Journal 成为权威运行源，NodeRun、Attempt、Manifest 和 Gate 等作为投影。
- 增加 pause、cancel、timeout、unknown 和 reconciliation 等运行语义。
- 对 WorkflowSpec、Registry、AgentHealth、VisualBuilder 和 MVP 文档进行全局一致性修订。

#### 验证结果

- Flow A-G 正式 YAML 样例可解析。
- 节点、边、Gate 和 Artifact 引用完整性通过。
- 架构图同步运行模型与状态分层。

#### 兼容性说明

此前将 NodeRun 当作每次执行记录、将 GateDecision 保存 pending_review、或直接用
ArtifactSpec 表示运行产物的设计均废止。

### v0.3.0 P0 评审与技术架构选型

**发布日期：** 2026-06-17  
**提交区间：** `581e65c` 至 `bc43d3e`，包含首尾提交  
**相对基线：** `970d6bc`  
**文件变化：** 新增 7，更新 3，删除 0；共 10 个文件，新增 682 行、删除 40 行。  
**里程碑：** M3 技术架构基线。

#### 变更摘要

- 完成 P0 架构评审和决策清单。
- 将技术架构选型独立为 P1.5 阶段。
- 建立系统、产品、运行、协同和工作流生命周期架构图。

#### 详细更新

- 明确本地优先控制平面和 MVP 技术栈。
- 设计 Local Service、Orchestrator、ProviderRouter、Runtime Adapter 的职责边界。
- 规划 WorkflowSpec YAML、JSONL 运行记录和后续 SQLite 索引层。
- 明确凭证、大媒体文件、运行数据和 Git 版本化资产的边界。
- 将产品信息架构和产品设计图延后至 P2。

#### 验证结果

- P0 决策项形成可追踪清单。
- 五张英文架构图完成并进入仓库。

### v0.2.0 Spec 优先技术规划

**发布日期：** 2026-06-17  
**提交区间：** `17dbd32` 至 `970d6bc`，包含首尾提交  
**相对基线：** `f68e59c`  
**文件变化：** 新增 5，更新 6，删除 0；共 11 个文件，新增 2152 行、删除 19 行。  
**里程碑：** M2 Spec-first 路线确立。

#### 变更摘要

- 完成竞品分析。
- 新增 WorkflowSpec、Registry、AgentHealth、VisualBuilder 和 MVP 原型规划。
- 确立 Spec-first 的系统演进路线。

#### 详细更新

- 调研 OpenClaw、Hermes Agent、Claude Code、Codex 等参考架构。
- 定义 WorkflowSpec YAML v0、Registry、validate、dry-run 和 estimate。
- 定义 AgentSpec、AgentHealth、PermissionMatrix 和多 Agent 状态机。
- 定义无限画布、DAG 与 Spec 的双向同步机制。
- 输出 MVP 功能清单、界面草图和验收场景。
- 修正文档之间的对象命名、资产范围和阶段描述一致性。

#### 验证结果

- 核心技术草案具备字段级示例。
- MVP 范围和后续评审入口明确。

### v0.1.0 系统规划初版

**发布日期：** 2026-06-16  
**提交区间：** `520191f` 至 `f68e59c`，包含首尾提交  
**相对基线：** 空仓库  
**文件变化：** 新增 9，更新 0，删除 0；共 9 个文件，新增 2201 行。  
**里程碑：** M1 项目规划基线。

#### 变更摘要

- 初始化 Miracle 系统规划文档体系。
- 确立超级智能体控制平面和工作流操作系统定位。
- 形成从系统规划到后续任务拆解的第一版完整路线。

#### 详细更新

- 系统总体规划和核心对象模型。
- 组件库与插件体系。
- 智能路由和工作流编排。
- 多 Agent 协同和可视化。
- 无限画布与流程节点双模式编排。
- 智能进化体系。
- 后续对接路线图和任务拆解。
- 建立 README 阅读顺序。

#### 验证结果

- 初版文档结构完整。
- 总纲表格格式完成规范化。

## 7. 下一版本规划

P6 完成 historical importer、RunDraft 和 Codex 单节点真实执行并通过验收后，建议评估发布：

```text
v0.8.0 真实工作流工程接入基线
```

若 P6-08 仍有真实执行阻塞项，则继续保持 `v0.7.0`，不得只因文档或部分模块完成而升级。

首个具备真实 Schema 校验器、Event Journal 和本地 runner 的可执行技术版本，建议发布：

```text
v0.7.0 可执行技术原型
```

## 8. 新版本记录模板

```markdown
## vX.Y.Z 版本名称

**发布日期：** YYYY-MM-DD
**提交区间：** `起始提交..结束提交`
**相对基线：** `上一版本提交`
**文件变化：** 新增 N，更新 N，删除 N；共 N 个文件。
**里程碑：** 否，或 Mx 里程碑名称。

### 变更摘要

- 

### 详细更新

- 

### 验证结果

- 

### 兼容性说明

- 
```
