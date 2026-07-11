import { describe, expect, it } from "vitest";
import {
  buildHistoricalProjection,
  historicalRunSpecSchema,
  type HistoricalProjectionInput,
  type WorkflowSpec
} from "../src";

const workflow: WorkflowSpec = {
  id: "content-production-real-v0",
  name: "真实内容生产工作流",
  version: "0.1.0",
  domain: "content-production",
  category: "media",
  nodes: [
    {
      id: "B_md_master",
      name: "内容 MD 母稿",
      type: "transform",
      capability_requirements: ["content.longform_draft"],
      recommended_libraries: ["content-packaging-library"],
      agent_candidates: ["content-agent"],
      inputs: [],
      outputs: [{ id: "md_master", kind: "artifact", artifact_type: "markdown", required: true, artifact_spec_ref: "md_master_artifact" }],
      review_gate_ref: "B_md_master_gate",
      failure_policy: { retry: 1, on_missing_input: "blocked", on_provider_failure: "failed" }
    },
    {
      id: "F_final_render",
      name: "最终渲染",
      type: "tool",
      capability_requirements: ["video.render"],
      recommended_libraries: ["video-render-library"],
      agent_candidates: ["video-agent"],
      inputs: [],
      outputs: [{ id: "render_manifest", kind: "artifact", artifact_type: "json", required: false, artifact_spec_ref: "render_manifest_artifact" }],
      review_gate_ref: "F_final_render_gate",
      failure_policy: { retry: 0, on_missing_input: "blocked", on_provider_failure: "failed" }
    },
    {
      id: "G_distribution_retro",
      name: "分发与复盘",
      type: "artifact",
      capability_requirements: ["publish.package"],
      recommended_libraries: ["distribution-library"],
      agent_candidates: ["distribution-agent"],
      inputs: [],
      outputs: [],
      failure_policy: { retry: 0, on_missing_input: "blocked", on_provider_failure: "failed" }
    }
  ],
  edges: [
    {
      from: "B_md_master",
      to: "G_distribution_retro",
      required: true,
      artifact_selector: { artifact_type: "markdown" },
      join_policy: { wait_if_active: false, on_timeout: "continue_if_required_inputs_ready", on_no_qualified_artifact: "block_downstream" }
    },
    {
      from: "F_final_render",
      to: "G_distribution_retro",
      required: false,
      artifact_selector: { artifact_type: "video" },
      join_policy: { wait_if_active: false, on_timeout: "continue_if_required_inputs_ready", on_no_qualified_artifact: "ignore_optional" }
    }
  ],
  gates: [
    { id: "B_md_master_gate", name: "母稿审核", target_artifact_ref: "md_master_artifact", required_before: ["G_distribution_retro"], actions: ["approve", "reject", "request_changes"] },
    { id: "F_final_render_gate", name: "最终渲染审核", target_artifact_ref: "render_manifest_artifact", required_before: ["G_distribution_retro"], actions: ["approve", "reject", "request_changes"] }
  ],
  artifacts: [
    { id: "md_master_artifact", type: "markdown", produced_by: "B_md_master", review_policy: { mode: "manual", gate_spec_id: "B_md_master_gate" }, required_for: ["G_distribution_retro"], versioning: { immutable: true, compare_by: "hash" } },
    { id: "render_manifest_artifact", type: "json", produced_by: "F_final_render", review_policy: { mode: "manual", gate_spec_id: "F_final_render_gate" }, required_for: ["G_distribution_retro"], versioning: { immutable: true, compare_by: "hash" } }
  ],
  provider_policy: { default_provider: "codex-local", allowed_providers: ["codex-local"], required_credentials: [], fallback_providers: [] },
  layouts: { dag: { B_md_master: { x: 0, y: 0 }, F_final_render: { x: 220, y: 0 }, G_distribution_retro: { x: 440, y: 0 } } },
  registry_meta: { source: "local_registry", status: "experimental" }
};

function input(overrides: Partial<HistoricalProjectionInput> = {}): HistoricalProjectionInput {
  return {
    request: {
      source_run_dir: "/allowed/source/W24",
      workflow_id: "content-production-real-v0",
      sample_kind: "w24"
    },
    workflow,
    run_id: "run-real-w24",
    source_fingerprint: "sha256:w24",
    imported_at: "2026-07-11T00:00:00.000Z",
    source_files: ["00_任务控制/phase_status.md", "00_任务控制/task_events.jsonl"],
    nodes: [
      { node_id: "B_md_master", status: "done", confidence: "inferred", source_paths: ["03_内容母稿/MD母稿.md"] },
      { node_id: "F_final_render", status: "reviewing", confidence: "observed_from_status", source_paths: ["00_任务控制/phase_status.md"] },
      { node_id: "G_distribution_retro", status: "waiting", confidence: "inferred", source_paths: ["05_平台分发/全平台发布包.md"] }
    ],
    attempts: [],
    artifacts: [
      {
        artifact_id: "art_md",
        node_id: "B_md_master",
        type: "markdown",
        path: "/allowed/source/W24/03_内容母稿/MD母稿.md",
        hash: "sha256:md",
        status: "created",
        review_status: "approved",
        producer: "content-agent",
        confidence: "inferred",
        source_paths: ["03_内容母稿/MD母稿.md"]
      },
      {
        artifact_id: "art_render",
        node_id: "F_final_render",
        type: "json",
        path: "/allowed/source/W24/04_PPT视频/render_manifest.json",
        hash: "sha256:render",
        status: "created",
        review_status: "pending_review",
        producer: "video-agent",
        confidence: "observed_from_status",
        source_paths: ["04_PPT视频/render_manifest.json"]
      }
    ],
    gates: [
      { gate_spec_id: "F_final_render_gate", target_artifact_id: "art_render", status: "pending_review", decisions: [], confidence: "observed_from_status", source_paths: ["00_任务控制/phase_status.md"] }
    ],
    source_events: [
      { source_path: "00_任务控制/task_events.jsonl", source_line: 1, occurred_at: "2026-06-12T10:52:45+08:00", event_type: "phase_pending_review", subject_type: "NodeRun", subject_id: "nr_run-real-w24_F_final_render", message: "等待人工视觉审看" }
    ],
    gaps: [{ code: "early_phases_inferred", severity: "warning", message: "A/B/G 缺少标准状态" }],
    ...overrides
  };
}

describe("historical projection", () => {
  it("builds a read-only W24 projection without turning evidence gaps into execution facts", () => {
    const projection = buildHistoricalProjection(input());

    expect(projection.runSpec).toMatchObject({ run_id: "run-real-w24", run_mode: "historical_readonly", execution_policy: null, source_meta_path: "runs/run-real-w24/source_meta.json" });
    expect(projection.nodeRuns.find((node) => node.node_id === "F_final_render")?.status).toBe("reviewing");
    expect(projection.gates[0]).toMatchObject({ status: "pending_review", decisions: [] });
    expect(projection.events.filter((event) => event.type === "historical_source_event")).toHaveLength(1);
    expect(projection.events.some((event) => event.type === "node_run_committed")).toBe(false);
    expect(projection.sourceMeta.objects["nr_run-real-w24_B_md_master"]?.confidence).toBe("inferred");
    expect(projection.attention.some((item) => item.root_cause_key === "historical_gap:early_phases_inferred")).toBe(true);
  });

  it("keeps W23 missing evidence as gaps and never creates attempts or source events", () => {
    const projection = buildHistoricalProjection(
      input({
        request: { source_run_dir: "/allowed/source/W23", workflow_id: "content-production-real-v0", sample_kind: "w23" },
        run_id: "run-real-w23",
        source_fingerprint: "sha256:w23",
        source_files: ["03_内容母稿/MD母稿.md"],
        nodes: [{ node_id: "B_md_master", status: "done", confidence: "inferred", source_paths: ["03_内容母稿/MD母稿.md"] }],
        attempts: [],
        gates: [],
        source_events: [],
        gaps: [{ code: "control_files_missing", severity: "error", message: "缺少 phase status、trace、events 和 decisions" }]
      })
    );

    expect(projection.attempts).toEqual([]);
    expect(projection.events.filter((event) => event.type === "historical_source_event")).toEqual([]);
    expect(projection.sourceMeta.gaps[0]?.code).toBe("control_files_missing");
    expect(projection.attention[0]).toMatchObject({ severity: "P1", status: "open" });
  });

  it("uses a discriminated RunSpec so historical mode cannot carry an execution policy", () => {
    expect(
      historicalRunSpecSchema.parse({
        run_id: "run-real-w24",
        workflow_id: "content-production-real-v0",
        workflow_version: "0.1.0",
        workflow_snapshot_id: "snap_run-real-w24",
        status: "running",
        run_mode: "historical_readonly",
        execution_policy: null,
        source_meta_path: "runs/run-real-w24/source_meta.json",
        role_profile: "operator",
        resolved_components: [],
        resolved_provider_policy: workflow.provider_policy,
        created_at: "2026-07-11T00:00:00.000Z"
      }).run_mode
    ).toBe("historical_readonly");

    expect(() =>
      historicalRunSpecSchema.parse({
        run_id: "run-real-w24",
        workflow_id: "content-production-real-v0",
        workflow_version: "0.1.0",
        workflow_snapshot_id: "snap_run-real-w24",
        status: "running",
        run_mode: "historical_readonly",
        execution_policy: "hybrid",
        source_meta_path: "runs/run-real-w24/source_meta.json",
        role_profile: "operator",
        resolved_components: [],
        resolved_provider_policy: workflow.provider_policy,
        created_at: "2026-07-11T00:00:00.000Z"
      })
    ).toThrow();
  });

  it("keeps inferred pending gates below observed human review gates", () => {
    const projection = buildHistoricalProjection(
      input({
        gates: [
          { gate_spec_id: "F_final_render_gate", target_artifact_id: "art_render", status: "pending_review", decisions: [], confidence: "observed_from_status", source_paths: ["00_任务控制/phase_status.md"] },
          { gate_spec_id: "B_md_master_gate", target_artifact_id: "art_md", status: "pending_review", decisions: [], confidence: "inferred", source_paths: ["03_内容母稿/MD母稿.md"] }
        ]
      })
    );

    expect(projection.attention.find((item) => item.root_cause_key === "historical_gate_pending:F_final_render_gate")?.severity).toBe("P0");
    expect(projection.attention.find((item) => item.root_cause_key === "historical_gate_pending:B_md_master_gate")?.severity).toBe("P2");
  });
});
