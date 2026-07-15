# 43_P5-06真实历史Run UI展示验收方案

> 任务状态：P5-06 已完成。
>
> 输入依据：`39_P5-03历史Run只读导入方案.md`、`41_P5-04审核策略映射设计.md`、
> `42_P5-05Trace映射设计.md`、当前 `apps/web` 页面结构、当前 `apps/sidecar`
> API、W24/W23 真实交付包。
>
> 目标：定义真实 historical run 进入 Miracle UI 后的验收口径、页面展示要求、
> API smoke、截图证据要求和实装前置条件。P5-06 不实现 importer，不声称真实 Run
> 已经在 Web 中跑通；它收口的是 UI 展示验收标准。

## 1. 结论

P5-06 的核心结论：

- 当前 Web 已具备承载真实 historical run 的主要页面：任务运行、Attention、智能体、
  产物、审核、事件审计和 task-baseline。
- 当前 Sidecar 已具备主要读取 API：`GET /runs`、`GET /runs/:id`、
  `GET /runs/:id/events`、`GET /agents/collaboration`、`GET /attention`、
  `GET /artifacts`、`GET /gates/:id`。
- 真实历史 Run 展示前必须先由 historical importer 写入 `.miracle/runs/{run_id}` 的
  `run_spec.json`、`workflow_snapshot.json`、`nodes.json`、`attempts.json`、
  `artifacts.json`、`gates.json`、`attention.json`、`events.jsonl` 和
  `source_meta.json`。
- UI 不应把 W24 的 `F_final_render` 显示为 completed；它必须显示为
  `GateInstance · pending_review`，并关联 Attention。
- UI 不应把 W23 显示成完整历史运行；它必须显示为降级样本，提示缺少
  `phase_status.md`、`task_trace.json`、`task_events.jsonl` 和结构化审核记录。
- P5-06 的后续实装入口是 P5-07 Run draft 与 P5-08 Adapter 边界，但真实历史只读展示
  可以先作为 importer 实现任务独立落地。

## 2. 验收范围

| 页面或能力 | 当前是否已有入口 | P5-06 验收对象 | 是否需要 importer 后复测 |
|---|---:|---|---:|
| 首页 | 是 | 能看到 W24 historical run 的继续运行、待处理、系统风险摘要。 | 是 |
| 任务运行 / Run 工作区 | 是 | 能展示 W24 Flow A-G DAG、阶段过滤、节点状态、Node Detail、Event Drawer。 | 是 |
| Attention | 是 | 能展示 F final render 待审、W23 trace 缺口、A/B/G inferred 问题。 | 是 |
| 智能体协同 | 是 | 能展示 Agent 与 NodeRun、Attempt、Artifact 的关联态势。 | 是 |
| 产物 | 是 | 能展示真实 artifact 路径、类型、review_status、媒体不复制提示。 | 是 |
| 审核 | 是 | 能展示 C/D approve、F pending_review、G inferred pending。 | 是 |
| task-baseline | 是 | 能看到 P5-06 完成、P5-07 当前。 | 否 |
| Canvas / Spec Sync / Evolution | 有入口 | P5-06 不验收真实历史展示，只确认不误导用户。 | 否 |

## 3. W24 UI 展示口径

W24 是主样本，应作为“高证据 historical run”展示。

### 3.1 Run Header

| 字段 | 展示值 |
|---|---|
| Run ID | `run-real-2026-W24-codex-claudecode` |
| Workflow | `content-production-real-v0` |
| 模式 | `historical_readonly` |
| 状态 | `running` 或 `reviewing` projection |
| 当前阻塞 | `F_final_render_gate pending_review` |
| 证据等级 | `observed_from_trace / observed_from_event / observed_from_status` 混合 |

Header 必须提示：

```text
Historical read-only：该 Run 来自真实交付包导入，Miracle 未重新执行这些节点。
```

### 3.2 Flow / DAG

| NodeRun | UI 状态 | 展示重点 |
|---|---|---|
| A_fact_intelligence | done / inferred | A 只有产物证据，标记 inferred。 |
| B_md_master | done / inferred | MD 母稿被后续使用，但缺结构化 GateDecision。 |
| C0_script_pool_selection | done | auto-approved，展示脚本池 selected scripts。 |
| C_ppt_storyboard | done / approved | 展示 C GateDecision 与 storyboard artifacts。 |
| D_voiceover_audio | done / approved | 展示 D GateDecision、audio manifest、TTS outputs。 |
| E_visual_video | done | 展示 HyperFrames handoff、lint/inspect 证据。 |
| F_final_render | reviewing | v3 render completed，但 Gate pending_review。 |
| G_distribution_retro | waiting / inferred | 发布包存在，但 external publish 不可显示为正式批准。 |

DAG 验收点：

1. `B -> G` 主链路可展示 MD 发布包草案，不依赖 F 视频通过。
2. `F -> G` 视频增强分支是 optional，F pending 不应阻塞 MD 草案展示。
3. `F_final_render` 节点不能显示绿色完成态，应使用待审核或 reviewing 视觉。
4. A/B/G inferred 节点必须有 source confidence 提示。

### 3.3 Node Detail

Node Detail 必须展示：

- NodeRun status。
- 当前 attempt 和历史 attempts。
- `task_trace.json.steps` 中的 question、answer、duration、tool_calls、issues。
- input/output artifacts。
- source confidence 和 source paths。

F 节点必须展示两个历史 attempt：

| Attempt | 状态 | 说明 |
|---|---|---|
| `F2` | succeeded / historical | v2 render，保留历史。 |
| `F4_FINAL_RENDER_V3` | succeeded / current | v3 render，当前推荐成片，但仍 pending human visual review。 |

### 3.4 Event Drawer / Timeline

Event Drawer 必须支持两种排序：

| 模式 | 排序 |
|---|---|
| 审计顺序 | importer append order / source line |
| 时间线顺序 | `occurred_at` 升序，时间相同按 `source_line` |

验收点：

1. W24 27 条 source event 可展示。
2. 每条事件可看到 `source_path` 和 `source_line`。
3. D approve source line 在 F3 source line 后的问题不应造成 UI 时间线错乱。
4. `phase_approved` 事件关联 GateDecision，但不替代 GateDecision。
5. `phase_pending_review` 事件关联 F Attention。

## 4. Attention 展示验收

### 4.1 W24 Attention

| Attention | 优先级 | 状态 | 展示要求 |
|---|---|---|---|
| `att-real-W24-final-render-review` | P0 | open | 根因是最终渲染等待人工视觉审看。 |
| `att-real-W24-inferred-early-phases` | P2 | open 或 acknowledged | A/B/G 缺标准状态，展示为证据缺口。 |
| `att-real-W24-media-not-copied` | P3 | open 或 acknowledged | 大媒体未复制，仅记录本地路径。 |

`att-real-W24-final-render-review` 必须关联：

- `GateInstance gate-real-W24-F_final_render`
- `ArtifactManifest art-real-W24-render-manifest`
- v3 horizontal/vertical video artifacts
- TraceEvent `phase_pending_review`

安全动作：

| 操作 | UI 文案 | 后续行为 |
|---|---|---|
| 打开审核 | 查看 F final render gate | 跳转 Review page。 |
| 查看产物 | 检查 render_manifest 和本地视频路径 | 跳转 Artifact page。 |
| 标记已知 | 暂不处理 | 只更新 Attention 状态，不改变 Gate。 |

### 4.2 W23 Attention

W23 必须显示为低证据样本：

| Attention | 优先级 | 根因 |
|---|---|---|
| `att-real-W23-control-files-missing` | P1 | 缺 phase_status、task_trace、task_events、approval_decisions。 |
| `att-real-W23-trace-history-missing` | P1 | 不能还原 historical TraceEvent。 |
| `att-real-W23-gate-history-missing` | P2 | 不能生成 GateDecision。 |

UI 不允许把 W23 展示为完整成功 Run。

## 5. Artifact Board 验收

Artifact Board 必须展示真实产物但不复制大媒体。

| Artifact | 类型 | review_status | 展示要求 |
|---|---|---|---|
| MD 母稿 | markdown | approved / inferred | 可预览路径和摘要，标记 inferred。 |
| script_selection_summary | json | approved | 可展示 JSON metadata。 |
| storyboard_manifest | json | approved | 关联 C GateDecision。 |
| audio_manifest | json | approved | 关联 D GateDecision。 |
| render_manifest | json | pending_review | 关联 F pending gate。 |
| v3 MP4 | video | pending_review | 不复制文件，展示本地路径、size、duration、preview capability。 |
| publish_package | publish_package | none / pending_review | 不能显示 external publish approved。 |

大媒体文案：

```text
本地媒体未复制进 Miracle workspace。当前仅记录源路径、hash/mtime、媒体 metadata 和预览能力。
```

## 6. Gate Review 验收

Gate Review 页面必须区分三类状态：

| Gate | 状态 | 决策 | 展示要求 |
|---|---|---|---|
| C_ppt_storyboard | decided | approve | 展示 `approval_decisions.jsonl:1` 和相关 TraceEvent。 |
| D_voiceover_audio | decided | approve | 展示 `approval_decisions.jsonl:2`，并提示 evidence_files 为空但决策有效。 |
| F_final_render | pending_review | 无 | 展示 render_manifest、phase_pending_review、恢复动作。 |
| B_md_master | decided projection | 无 | 标记 inferred，不生成 GateDecision。 |
| G_distribution | pending/inferred | 无 | 缺结构化发布门决策，不允许显示正式发布批准。 |

F gate 的可用动作：

- approve
- request_changes
- reject
- 查看 render manifest
- 查看本地视频路径

P5-06 不要求实际点击动作落库；那属于 importer 后的 P5 后续实现验收。

## 7. Agent Collaboration 验收

Agent Collaboration 必须能把 W24 节点投影到 Agent 视角。

| Agent | 应展示内容 |
|---|---|
| script-agent | C0 script pool auto-approved、selected scripts。 |
| ppt-agent | C storyboard drafts、C approval。 |
| tts-agent | D timeline、TTS batch、D approval。 |
| video-agent | E bridge、F render、F pending review。 |
| review-agent | C/D/F gates、F Attention。 |
| distribution-agent | G publish package draft 和 inferred gate。 |

验收点：

1. Agent 可有多个 historical attempts，不被建模成一次只能执行一个任务。
2. video-agent 当前状态应显示 waiting/reviewing，而不是 done。
3. review-agent 应关联 F pending review。
4. Agent card 应能展开查看输入、输出、等待对象和 source confidence。

## 8. API Smoke 方案

historical importer 实现后，P5-06 smoke 应至少覆盖：

```bash
curl -s http://127.0.0.1:4317/api/v0/runs | jq '.runs[] | select(.run_id=="run-real-2026-W24-codex-claudecode")'
curl -s http://127.0.0.1:4317/api/v0/runs/run-real-2026-W24-codex-claudecode | jq '.run.run_id, (.nodes | length), (.artifacts | length), (.gates | length)'
curl -s http://127.0.0.1:4317/api/v0/runs/run-real-2026-W24-codex-claudecode/events | jq 'length'
curl -s 'http://127.0.0.1:4317/api/v0/attention?runId=run-real-2026-W24-codex-claudecode' | jq '.attention[] | select(.attention_id=="att-real-W24-final-render-review")'
curl -s 'http://127.0.0.1:4317/api/v0/gates/gate-real-W24-F_final_render?runId=run-real-2026-W24-codex-claudecode' | jq '.gate.status, .target_artifact.review_status'
curl -s 'http://127.0.0.1:4317/api/v0/artifacts/art-real-W24-render-manifest?runId=run-real-2026-W24-codex-claudecode' | jq '.artifact.review_status'
curl -s http://127.0.0.1:4317/api/v0/agents/collaboration | jq '.agents | length'
curl -s http://127.0.0.1:4317/api/v0/project/roadmap | jq '.current_node_id'
```

当前限制：

- 这些 smoke 需要 importer 先写入真实 `run-real-*` 数据。
- 当前 P5-06 不要求执行这些 curl，因为真实 run fixture 尚未生成。

## 9. 截图证据要求

P5-06 后续实装验收时，截图统一放入：

```text
assets/reviews/p5-real-run-ui/
```

建议文件：

| 文件 | 内容 |
|---|---|
| `w24-home.png` | 首页看到 W24 historical run 和 F pending attention。 |
| `w24-run-dag.png` | Flow A-G DAG，F pending，B->G 主链路可见。 |
| `w24-run-events.png` | Event Drawer 展示 source line 和 occurred_at。 |
| `w24-attention.png` | F final render pending review 根因卡。 |
| `w24-artifacts.png` | render_manifest、video artifact、本地路径提示。 |
| `w24-gate-review.png` | F gate pending review 抽屉。 |
| `w24-agent-collaboration.png` | video-agent/review-agent 等待审核态。 |
| `w23-gap-attention.png` | W23 缺控制文件和缺 trace 降级提示。 |
| `task-baseline-p5-07.png` | P5-06 完成后 task-baseline 当前红点推进到 P5-07。 |

## 10. 当前 UI 与后续差距

| 差距 | 当前状态 | 后续任务 |
|---|---|---|
| historical importer 未实现 | 只有映射方案，无真实 run-real fixture | P5 后续 importer 实装。 |
| Run selector 默认仍指向 demo run | Web 默认 `run-demo-001` | importer 后增加 historical run 入口或筛选。 |
| Event Drawer 事件类型 map 未覆盖 P5 source events | 当前 map 覆盖 P4 runner/gate/scheduler 事件 | 增加 P5 TraceEvent label。 |
| Artifact preview 未针对外部本地路径做专门 UI | 当前展示 fixture artifact | 增加 local-only media metadata UI。 |
| Agent collaboration 仍读取通用 agents fixture | 尚未按 historical run 投影 agent activity | importer 或 projection API 补齐。 |

这些差距不阻断 P5-06 文档验收，但必须进入后续实现 backlog。

## 11. P5-07 输入

P5-07 半自动新 Run 草案应基于本文件继续：

1. 为 `content-production-real-v0` 设计 Run draft 创建入口。
2. Dry-run 必须显示真实工作流所需凭证、审核门、可选视频分支和风险。
3. 不调用真实 Runner；只生成 Run draft、WorkflowSnapshot 草案和人工确认门。
4. UI 应复用 P5-06 的 W24 展示口径，避免历史只读 Run 与新 Run 草案混淆。

## 12. 验收结果

| 验收项 | 结果 |
|---|---|
| W24 Run Header 展示口径明确 | 通过 |
| Flow A-G DAG 展示口径明确 | 通过 |
| Node Detail 和 Event Drawer 展示口径明确 | 通过 |
| Attention、Artifact、Gate、Agent 展示口径明确 | 通过 |
| W23 缺控制文件降级展示明确 | 通过 |
| API smoke 和截图证据要求明确 | 通过 |
| 明确当前未实装 importer，不声称真实 run 已跑通 | 通过 |
| task-baseline 可推进到 P5-07 | 通过 |
