# Miracle 系统版本演进记录

> 本文件是 Miracle 项目的统一版本历史。它记录系统在规划、架构、产品和实现阶段的
> 主要演进，不替代 Git commit，而是把分散提交归并为可理解、可追踪的大版本。

## 1. 当前版本

| 项目 | 当前值 |
|---|---|
| 当前大版本 | `v0.5.1` |
| 版本名称 | P4 MVP 第五轮执行能力补齐 |
| 当前阶段 | P4 第五轮已完成 D3 Gate reject 返工模型，支持返工 attempt、新 Artifact version、新 GateInstance 和下游恢复规则；项目任务基线独立维护在 `plans/mvp-task-baseline/` |
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

## 4. 未发布变更

**目标版本：** `v0.6.0`
**相对基线：** `1bd740f`
**当前文件变化：** 新增 112，更新 12，删除 0；发布前重新统计最终行数。

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

本节在 P4 MVP 工程验收后，转换为正式的 `v0.7.0` 版本记录。

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

下一次完成产品信息架构和核心原型设计时，建议发布：

```text
v0.6.0 产品信息架构与原型基线
```

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
