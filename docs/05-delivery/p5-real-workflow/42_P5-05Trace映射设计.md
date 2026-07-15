# 42_P5-05Trace映射设计

> 任务状态：P5-05 已完成。
>
> 输入依据：W24 `task_trace.json`、W24 `task_events.jsonl`、W24 `phase_status.md`、
> W24 `approval_decisions.jsonl`、`38_P5-02FlowAG对象映射设计.md`、
> `39_P5-03历史Run只读导入方案.md`、`41_P5-04审核策略映射设计.md`。
>
> 目标：定义真实 historical run 的 Trace 映射规则，明确 `task_trace.json.steps`
> 到 NodeAttempt projection 的字段映射、`task_events.jsonl` 到 TraceEvent 的事件映射、
> 缺失证据时的 source metadata 与 Attention 规则，并保持 Orchestrator 单写入边界。

## 1. 结论

P5-05 的核心结论：

- `task_trace.json` 是 W24 的结构化运行摘要来源，主要生成 `RunSpec` projection、
  `NodeAttempt` projection、Artifact 引用、工具调用摘要和问题记录。
- `task_events.jsonl` 是 W24 的结构化事件来源，逐行转换为 Miracle `TraceEvent`，
  并保留 `source_line`、原始 payload 和来源路径。
- `approval_decisions.jsonl` 仍是 `GateDecision` 的结构化来源；`task_events.jsonl`
  中的 `phase_approved` 只能生成 TraceEvent，不能替代 GateDecision。
- `phase_status.md` 仍负责阶段状态 projection；`task_events.jsonl` 只负责事件事实，
  不直接覆盖 NodeRun/Gate/Artifact 的最终状态。
- W24 `task_events.jsonl` 同时存在 `event`/`ts` 和 `event_type`/`timestamp` 两种格式，
  importer 必须兼容并规范化为统一 TraceEvent。
- W24 source line 顺序不完全等于时间顺序，例如 D 阶段 approve 事件写在 F3 bridge
  事件之后。Miracle 必须保留 source line，同时允许 UI 按 `occurred_at` 展示时间线。
- W23 缺少 `task_trace.json` 和 `task_events.jsonl`，不能重建 historical TraceEvent；
  只能写 importer 审计事件、缺口事件、source_meta gaps 和 Attention。

## 2. 源文件分工

| 文件 | Miracle 作用 | 是否生成运行事实 | 说明 |
|---|---|---:|---|
| W24 `task_trace.json` | Run 摘要、NodeAttempt projection、Artifact 引用、tool calls、issues | 是，限 trace projection | 不代表 Miracle 重新执行，只是历史摘要导入。 |
| W24 `task_events.jsonl` | TraceEvent | 是 | 每行结构化事件都应镜像为 `source_event_mirrored` 或规范化事件。 |
| W24 `phase_status.md` | NodeRun/Gate/Artifact status projection | 是，限状态 projection | 状态真相不由事件日志直接覆盖。 |
| W24 `approval_decisions.jsonl` | GateDecision | 是 | P5-04 已定义，P5-05 只做 TraceEvent 关联。 |
| W24 `approval_log.md` | 人读 evidence note | 辅助 | 不单独生成 TraceEvent 或 GateDecision。 |
| W23 控制文件缺失 | import gap、Attention、source_meta gaps | 否 | 不伪造缺失 TraceEvent。 |

## 3. TraceEvent 最小结构

P5 historical importer 建议将源事件转换为如下最小结构，后续可扩展但不破坏 P4 Event
Journal 边界。

```json
{
  "event_id": "evt-real-W24-000019-phase-approved-c-ppt-storyboard",
  "type": "gate_decision_observed",
  "run_id": "run-real-2026-W24-codex-claudecode",
  "occurred_at": "2026-06-11T17:04:49+0800",
  "imported_at": "2026-07-09T00:00:00+08:00",
  "source": "historical-run-importer",
  "source_path": "00_任务控制/task_events.jsonl",
  "source_line": 19,
  "subject": {
    "type": "GateInstance",
    "id": "gate-real-W24-C_ppt_storyboard"
  },
  "node_run_id": "nr-real-W24-C_ppt_storyboard",
  "node_attempt_id": null,
  "gate_instance_id": "gate-real-W24-C_ppt_storyboard",
  "artifact_ids": ["art-real-W24-storyboard-manifest"],
  "status": "approved",
  "summary": "C_ppt_storyboard approve by user: 分镜草案通过，允许进入 TTS timeline 适配。",
  "source_payload": {
    "event": "phase_approved",
    "step_id": "C_ppt_storyboard",
    "status": "approved"
  },
  "confidence": "observed_from_event"
}
```

字段规则：

| 字段 | 规则 |
|---|---|
| `event_id` | 稳定生成：`evt-real-W24-{source_line}-{normalized_type}-{slug}`。 |
| `type` | 使用 Miracle 规范化事件类型，不直接暴露所有源 event 名。 |
| `occurred_at` | 源事件的 `ts` 或 `timestamp`；缺失时使用 importer 时间并写 warning。 |
| `imported_at` | importer 写入 Miracle workspace 的时间。 |
| `source_line` | JSONL 行号，从 1 开始。必须保留，便于审计。 |
| `subject` | 事件主对象：NodeRun、NodeAttempt、GateInstance、ArtifactManifest、Run 或 ProjectTask。 |
| `source_payload` | 保留原始 JSON 行，避免丢失特有字段。 |
| `confidence` | 源事件统一为 `observed_from_event`；缺口事件为 `import_gap_detected`。 |

## 4. task_events.jsonl 格式兼容

W24 事件有两种格式：

| 格式 | 时间字段 | 事件字段 | 示例 |
|---|---|---|---|
| legacy event | `ts` | `event` | `step_start`、`step_end`、`phase_approved` |
| newer event | `timestamp` | `event_type` | `final_render_completed`、`phase_pending_review` |

规范化规则：

```json
{
  "occurred_at": "source.ts || source.timestamp",
  "source_event_type": "source.event || source.event_type",
  "source_step_id": "source.step_id || source.task_id || source.phase",
  "source_status": "source.status || null"
}
```

校验规则：

1. 每行必须是合法 JSON；非法行不进入 TraceEvent，写 `import_warning`。
2. `occurred_at` 缺失时仍可导入，但必须写 `source_meta.time_missing=true`。
3. `source_event_type` 缺失时导入为 `unknown_source_event`。
4. 原始字段必须完整保留在 `source_payload`。
5. source line 顺序用于审计，UI 时间线可按 `occurred_at` 排序。

## 5. 事件类型映射

| source event | Miracle TraceEvent.type | subject | 关联对象 | 说明 |
|---|---|---|---|---|
| `step_start` | `node_attempt_started` | NodeAttempt | NodeRun、Agent | 源 payload 只有开始摘要时，NodeAttempt 可由 step_id 关联。 |
| `step_end` | `node_attempt_succeeded` | NodeAttempt | NodeRun、ArtifactManifest | status 为 `done` 时映射为 succeeded。 |
| `issue` | `node_attempt_issue_logged` | NodeAttempt | NodeRun、Attention 可选 | status=`fixed` 表示历史问题已修复，不自动生成 open Attention。 |
| `review_approved` | `source_review_note_observed` | GateInstance 或 NodeRun | D gate 可选关联 | 只表示源事件中的审核说明，不生成 GateDecision。 |
| `render_done` | `artifact_render_completed` | ArtifactManifest | F NodeRun | 保留 `format` 和 `duration_ms`。 |
| `validation_done` | `artifact_validation_completed` | ArtifactManifest 或 NodeAttempt | F NodeRun | ffprobe/JSON 校验通过记录。 |
| `selection_done` | `artifact_selection_completed` | ArtifactManifest | C0 NodeRun | 脚本池 selection 摘要。 |
| `c0_runner_validation` | `node_auto_review_completed` | NodeRun | C0 ArtifactManifest | auto-approved 进入 Artifact review projection，不生成 GateDecision。 |
| `storyboard_adapter_done` | `artifact_generated_pending_review` | ArtifactManifest | C GateInstance | 生成分镜草案并等待审核。 |
| `phase_approved` | `gate_decision_observed` | GateInstance | GateDecision、ArtifactManifest | 只关联 GateDecision，不替代 GateDecision。 |
| `timeline_adapter_done` | `artifact_generated_pending_review` | ArtifactManifest | D GateInstance | D_voiceover_audio 进入 pending review。 |
| `tts_batch_generated` | `artifact_generated_pending_review` | ArtifactManifest | D NodeRun/Gate | 音频生成完成但仍待听审。 |
| `hyperframes_bridge_done` | `node_attempt_succeeded` | NodeAttempt | E NodeRun、handoff artifacts | D 已批准后的桥接验证完成。 |
| `final_render_completed` | `artifact_render_completed` | ArtifactManifest | F NodeRun、render manifest | 只表示渲染完成，不表示发布批准。 |
| `phase_pending_review` | `gate_pending_review_observed` | GateInstance | Attention、ArtifactManifest | F final render 等待人工视觉审看。 |
| `project_task_completed` | `source_project_task_completed` | ProjectTask | Run | P031/P032 是源项目工程任务，不进入 Flow A-G 状态机。 |

## 6. task_trace.json 到 NodeAttempt

`task_trace.json.steps` 生成 `NodeAttempt` projection，不直接写 TraceEvent。TraceEvent 仍以
`task_events.jsonl` 为来源。

NodeAttempt 最小结构：

```json
{
  "attempt_id": "attempt-real-W24-F4_FINAL_RENDER_V3",
  "node_run_id": "nr-real-W24-F_final_render",
  "source_step_id": "F4_FINAL_RENDER_V3",
  "status": "succeeded",
  "source_status": "done_pending_human_visual_review",
  "started_at": null,
  "ended_at": null,
  "duration_ms": 780000,
  "agent": "音画整合 Agent / 视频 Agent",
  "inputs": ["04_PPT视频/HyperFrames工程/index.html"],
  "outputs": ["04_PPT视频/render_manifest.json"],
  "tool_calls_summary": ["npx --yes hyperframes@0.6.72 render ..."],
  "issues": ["non_blocking: timeline_track_too_dense"],
  "confidence": "observed_from_trace"
}
```

字段映射：

| task_trace 字段 | NodeAttempt 字段 | 规则 |
|---|---|---|
| `steps[].id` | `attempt_id`、`source_step_id` | `attempt_id` 增加 `attempt-real-W24-` 前缀。 |
| `steps[].phase` | `source_phase` | 保留中文 phase，用于 UI hover/detail。 |
| `steps[].agent` | `agent_label` 或 `agent_id` projection | 可映射到 P5-02 AgentSpec。 |
| `steps[].status` | `status` + `source_status` | 核心枚举只用 succeeded/failed/unknown，源状态完整保留。 |
| `steps[].duration_sec` | `duration_ms` | 秒转毫秒。 |
| `steps[].question/answer` | `summary`、`result_summary` | 进入 Node Detail，不进入隐藏推理。 |
| `steps[].inputs` | `input_artifact_refs` | 解析到 ArtifactManifest；无法解析时保留 source path。 |
| `steps[].outputs` | `output_artifact_refs` | 解析到 ArtifactManifest；大媒体只记录路径 metadata。 |
| `steps[].tool_calls` | `tool_calls_summary` | 只存命令摘要，不读取凭证、不记录隐藏推理。 |
| `steps[].issues` | `issues` | `non_blocking` 不自动创建 open Attention。 |

## 7. NodeAttempt 状态映射

| source status | NodeAttempt.status | NodeRun/Gate/Artifact 补充规则 |
|---|---|---|
| `done` | `succeeded` | NodeRun 可由 phase_status 或最新 attempt 投影为 done。 |
| `auto-approved` | `succeeded` | Artifact review_status 映射为 approved，source status 保留。 |
| `approved` | `succeeded` | GateDecision 仍只来自 `approval_decisions.jsonl`。 |
| `done_pending_human_visual_review` | `succeeded` | GateInstance/ArtifactManifest 必须保持 pending_review。 |
| `done_pending_tts_review` | `succeeded` | D gate/Artifact 可进入 pending_review。 |
| `generated_pending_human_audio_review` | `succeeded` | 音频产物 created，D gate 仍待人工听审直到 approval decision。 |
| `approved_ready_for_final_render` | `succeeded` | E/F 下游可继续，但不代表 F 发布批准。 |
| `failed` | `failed` | 后续真实样本若出现，生成 Attention。 |
| 其他未知状态 | `unknown` | 写 import_warning，保留 `source_status`。 |

关键限制：

- `pending_review` 语义不进入 `NodeAttempt.status`，而由 GateInstance 和 ArtifactManifest
  承载。
- `done_pending_*` 表示工具执行成功但后续审核未完成，不应被映射为 failed。
- 旧版 v2 render attempt 和新版 v3 render attempt 都应保留；NodeRun 当前展示以 v3 和
  `phase_status.md` 为准。

## 8. W24 steps 到 NodeRun 映射

| step id | NodeRun | attempt 语义 | 是否当前版本 | 说明 |
|---|---|---|---:|---|
| `D1` | `nr-real-W24-D_voiceover_audio` | legacy timeline adaptation | 否 | 旧 timeline 适配，保留为历史 attempt。 |
| `D2` | `nr-real-W24-D_voiceover_audio` | legacy TTS batch | 否 | 旧 23 scene TTS，保留为历史 attempt。 |
| `F1` | `nr-real-W24-E_visual_video` | legacy HyperFrames bridge | 否 | 旧 bridge，含已修复 issue。 |
| `F2` | `nr-real-W24-F_final_render` | v2 final render | 否 | v2 审看成片，保留为历史 attempt。 |
| `C0_TRIAL` | `nr-real-W24-C0_script_pool_selection` | script pool validation | 是 | C0 auto-approved。 |
| `C_STORYBOARD_ADAPTER` | `nr-real-W24-C_ppt_storyboard` | storyboard draft generation | 是 | 草案生成后进入 C gate。 |
| `C_APPROVAL` | `nr-real-W24-C_ppt_storyboard` | review audit attempt | 是 | 记录审核操作摘要，GateDecision 另由 approval_decisions 生成。 |
| `P030_DRAFT_TIMELINE` | `nr-real-W24-D_voiceover_audio` | current timeline adaptation | 是 | 新版 19 scene timeline。 |
| `D3_TTS_BATCH_19_SCENES` | `nr-real-W24-D_voiceover_audio` | current TTS batch | 是 | 新版 19 scene TTS，待听审后获批。 |
| `F3_HYPERFRAMES_BRIDGE_19_SCENES` | `nr-real-W24-E_visual_video` | current HyperFrames bridge | 是 | D 已批准后的桥接验证。 |
| `F4_FINAL_RENDER_V3` | `nr-real-W24-F_final_render` | current final render | 是 | v3 成片，仍 pending human visual review。 |

Current version 规则：

1. 同一 NodeRun 可有多个 historical NodeAttempt。
2. `source_meta.current_attempt_id` 指向当前版本 attempt，例如 F 指向 `F4_FINAL_RENDER_V3`。
3. UI Timeline 可展示全部 attempts；Run DAG 状态以 `phase_status.md` 和当前 attempt 共同投影。
4. 旧 attempt 不删除、不覆盖，避免丢失历史返工路径。

## 9. W24 task_events 逐类导入统计

W24 `task_events.jsonl` 当前共 27 行，事件类型统计如下：

| source event | 行数 | P5-05 处理 |
|---|---:|---|
| `step_start` | 5 | 导入为 attempt start 事件。 |
| `step_end` | 3 | 导入为 attempt succeeded 事件。 |
| `issue` | 2 | 导入为 historical issue 事件，status=fixed 不开新 Attention。 |
| `review_approved` | 1 | 导入为 source review note，不生成 GateDecision。 |
| `render_done` | 2 | 导入为 render artifact 事件。 |
| `validation_done` | 2 | 导入为 validation 事件。 |
| `selection_done` | 1 | 导入为 C0 selection 事件。 |
| `c0_runner_validation` | 1 | 导入为 auto review completed。 |
| `storyboard_adapter_done` | 1 | 导入为 storyboard generated pending review。 |
| `phase_approved` | 2 | 导入为 gate decision observed，关联 GateDecision。 |
| `timeline_adapter_done` | 1 | 导入为 timeline artifact generated。 |
| `tts_batch_generated` | 1 | 导入为 audio generated pending review。 |
| `hyperframes_bridge_done` | 1 | 导入为 bridge succeeded。 |
| `final_render_completed` | 1 | 导入为 final render completed。 |
| `phase_pending_review` | 1 | 导入为 gate pending review observed，并关联 Attention。 |
| `project_task_completed` | 2 | 导入为 source project task completed。 |

## 10. GateDecision 与 TraceEvent 关联

P5-04 已规定 GateDecision 只从 `approval_decisions.jsonl` 生成。P5-05 只补充关联规则。

| TraceEvent | GateDecision | 关联方式 |
|---|---|---|
| `phase_approved` C | `gd-real-W24-C_ppt_storyboard-20260611T170449` | phase=`C_ppt_storyboard`、时间相同、status=approved。 |
| `phase_approved` D | `gd-real-W24-D_voiceover_audio-20260612T095653` | phase=`D_voiceover_audio`、时间相同、status=approved。 |
| `phase_pending_review` F | 无 | 只关联 `gate-real-W24-F_final_render` 和 Attention。 |
| `review_approved` D2 | 无 | 早期 source review note，不作为结构化 GateDecision。 |

规则：

1. TraceEvent 可引用 `gate_decision_id`，但不能创建或修改 GateDecision。
2. GateDecision 可在 `source_meta.related_trace_event_ids` 中反向记录相关事件。
3. `phase_pending_review` 永远不生成 GateDecision。
4. `review_approved` 只有在 `approval_decisions.jsonl` 有对应行时才可关联为辅助事件。

## 11. F_final_render Trace 与 Attention

F final render 有两条关键事件：

```json
{
  "timestamp": "2026-06-12T10:52:45+08:00",
  "event_type": "final_render_completed",
  "phase": "F_final_render",
  "version": "v3"
}
```

```json
{
  "timestamp": "2026-06-12T10:52:45+08:00",
  "event_type": "phase_pending_review",
  "phase": "F_final_render",
  "reason": "waiting_human_visual_review",
  "manifest": "04_PPT视频/render_manifest.json"
}
```

Miracle 映射：

| 对象 | 结果 |
|---|---|
| TraceEvent 1 | `artifact_render_completed`，关联 `art-real-W24-render-manifest`、v3 video artifacts。 |
| TraceEvent 2 | `gate_pending_review_observed`，关联 `gate-real-W24-F_final_render`。 |
| Attention | `att-real-W24-final-render-review` 保持 open。 |
| GateDecision | 不生成。 |
| RunSpec.status | 仍可为 `running` 或 `reviewing` projection，不可标记 completed。 |

## 12. W23 降级 Trace 规则

W23 缺少：

- `phase_status.md`
- `approval_log.md`
- `approval_decisions.jsonl`
- `task_trace.json`
- `task_events.jsonl`

因此：

| 对象 | W23 规则 |
|---|---|
| NodeAttempt | 不从文件存在重建；可只生成 `not_observed` source_meta。 |
| TraceEvent | 不生成 historical source event。 |
| events.jsonl | 只写 `import_started`、`import_gap_detected`、`import_completed`。 |
| source_meta.gaps | 记录 `task_trace_missing`、`task_events_missing`。 |
| Attention | 生成 `att-real-W23-control-files-missing` 和 `att-real-W23-trace-history-missing`。 |

W23 importer 示例事件：

```json
{
  "event_id": "evt-import-gap-W23-trace-missing",
  "type": "import_gap_detected",
  "run_id": "run-real-2026-W23-codex-claudecode",
  "occurred_at": "2026-07-09T00:00:00+08:00",
  "subject": {
    "type": "Run",
    "id": "run-real-2026-W23-codex-claudecode"
  },
  "summary": "task_trace.json and task_events.jsonl are missing; historical TraceEvent was not reconstructed.",
  "confidence": "import_gap_detected"
}
```

## 13. source_meta 扩展

P5-05 建议在 `source_meta.json` 中加入 trace 级索引。

```json
{
  "trace_sources": {
    "task_trace": {
      "source_path": "00_任务控制/task_trace.json",
      "schema_version": 1,
      "steps_count": 11,
      "confidence": "observed_from_trace"
    },
    "task_events": {
      "source_path": "00_任务控制/task_events.jsonl",
      "events_count": 27,
      "format_variants": ["event_ts", "event_type_timestamp"],
      "confidence": "observed_from_event"
    }
  },
  "objects": {
    "attempt-real-W24-F4_FINAL_RENDER_V3": {
      "object_type": "NodeAttempt",
      "source_paths": ["00_任务控制/task_trace.json:steps[10]"],
      "confidence": "observed_from_trace",
      "current_attempt_for": "nr-real-W24-F_final_render"
    },
    "evt-real-W24-000025-phase-pending-review": {
      "object_type": "TraceEvent",
      "source_paths": ["00_任务控制/task_events.jsonl:25"],
      "confidence": "observed_from_event",
      "related_attention_id": "att-real-W24-final-render-review"
    }
  },
  "gaps": []
}
```

W23 source_meta gaps：

```json
{
  "gaps": [
    {
      "code": "task_trace_missing",
      "severity": "warning",
      "message": "task_trace.json missing; NodeAttempt history was not reconstructed."
    },
    {
      "code": "task_events_missing",
      "severity": "warning",
      "message": "task_events.jsonl missing; historical TraceEvent was not reconstructed."
    }
  ]
}
```

## 14. Importer 写入顺序

W24 `events.jsonl` 建议写入顺序：

1. `import_started`
2. `source_file_scanned` for `task_trace.json`
3. `source_file_scanned` for `task_events.jsonl`
4. 按 source line 顺序写入 27 条 mirrored TraceEvent
5. `import_warning`，如发现时间顺序与 source line 顺序不一致
6. `import_completed`

时间线展示顺序：

| 场景 | 排序规则 |
|---|---|
| Event Journal 审计 | append order，保持 importer 写入顺序。 |
| UI Timeline | `occurred_at` 升序，时间相同再按 `source_line`。 |
| Source Debug | `source_path + source_line`。 |

这能同时满足审计可追溯和用户按时间理解流程。

## 15. Importer 校验规则

P5 后续 importer 实现 Trace 映射时必须校验：

1. `task_trace.json` 是合法 JSON，`schema_version` 存在。
2. `task_trace.json.steps` 是数组；每个 step 必须有 `id`、`phase`、`status`。
3. 每个 step 生成的 `node_run_id` 必须能映射到 P5-02 的 NodeSpec。
4. `task_events.jsonl` 每行必须独立解析；失败行写 `import_warning`，不终止整个导入。
5. TraceEvent 必须保留 `source_path` 和 `source_line`。
6. `phase_approved` 只能关联 GateDecision，不能生成 GateDecision。
7. `phase_pending_review` 必须关联 Attention，不能生成 GateDecision。
8. 文件存在推断不得写入 TraceEvent。
9. W23 缺 trace 时必须生成 gap 和 Attention。
10. 大媒体路径可进入 ArtifactManifest metadata，但不得复制进 Miracle fixture。

## 16. P5-06 输入

P5-06 UI 展示验收应基于本文件验证：

- Run Timeline 能展示 W24 的 27 条 source event 及 importer audit events。
- Node Detail 能展示来自 `task_trace.json.steps` 的 NodeAttempt、tool calls、inputs、outputs 和 issues。
- Gate 抽屉能展示 C/D approve 的相关 TraceEvent，但 GateDecision 来源仍指向
  `approval_decisions.jsonl`。
- Attention 能展示 F final render pending review 的 `phase_pending_review` 证据。
- W23 UI 能展示 trace 缺失缺口，而不是空白或伪造完成。
- 若 UI 按时间排序，应能处理 D approve source line 在 F3 source line 之后的问题。

## 17. 验收结果

| 验收项 | 结果 |
|---|---|
| `task_trace.json.steps` 到 NodeAttempt 的字段映射明确 | 通过 |
| `task_events.jsonl` 到 TraceEvent 的事件类型映射明确 | 通过 |
| `event/ts` 与 `event_type/timestamp` 双格式兼容规则明确 | 通过 |
| GateDecision 与 TraceEvent 的边界明确 | 通过 |
| F_final_render pending review 的 Trace/Attention 映射明确 | 通过 |
| W23 缺 trace 降级规则明确 | 通过 |
| 不伪造缺失 TraceEvent | 通过 |
| task-baseline 可推进到 P5-06 | 通过 |
