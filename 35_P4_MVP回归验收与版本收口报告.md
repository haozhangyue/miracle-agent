# 35_P4_MVP回归验收与版本收口报告

> 文档状态：D10 MVP 回归验收通过。
>
> 验收日期：2026-07-02
>
> 适用版本：`v0.7.0`
>
> 验收范围：P4 MVP 本地 Web + Local Sidecar + core + fixture workspace。

## 1. 结论

D10 MVP 回归验收通过。Miracle 当前具备一条可运行、可演示、可回归的本地 Agent OS 主链路：

```text
WorkflowSpec / Registry / AdapterManifest
-> Validate / Dry-run / POST Run
-> Run DAG / Node Detail / Artifact / Gate / Attention
-> 手动执行 / Scheduler tick / Scheduler run
-> Gate 审核 / Reject 返工 / 新版本审核
-> Canvas NodeSpec draft / Workflow draft
-> task-baseline / 版本记录 / 截图证据
```

本轮验收中发现并修复两个 Web 回归：

1. Dry-run 页面错误使用 GET 请求 `/workflows/:id/dry-run`，已改为 POST。
2. Canvas 生成 NodeSpec draft 前先保存草稿，可能在空状态下覆盖服务端 layout，已改为随节点生成请求携带当前 `objects`，并增加空画布保护。

## 2. 命令验收

在仓库根目录执行并通过：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run test` | 通过，Sidecar 22 tests，Core 6 tests，Web no test files |
| `npm run build` | 通过 |
| `git diff --check` | 通过 |

## 3. API Smoke

只读 API 使用 `http://127.0.0.1:4317`，写入类 API 使用临时 workspace 和 `http://127.0.0.1:4327`，避免污染 fixture。

只读 smoke 覆盖 20 个端点，包括：

- `/api/v0/health`
- `/api/v0/project/roadmap`
- `/api/v0/domains`
- `/api/v0/roles`
- `/api/v0/registry/templates`
- `/api/v0/adapters`
- `/api/v0/workflows`
- `/api/v0/workflows/content-production-v0`
- `/api/v0/workflows/content-production-v0/validate`
- `/api/v0/workflows/content-production-v0/dry-run`
- `/api/v0/runs`
- `/api/v0/runs/run-demo-001`
- `/api/v0/runs/run-demo-001/dag`
- `/api/v0/runs/run-demo-001/events`
- `/api/v0/agents/health`
- `/api/v0/agents/collaboration`
- `/api/v0/attention`
- `/api/v0/artifacts`
- `/api/v0/artifacts/art_md_master_v2?run_id=run-demo-001`
- `/api/v0/gates/gate-md-master-001?run_id=run-demo-001`

写入 smoke 覆盖：

| 能力 | 结果 |
|---|---|
| `POST /runs` | 创建临时 Run 成功 |
| `POST /runs/:runId/nodes/:nodeRunId/execute` | AdapterResult `succeeded` |
| `POST /runs/:runId/scheduler/tick` | dry-run 返回 `dry_run` |
| `POST /runs/:runId/scheduler/run` | 连续推进停在 `paused_for_gate` |
| `POST /workflows/:workflowId/canvas-draft/nodes` | NodeSpec draft `ready` |
| `POST /workflows/:workflowId/canvas-draft/publish` | draft Workflow validate 通过 |
| `POST /gates/:gateId/decision` | reject 决策写入成功 |
| `POST /gates/:gateId/rework` | 返工 version 2 和新 Gate 创建成功 |

## 4. 页面 Smoke 与截图证据

截图统一放在 `assets/reviews/p4-mvp/`。

| 页面 | 截图 | 验收点 |
|---|---|---|
| 首页 | `assets/reviews/p4-mvp/01-home.png` | Attention、继续运行、最近交付、系统风险可见 |
| 新任务 | `assets/reviews/p4-mvp/02-new-task.png` | 多 Domain、多模板入口可见 |
| Dry-run | `assets/reviews/p4-mvp/03-dry-run.png` | POST dry-run 返回节点、风险和成本 |
| Run 工作区 | `assets/reviews/p4-mvp/04-run-dag-node-detail.png` | React Flow DAG、Node Detail、Polling、事件审计可见 |
| Attention | `assets/reviews/p4-mvp/05-attention.png` | 根因聚合、关联对象和安全动作可见 |
| Gate Review | `assets/reviews/p4-mvp/06-gate-review.png` | Gate 详情、决策投影、下游影响可见 |
| Artifact Board | `assets/reviews/p4-mvp/07-artifact-preview.png` | ArtifactManifest、Markdown 预览、hash/version 可见 |
| Agent Collaboration | `assets/reviews/p4-mvp/08-agent-collaboration.png` | Agent 状态、等待对象和 active run 可见 |
| Infinite Canvas | `assets/reviews/p4-mvp/09-canvas-node-draft.png` | NodeSpec draft、validate-ready、spec diff 可见 |
| task-baseline | `assets/reviews/p4-mvp/10-task-baseline.png` | 任务基线、Git 状态、证据文件列表可见 |

## 5. D10 修复项

### 5.1 Dry-run 请求方法

问题：Web Dry-run 页面通过 GET 请求 dry-run，Sidecar 只定义 POST。

修复：`DryRunPage` 改为独立 POST 加载逻辑，不再复用 GET-only `useApi`。

### 5.2 Canvas NodeSpec Draft 状态保护

问题：生成 NodeSpec draft 前先保存草稿，若本地 `objects` 为空，会把服务端草稿覆盖为空。

修复：

- UI 生成节点时直接携带当前 `objects`。
- UI 对空画布增加保护，不执行生成。
- Sidecar `canvas-draft/nodes` 支持使用请求中的 `objects` 作为合并基线。
- Sidecar 测试补充“未保存 layout + 新增节点”场景，确认 layout 变更不会丢失。

## 6. 不进入本次验收的能力

以下能力仍不作为 v0.7.0 阻断项：

1. 真实 Codex / Hermes / OpenClaw / 官方 API 执行。
2. 商业化云端控制平面。
3. 多租户、账号、组织、权限、计费。
4. 后台常驻 scheduler、跨 Run 队列和 Worker 池。
5. 完整 Visual/Spec 文件 watcher、冲突合并和 Evolution 推荐算法。
6. 移动端 / APP 适配。
7. 真实 TTS、视频渲染和外部媒体服务调用。

## 7. 后续建议

下一阶段建议进入 P5 真实工作流接入：

1. 接入“热点工具更新”真实 Flow A-G 历史 Run。
2. 将现有 `approval_policy.yaml`、`task_trace.json`、`task_events.jsonl` 映射到 Miracle 对象。
3. 先做只读展示，再进入半自动控制。
4. 选择一个真实 Adapter 做最小可用接入，优先 Codex 或官方 API。
