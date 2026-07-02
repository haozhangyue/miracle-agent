# 33_P4_MVP回归验收预备清单

> 文档状态：D10 MVP 回归验收与版本收口预备清单，已由
> `35_P4_MVP回归验收与版本收口报告.md` 执行并收口。
>
> 适用阶段：D8 Canvas 新增节点生成 NodeSpec draft、D9 Web run refresh/polling 完成后执行最终验收。
>
> 写入边界：本文件保留为验收预备资产；D10 的实际执行结果、截图证据和修复项以
> `35_P4_MVP回归验收与版本收口报告.md` 为准。

## 1. 验收目标

D10 的目标不是新增功能，而是把 P4 当前 MVP 收成一条可验证、可演示、可回归的本地 Agent OS 主链路：

```text
WorkflowSpec / Registry / AdapterManifest
-> Validate / Dry-run / POST Run
-> Run DAG / Node Detail / Artifact / Gate / Attention
-> 手动执行 / Scheduler tick / Scheduler run
-> Gate 审核 / Reject 返工 / 新版本审核
-> Canvas draft / Workflow draft
-> task-baseline / 版本记录 / 截图证据
```

验收必须确认：

1. MVP 能本地启动。
2. 核心页面能从 Sidecar API 读取数据。
3. Run、Gate、Artifact、Attention、Agent、Canvas、Adapter、Scheduler 的状态模型没有明显断链。
4. 所有运行事实仍由 Sidecar Orchestrator 单写入。
5. D8/D9 完成后，Canvas NodeSpec draft 和 Web polling 不破坏既有 P4 主链路。

## 2. 当前已完成能力清单

以下能力来自 `24` 至 `32` 的 P4 交付文档和 `plans/mvp-task-baseline/roadmap.json`。D10 执行时需要重新验证，不应只依赖文档结论。

| 能力 | 当前状态 | 证据文档 | D10 验收关注 |
|---|---|---|---|
| MVPS01 WorkflowSpec / Domain / Registry 样例 | 已完成 | `24_P4_MVP可运行主链路交付说明.md` | schema 校验和 fixture 读取仍通过。 |
| MVPS02 多领域样例 | 已完成 | `24_P4_MVP可运行主链路交付说明.md` | 内容生产不是硬编码边界，生图、剧本、研究样例仍可列出。 |
| MVPS03 Validate / Dry-run / POST Run | 已完成 | `24_P4_MVP可运行主链路交付说明.md` | dry-run 风险、审核门、adapter routing、POST Run 写入链路可用。 |
| MVPS04 Run DAG / Node Detail | 已完成 | `24`、`25` | React Flow DAG、阶段过滤、Node Detail、Attempt 显示正常。 |
| MVPS05 Agent Collaboration | 已完成 | `24` | AgentHealth、active runs、queued/current node runs 展示正常。 |
| MVPS06 Artifact Board / Detail Preview | 已完成 | `24`、`25` | markdown/json/text 预览和 missing/binary 说明正常。 |
| MVPS07 Gate Review | 已完成 | `24`、`27`、`29` | approve/reject/request_changes、返工入口、决策历史、事件审计正常。 |
| MVPS08 Infinite Canvas 草稿态 | 已部分完成 | `25`、`27` | 已支持草稿编辑和 layout 发布；D8 后需要补验 NodeSpec draft。 |
| MVPS09 Visual/Spec Sync | 已部分完成 | `25`、`27` | 当前有 spec diff preview 和 publish draft；完整冲突合并不在 MVP。 |
| MVPS10 Evolution Board v0 | 占位 | `24` | 不进入本次 D10 功能验收，只确认入口不误导。 |
| Runner/Adapter 最小协议 | 已完成 | `26` | AdapterResult、NodeAttempt、ArtifactManifest、TraceEvent 对账可回归。 |
| Gate 决策真实推进 | 已完成 | `27` | approve 后下游 selector-aware 推进，reject 后阻塞下游。 |
| Gate reject 返工模型 | 已完成 | `28` | 新 attempt、新 artifact version、新 Gate，不覆盖历史。 |
| Gate 返工 UI 与事件审计 | 已完成 | `29` | Attention 到 Gate Review 联动、返工 receipt 和事件高亮。 |
| Scheduler tick | 已完成 | `30` | `scheduler/tick` 支持 dry-run、commit、pending Gate pause。 |
| Scheduler 连续推进 | 已完成 | `31` | `scheduler/run` 能连续推进并在 Gate/失败处停止。 |
| Adapter 插件目录实体化 | 已完成 | `32` | `.miracle/adapters/*.json`、credential status、dry-run routing、执行选择。 |
| task-baseline 独立页面 | 已完成 | `plans/mvp-task-baseline/README.md` | `/task-baseline` 和 `/api/v0/project/roadmap` 能反映 Git 与证据文件状态。 |

## 3. D10 需要确认的 D8/D9 关键场景

以下场景用于 D10 回归验收；D8/D9 已实现，但最终通过仍以 D10 验证结果为准。

### 3.1 D8 Canvas NodeSpec draft

D10 需确认：

1. Canvas 可以新增 node card。
2. 新 node card 能生成 `NodeSpec draft`，包含最小字段：`id`、`name`、`type`、`capability_requirements`、`inputs`、`outputs`、`agent_candidates`、`recommended_libraries`、`failure_policy`。
3. 保存或发布前执行 validate-before-save。
4. draft 不直接覆盖 stable WorkflowSpec。
5. draft 发布后的 WorkflowSpec 可通过 workflow detail 读取。
6. D8 不破坏既有 Canvas layout draft 和 publish draft 能力。

### 3.2 D9 Web run refresh/polling

D10 需确认：

1. Run 工作区进入执行态后能自动刷新 Run header、DAG、Node Detail、Event Drawer。
2. Scheduler tick/run 后页面能看到新事件、节点状态、Attention 数量变化。
3. polling 不造成明显重复请求风暴；离开 Run 页面后应停止或降频。
4. 错误状态能给出恢复动作，例如进入 Attention、Gate Review、切换 Provider 或查看 Attempt。
5. Web polling 不改变 Sidecar 写入事实，只刷新投影。

### 3.3 D8/D9 联动回归

D10 需确认：

1. 从 Canvas 生成 draft 后，Run 页面仍只展示当前 Run 的 `WorkflowSnapshot`，不会误读未启动的 draft。
2. Web polling 刷新时不会覆盖用户正在编辑的 Canvas draft 表单。
3. 新增 NodeSpec draft 的 validate 错误能被 UI 保留，不会因为 polling 丢失。
4. task-baseline 在 D8/D9 提交后能显示最新 Git HEAD 和证据文件状态。

## 4. 必跑命令

D10 最终收口时，在仓库根目录执行：

```bash
npm run typecheck
npm run test
npm run build
git diff --check
```

建议补充：

```bash
git status --short --branch
```

如果 D8/D9 修改了测试或构建配置，还应单独运行对应 workspace 命令定位问题：

```bash
npm run test -w apps/sidecar
npm run typecheck -w apps/web
npm run build -w apps/web
```

## 5. API smoke check

启动 Sidecar：

```bash
npm run dev:sidecar
```

基础 API：

| API | 期望 |
|---|---|
| `GET /api/v0/health` | 返回健康状态。 |
| `GET /api/v0/project/roadmap` | 返回 roadmap、Git HEAD、dirty 状态和证据文件状态。 |
| `GET /api/v0/domains` | 返回 DomainPack 列表。 |
| `GET /api/v0/roles` | 返回 RoleProfile 列表。 |
| `GET /api/v0/registry/templates` | 返回模板 registry。 |
| `GET /api/v0/adapters` | 返回 adapter manifest、credential status、executable summary。 |
| `GET /api/v0/workflows` | 返回 workflow 列表。 |
| `GET /api/v0/workflows/content-production-v0` | 返回样本 WorkflowSpec。 |
| `POST /api/v0/workflows/content-production-v0/validate` | 返回引用完整性与风险结果。 |
| `POST /api/v0/workflows/content-production-v0/dry-run` | 返回执行计划、审核门、成本/风险、adapter routing。 |
| `GET /api/v0/runs` | 返回 run 列表。 |
| `GET /api/v0/runs/run-demo-001` | 返回 demo run detail。 |
| `GET /api/v0/runs/run-demo-001/dag` | 返回 DAG 投影。 |
| `GET /api/v0/runs/run-demo-001/events` | 返回 Event Journal。 |
| `GET /api/v0/agents/health` | 返回 AgentHealthProjection。 |
| `GET /api/v0/agents/collaboration` | 返回协同态势。 |
| `GET /api/v0/attention` | 返回 Attention 队列。 |
| `GET /api/v0/artifacts` | 返回 ArtifactManifest 列表。 |
| `GET /api/v0/artifacts/:artifactId` | 返回 artifact detail 和可预览内容。 |
| `GET /api/v0/gates/:gateId?run_id=:runId` | 返回 GateInstance、target artifact、history decisions、projection。 |

写入类 smoke 建议在临时 workspace 执行，避免污染提交 fixture：

| API | 期望 |
|---|---|
| `POST /api/v0/runs` | 创建 RunSpec、WorkflowSnapshot、初始 NodeRun、`run_created` 事件。 |
| `POST /api/v0/runs/:runId/nodes/:nodeRunId/execute` | 手动执行 queued 节点，写入 Attempt、Artifact、Gate、Event。 |
| `POST /api/v0/runs/:runId/scheduler/tick` | 单次调度可 dry-run 或 commit。 |
| `POST /api/v0/runs/:runId/scheduler/run` | 连续推进直到 Gate、失败、无可执行节点或 max ticks。 |
| `POST /api/v0/gates/:gateId/decision?run_id=:runId` | 创建 GateDecision，并投影或推进下游状态。 |
| `POST /api/v0/gates/:gateId/rework?run_id=:runId` | reject/request_changes 后创建返工 attempt、新 artifact version、新 Gate。 |
| `POST /api/v0/workflows/:workflowId/canvas-draft` | 保存 Canvas 草稿。 |
| `POST /api/v0/workflows/:workflowId/canvas-draft/publish` | 发布为 draft WorkflowSpec，写入前 validate。 |

D8 完成后补充：

| API/页面 | 期望 |
|---|---|
| Canvas 新增节点 draft 保存接口 | 能保存 NodeSpec draft，不覆盖 stable spec。 |
| Canvas draft publish | 能把新 NodeSpec draft 带入 draft WorkflowSpec，并通过 validate。 |

## 6. 页面 smoke check

启动 Web 和 Sidecar：

```bash
npm run dev
```

页面验收：

| 页面 | 入口 | 验收重点 |
|---|---|---|
| 首页 | `http://127.0.0.1:5174/` | 待处理、继续运行、快速启动、最近交付、系统风险可见。 |
| 新任务 / Dry-run | Web 工作台内入口 | 能选择模板、查看 validate/dry-run、看到 adapter routing，并启动 Run。 |
| Run 工作区 | Web 工作台内入口 | Run header、React Flow DAG、阶段过滤、Node Detail、Attempt、Event Drawer 正常。 |
| Attention | Web 工作台内入口 | 根因聚合、关联对象、安全动作、Attention 生命周期可见。 |
| Gate Review | Web 工作台内入口 | 审核决策、返工版本、决策历史、下游影响、receipt 可见。 |
| Artifact Board | Web 工作台内入口 | ArtifactManifest 表格、预览、version/hash/review_status 可见。 |
| Agent Collaboration | Web 工作台内入口 | Agent 状态、active/queued/current node runs、阻塞传播和交接对象可见。 |
| Infinite Canvas | Web 工作台内入口 | 草稿卡片、layout 保存、publish draft；D8 后验证新增 NodeSpec draft。 |
| task-baseline | `http://127.0.0.1:4317/task-baseline` | 当前节点、Git HEAD、dirty 状态、证据文件状态可见。 |

## 7. 截图证据建议

最终截图统一放入：

```text
assets/reviews/p4-mvp/
```

建议命名：

| 截图 | 文件名 |
|---|---|
| 首页 | `assets/reviews/p4-mvp/01-home.png` |
| 新任务与 Dry-run | `assets/reviews/p4-mvp/02-dry-run.png` |
| Run DAG 与 Node Detail | `assets/reviews/p4-mvp/03-run-dag-node-detail.png` |
| Scheduler 自动推进反馈 | `assets/reviews/p4-mvp/04-scheduler-run.png` |
| Attention 根因聚合 | `assets/reviews/p4-mvp/05-attention.png` |
| Gate Review 审核与返工 | `assets/reviews/p4-mvp/06-gate-rework.png` |
| Artifact Detail Preview | `assets/reviews/p4-mvp/07-artifact-preview.png` |
| Agent Collaboration | `assets/reviews/p4-mvp/08-agent-collaboration.png` |
| Canvas NodeSpec draft | `assets/reviews/p4-mvp/09-canvas-node-draft.png` |
| task-baseline | `assets/reviews/p4-mvp/10-task-baseline.png` |

注意：

1. 若保留旧截图，也应新增最新 D10 截图，避免旧证据掩盖 D8/D9 回归。
2. 截图只作为展示证据，最终验收仍以命令、API 和状态文件为准。
3. 不做移动端 / APP 响应式截图验收。

## 8. task-baseline 同步检查项

D10 收口时检查：

1. `plans/mvp-task-baseline/roadmap.json` 中 D8、D9、D10 状态与实际提交一致。
2. `current_node_id` 已从 `p4-05` 按主线程决策切到 `p4-06` 或后续阶段。
3. `generated_from` 包含 D8、D9、D10 对应交付说明文档。
4. `phase_timeline` 的 P4 第五轮 summary 不再停留在 D7。
5. `mvp_execution_plan` 中：
   - D8 标为 completed。
   - D9 标为 completed。
   - D10 在验收完成后标为 completed。
6. 启动 Sidecar 后刷新 `/task-baseline`，页面能看到最新 Git HEAD。
7. 页面 evidence file 状态显示新增文档和截图实际存在、已被 Git 跟踪。

## 9. 暂不验收 / 不进入 MVP 的事项

以下事项不应作为 D10 阻断项：

1. 真实 Codex CLI / Hermes / OpenClaw / 官方 API 执行。
2. 商业化云端控制平面。
3. 多租户、账号、组织、权限、计费。
4. 后台常驻 scheduler、跨 Run 调度、队列、Worker 池。
5. Agent capacity pool 和复杂并发调度。
6. 完整 Visual/Spec 文件 watcher 双向同步与冲突合并。
7. Evolution Board 真实推荐算法。
8. 移动端 / APP 适配。
9. 真实媒体播放器、视频渲染和 TTS 外部服务调用。
10. 真实凭证读取 keychain/workspace-secret。

## 10. 风险与回归关注点

| 风险 | 可能影响 | D10 检查方式 |
|---|---|---|
| D8 修改 WorkflowSpec/Canvas 模型导致既有 Canvas publish 失效 | 画布发布和 draft workflow 断链 | 跑 canvas draft 保存、publish、workflow detail。 |
| D8 新增 NodeSpec draft 后 validate 规则过宽或过严 | 无效节点进入 draft，或合法节点无法保存 | 用缺字段、合法字段各测一次 validate-before-save。 |
| D9 polling 与用户操作竞争 | 表单内容丢失、状态闪烁、重复请求 | 编辑 Canvas/Gate comment 时观察刷新行为。 |
| Scheduler 与手动执行事实写入分叉 | Event/Attempt/Artifact 对账失败 | 对比手动 execute、tick、run 的事件和 NodeAttempt。 |
| Gate reject 返工覆盖旧产物 | 审计和版本链断裂 | 检查旧 Artifact 仍存在，新 Artifact 有 `supersedes_artifact_id`。 |
| Adapter fallback 与 dry-run routing 不一致 | 启动前判断和执行时选择不同 | 对比 dry-run `adapter_routing` 与 NodeAttempt receipt 的 `adapter_id`。 |
| task-baseline 与 Git 状态不同步 | 计划页面误导当前进度 | 刷新 `/api/v0/project/roadmap`，核对 HEAD 和 dirty 状态。 |
| fixture 被写入类 smoke 污染 | 后续测试非确定性 | 写入类测试使用临时 workspace，提交前检查 fixture diff。 |

## 11. 最终收口建议

D8 和 D9 完成后，主线程按以下顺序收口：

1. 运行完整命令：`npm run typecheck`、`npm run test`、`npm run build`、`git diff --check`。
2. 执行 API smoke check，写入类接口使用临时 workspace。
3. 执行页面 smoke check，并补齐 `assets/reviews/p4-mvp/` 截图。
4. 更新 `README.md`、`17_文档资产关联与AI阅读导航.md`、`07_后续对接路线图与任务拆解.md`。
5. 更新 `plans/mvp-task-baseline/roadmap.json` 和必要的 task-baseline 说明。
6. 更新 `VERSION_HISTORY.md` 未发布变更。
7. 启动 Sidecar，刷新 `/task-baseline`，确认 Git HEAD、dirty 状态和证据文件状态。
8. 提交 Git，并在最终回复中说明 task-baseline 是否已同步。

## 12. D10 通过标准

D10 可标记通过的最低标准：

1. 完整命令通过：`typecheck`、`test`、`build`、`diff --check`。
2. D8 和 D9 都有实现证据、测试或 smoke 证据。
3. 核心 API smoke 无阻断错误。
4. 核心页面 smoke 无阻断错误。
5. 最新截图证据存在。
6. task-baseline 页面能看到最新 Git 提交和证据文件状态。
7. README、17、07、VERSION_HISTORY、roadmap.json 已由主线程统一更新。
8. 没有把暂不进入 MVP 的真实 Adapter、云端、多租户、移动端能力误写为已完成。
