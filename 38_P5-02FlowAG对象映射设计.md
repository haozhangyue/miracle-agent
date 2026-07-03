# 38_P5-02FlowAG对象映射设计

> 任务状态：P5-02 已完成。  
> 输入依据：`37_P5-01真实工作区盘点报告.md`、`approval_policy.yaml`、W24 `task_trace.json`、`task_events.jsonl`、`approval_decisions.jsonl`、`phase_status.md`、`render_manifest.json`。  
> 目标：把“热点工具更新”真实 Flow A-G 映射为 Miracle 通用对象，不把内容生产样本硬编码进核心模型。

## 1. 映射结论

P5 真实工作流的 WorkflowSpec 建议命名为 `content-production-real-v0`，属于 `content-production` Domain，初始 registry 状态为 `experimental`。它不是替代现有 demo `content-production-v0`，而是用于真实历史 Run 导入和后续半自动 Run 的真实模板。

P5-02 的核心结论：

- 真实 Flow A-G 应映射为 8 个 NodeSpec：A、B、C0、C、D、E、F、G。
- C0 脚本池是独立节点，不能合并进 C；它有自己的 auto review 逻辑和下游 routing。
- 审核策略不写入 NodeSpec；NodeSpec 只保留 `review_gate_ref`。
- Gate 真相来自 `ArtifactSpec.review_policy`、`GateSpec`、`GateInstance`、`GateDecision`。
- W24 的 A/B/G 只有产物证据，缺标准 phase status；历史导入时只能标记为 `inferred_from_file`。
- W24 的 C0/C/D/E/F 有状态、事件或 manifest 证据，可作为较高可信度 projection。
- W23 只用于降级验证，不参与首个完整 historical run projection。

## 2. WorkflowSpec 映射

| 字段 | 建议值 |
|---|---|
| id | `content-production-real-v0` |
| name | 热点工具更新真实内容生产 Flow A-G |
| version | `0.1.0` |
| domain | `content-production` |
| category | `media` |
| registry status | `experimental` |
| source | `local_project` |
| main sample | W24 交付包 |
| comparison sample | W23 交付包 |

ProviderPolicy 初始建议：

| 字段 | 值 |
|---|---|
| default_provider | `codex-local` |
| allowed_providers | `codex-local`、`official-api`、`mock-provider` |
| required_credentials | `VOLC_TTS_API_KEY`、`VOLC_TTS_VOICE_TYPE` |
| fallback_providers | `mock-tts`、`manual-upload` |

说明：

- `manual-upload` 表示历史媒体或人工生成产物由本地路径导入，不调用真实 provider。
- W24 已有真实 TTS/视频产物，P5 历史导入不重新执行 provider。

## 3. NodeSpec 映射

| Flow | NodeSpec id | type | capability_requirements | recommended_libraries | agent_candidates | review_gate_ref |
|---|---|---|---|---|---|---|
| A | `A_fact_intelligence` | source | `source.collect`、`fact.verify` | `official-source-library`、`fact-check-library` | `intelligence-agent`、`fact-verification-agent` | - |
| B | `B_md_master` | transform | `content.longform_draft`、`fact.safe_writing` | `content-packaging-library` | `content-agent`、`review-agent` | `B_md_master_gate` |
| C0 | `C0_script_pool_selection` | transform | `script.generate_candidates`、`script.evaluate`、`script.route` | `content-packaging-library`、`script-routing-library` | `script-agent`、`review-agent` | - |
| C | `C_ppt_storyboard` | transform | `storyboard.plan`、`ppt.outline`、`visual.script_adapt` | `storyboard-library`、`content-packaging-library` | `ppt-agent`、`storyboard-agent` | `C_ppt_storyboard_gate` |
| D | `D_voiceover_audio` | agent | `tts.generate`、`subtitle.generate`、`voiceover.timeline` | `tts-caption-library` | `tts-agent`、`caption-agent` | `D_voiceover_audio_gate` |
| E | `E_visual_video` | tool | `video.compose`、`hyperframes.bridge`、`video.inspect` | `video-render-library`、`hyperframes-library` | `video-agent` | `E_visual_video_gate` |
| F | `F_final_render` | tool | `video.render`、`media.validate`、`ffprobe.inspect` | `video-render-library`、`media-qc-library` | `video-agent`、`review-agent` | `F_final_render_gate` |
| G | `G_distribution_retro` | artifact | `publish.package`、`retro.collect`、`quality.review` | `distribution-library`、`review-retro-library` | `distribution-agent`、`retro-agent` | `G_distribution_gate` |

NodeSpec 规则：

- `review_gate_ref` 只引用 GateSpec，不承载审核策略本身。
- A/B/G 在 W24 历史导入时可能只有 Artifact projection；这不影响 WorkflowSpec 定义。
- C0 的 outputs 必须保留 `script_selection_summary` 和多组 `selected_script`，否则 C/D/G routing 会丢失。

## 4. EdgeSpec 映射

| from | to | required | artifact_selector | join_policy |
|---|---|---:|---|---|
| `A_fact_intelligence` | `B_md_master` | true | clean events | 缺少 clean events 时 block downstream |
| `B_md_master` | `C0_script_pool_selection` | true | approved/equivalent MD master | 等待 B gate，通过后继续 |
| `C0_script_pool_selection` | `C_ppt_storyboard` | true | selected scripts + script summary | 自动评审不通过时 block downstream |
| `C_ppt_storyboard` | `D_voiceover_audio` | true for media workflow | approved storyboard manifest | 等待 C gate，通过后继续 |
| `D_voiceover_audio` | `E_visual_video` | true for media workflow | approved audio manifest + timeline | 等待 D gate，通过后继续 |
| `E_visual_video` | `F_final_render` | true for media workflow | HyperFrames handoff manifest | lint/inspect 失败时 block downstream |
| `B_md_master` | `G_distribution_retro` | true | approved/equivalent MD master | 内容发布包主链路，不依赖视频完成 |
| `F_final_render` | `G_distribution_retro` | false | approved video/render manifest | 可选视频增强分支，未通过不阻断 MD 分发草案 |

EdgeSpec 建议：

- 内容发布主链路是 `B -> G` required。
- 视频链路是媒体工作流内 required，但对纯文本发布包来说是 optional enhancement。
- W24 的 `F_final_render` 是 `pending_review`，因此 `F -> G` 只能提供待审视频引用，不能标记为可发布视频输入。

## 5. ArtifactSpec 映射

| ArtifactSpec id | type | produced_by | review_policy | required_for | W24 主要来源 |
|---|---|---|---|---|---|
| `raw_items_artifact` | markdown | `A_fact_intelligence` | none | A 内部审计 | `01_采集归档/raw_items.md` |
| `clean_events_artifact` | markdown | `A_fact_intelligence` | auto | `B_md_master` | `02_清洗核验/clean_events.md` |
| `md_master_artifact` | markdown | `B_md_master` | manual | `C0_script_pool_selection`、`G_distribution_retro` | `03_内容母稿/MD母稿_公众号知乎版.md` |
| `script_selection_artifact` | json | `C0_script_pool_selection` | auto | `C_ppt_storyboard` | `03_内容母稿/口播脚本池/script_selection_summary.json` |
| `selected_scripts_artifact` | script | `C0_script_pool_selection` | auto | `C_ppt_storyboard`、`G_distribution_retro` | `03_内容母稿/口播脚本池/*/selected_script.md` |
| `ppt_outline_artifact` | markdown | `C_ppt_storyboard` | manual | `D_voiceover_audio` | `04_PPT视频/PPT页纲_草案.md` |
| `storyboard_manifest_artifact` | json | `C_ppt_storyboard` | manual | `D_voiceover_audio` | `04_PPT视频/分镜草案/storyboard_adapter_manifest.json` |
| `storyboard_drafts_artifact` | document | `C_ppt_storyboard` | manual | `D_voiceover_audio` | `04_PPT视频/分镜草案/*.md` |
| `voiceover_timeline_artifact` | json | `D_voiceover_audio` | manual | `E_visual_video` | `04_PPT视频/TTS字幕/voiceover_timeline.json` |
| `audio_manifest_artifact` | json | `D_voiceover_audio` | manual | `E_visual_video` | `04_PPT视频/TTS字幕/audio_manifest.json` |
| `subtitle_artifact` | document | `D_voiceover_audio` | manual | `E_visual_video` | `04_PPT视频/TTS字幕/*.srt`、`captions_*.json` |
| `hyperframes_handoff_artifact` | json | `E_visual_video` | conditional | `F_final_render` | `04_PPT视频/HyperFrames*/tts_handoff_manifest.json` |
| `render_manifest_artifact` | json | `F_final_render` | manual | `G_distribution_retro` | `04_PPT视频/render_manifest.json` |
| `video_master_artifact` | video | `F_final_render` | manual | `G_distribution_retro` | `04_PPT视频/*_v3.mp4` |
| `preview_frame_artifact` | image | `F_final_render` | manual | `G_distribution_retro` | `04_PPT视频/*_v3_预览帧.jpg` |
| `publish_package_artifact` | publish_package | `G_distribution_retro` | conditional | external publish | `05_平台分发/全平台发布包.md` |
| `quality_report_artifact` | report | `G_distribution_retro` | auto | retro | `06_质检复盘/发布前质检与复盘.md` |

ArtifactManifest 历史导入规则：

- 所有文件路径保留为原工作区绝对路径或工作区相对路径，不复制大媒体文件。
- MP4、WAV、JPG 等媒体只记录 path、type、size、mtime/hash、preview capability。
- `.DS_Store`、临时缓存和无业务语义文件必须忽略。

## 6. GateSpec 映射

| GateSpec id | target_artifact_ref | required_before | actions | 来源 |
|---|---|---|---|---|
| `B_md_master_gate` | `md_master_artifact` | `C0_script_pool_selection`、`G_distribution_retro` | approve、reject、request_changes | `approval_policy.yaml` B manual |
| `C_ppt_storyboard_gate` | `storyboard_manifest_artifact` | `D_voiceover_audio` | approve、reject、request_changes | `approval_policy.yaml` C manual |
| `D_voiceover_audio_gate` | `audio_manifest_artifact` | `E_visual_video` | approve、reject、request_changes | `approval_policy.yaml` D manual |
| `E_visual_video_gate` | `hyperframes_handoff_artifact` | `F_final_render` | approve、reject、request_changes | `approval_policy.yaml` E conditional |
| `F_final_render_gate` | `render_manifest_artifact` | `G_distribution_retro` | approve、reject、request_changes | `approval_policy.yaml` F manual |
| `G_distribution_gate` | `publish_package_artifact` | external publish | approve、reject、request_changes | `approval_policy.yaml` G conditional |

W24 GateInstance projection：

| GateSpec | W24 状态 | 证据来源 | 导入可信度 |
|---|---|---|---|
| `C_ppt_storyboard_gate` | approved | `phase_status.md` + `approval_decisions.jsonl` | observed_from_event |
| `D_voiceover_audio_gate` | approved | `phase_status.md` + `approval_decisions.jsonl` | observed_from_event |
| `F_final_render_gate` | pending_review | `phase_status.md` + `render_manifest.json.publish_allowed` | observed_from_status |
| `B_md_master_gate` | inferred approved/equivalent | `MD母稿_公众号知乎版.md` 存在且被后续使用 | inferred_from_file |
| `E_visual_video_gate` | approved | `phase_status.md` | observed_from_status |
| `G_distribution_gate` | inferred draft/done | `全平台发布包.md` 与质检复盘存在 | inferred_from_file |

注意：`pending_review` 属于 GateInstance 或 ArtifactManifest，不属于 GateDecision。

## 7. AgentSpec 与 ComponentLibrary 映射

| AgentSpec id | 职责 | equipped_libraries | W24 证据 |
|---|---|---|---|
| `intelligence-agent` | 官方源采集、事实核验、Raw/Clean 事件 | `official-source-library`、`fact-check-library` | A 产物文件 |
| `content-agent` | MD 母稿、内容包装、平台文案 | `content-packaging-library` | B/G 产物文件 |
| `script-agent` | 脚本池候选生成、评分、routing | `script-routing-library`、`content-packaging-library` | C0 steps/artifacts |
| `ppt-agent` | PPT 页纲与分镜草案 | `storyboard-library` | C steps/artifacts |
| `tts-agent` | voiceover timeline、TTS、字幕 | `tts-caption-library` | D steps/artifacts |
| `video-agent` | HyperFrames bridge、render、ffprobe | `hyperframes-library`、`video-render-library`、`media-qc-library` | E/F steps/artifacts |
| `review-agent` | 人审门、质检、返工意见 | `review-retro-library` | approval decisions、quality report |
| `distribution-agent` | 全平台发布包与复盘 | `distribution-library`、`review-retro-library` | G 产物文件 |

ComponentLibrary 映射：

| library | capabilities | 对应真实工具/文档 |
|---|---|---|
| `official-source-library` | `source.collect` | 频道配置、官方源采集规则 |
| `fact-check-library` | `fact.verify` | 清洗核验规则、L1/L2 证据链 |
| `content-packaging-library` | `content.longform_draft`、`fact.safe_writing` | MD 母稿与平台分发模板 |
| `script-routing-library` | `script.generate_candidates`、`script.evaluate`、`script.route` | `script_groups.yaml`、脚本池 runner |
| `storyboard-library` | `storyboard.plan`、`ppt.outline` | PPT 与 HyperFrames 工作流、storyboard adapter |
| `tts-caption-library` | `tts.generate`、`subtitle.generate`、`voiceover.timeline` | TTS provider policy、voice profile、TTS runner |
| `hyperframes-library` | `video.compose`、`hyperframes.bridge` | HyperFrames 工程与 bridge 工具 |
| `video-render-library` | `video.render`、`media.validate` | HyperFrames CLI、ffprobe、render manifest |
| `distribution-library` | `publish.package` | 全平台发布包模板 |
| `review-retro-library` | `quality.review`、`retro.collect` | 发布前质检与复盘 |

## 8. Run Projection 映射

W24 historical run 不直接导入为 RunSpec，而是通过 importer 生成 Miracle projection：

| Miracle 对象 | W24 来源 | 规则 |
|---|---|---|
| RunSpec | `task_trace.json.run_id/title/date/mode` + workflow id | 生成只读 historical run root。 |
| WorkflowSnapshot | `content-production-real-v0` | 导入时冻结当前映射版本。 |
| RunManifest | 交付包路径、文件清单、忽略规则 | 记录本地文件清单，不代表执行真相。 |
| NodeRun | `phase_status.md` + 文件存在 | 有 status 用 observed，无 status 用 inferred。 |
| NodeAttempt | `task_trace.json.steps` | step id 映射 attempt_id，step status 映射 attempt status。 |
| ArtifactManifest | `task_trace.json.artifacts` + 实际文件扫描 | 文件存在时 created/pending，缺失时 missing。 |
| GateInstance | `phase_status.md` + GateSpec | pending_review/approved 从状态表映射。 |
| GateDecision | `approval_decisions.jsonl` | 只导入结构化审核决定。 |
| TraceEvent | `task_events.jsonl` | 保留原 event、step_id、summary，映射 subject。 |
| AttentionItem | pending_review、warnings、缺失控制状态 | F 待审和 A/B/G inferred 状态可进入 Attention。 |

## 9. 可信度与来源标记

P5 historical importer 必须保留 source confidence。建议使用 importer metadata，不修改核心对象字段：

| confidence | 含义 | 例子 |
|---|---|---|
| `observed_from_event` | 来自结构化事件或审核决策 | `approval_decisions.jsonl`、`task_events.jsonl` |
| `observed_from_status` | 来自状态表或 manifest 状态 | `phase_status.md`、`render_manifest.json` |
| `observed_from_trace` | 来自 `task_trace.json.steps/artifacts` | NodeAttempt、tool calls、artifact list |
| `inferred_from_file` | 仅从文件存在推断 | W24 A/B/G，W23 大部分产物 |
| `not_observed` | 未观察到，不能生成运行事实 | W23 缺 Trace/Gate 决策 |

建议 metadata 形态：

```json
{
  "source_workspace": "/Users/zhangyue/Documents/Obsidian Vault/热点工具更新",
  "source_run_dir": "runs/real/2026-W24_Codex_ClaudeCode_真实任务交付包",
  "source_path": "00_任务控制/task_events.jsonl",
  "confidence": "observed_from_event",
  "import_note": "historical projection; not re-executed"
}
```

## 10. P5-03 输入要求

`P5-03 历史 Run 只读导入方案` 应基于本映射继续完成：

1. 定义 historical importer 的输入、输出目录和忽略规则。
2. 生成 `content-production-real-v0` 的 WorkflowSnapshot projection。
3. 读取 W24 交付包并输出 RunSpec、RunManifest、NodeRun、NodeAttempt、ArtifactManifest、GateInstance、GateDecision、TraceEvent projection。
4. 对 W23 运行降级导入，验证缺少控制文件时只生成 Artifact projection 和缺口 Attention。
5. 保证 importer 不执行真实 Runner、不复制媒体大文件、不伪造缺失事件。

## 11. P5-02 验收

| 验收项 | 结果 |
|---|---|
| Flow A-G 已映射为通用 NodeSpec | 通过 |
| C0 脚本池作为独立节点 | 通过 |
| EdgeSpec 主链路和可选视频增强分支已定义 | 通过 |
| ArtifactSpec 覆盖真实 W24 主要产物 | 通过 |
| GateSpec 与审核真相边界一致 | 通过 |
| AgentSpec 与 ComponentLibrary 映射完成 | 通过 |
| Run projection 和可信度规则明确 | 通过 |
| task-baseline 可推进到 P5-03 | 通过 |
