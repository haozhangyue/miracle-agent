import { describe, expect, it } from "vitest";
import {
  buildCanvasDraftFromWorkflow,
  buildDagProjection,
  buildGateDecisionProjection,
  createAdapterInvocation,
  createArtifactManifestsFromAdapterResult,
  createDryRunPlan,
  createNodeAttemptFromAdapterResult,
  createRunFromWorkflow,
  executeMockAdapter,
  validateWorkflowSpec,
  type GateInstance,
  type NodeRun,
  type WorkflowSpec
} from "../src";

const workflow: WorkflowSpec = {
  id: "content-production-v0",
  name: "内容生产全流程",
  version: "0.6.0",
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
      review_gate_ref: "md_master_gate",
      failure_policy: { retry: 1, on_missing_input: "blocked", on_provider_failure: "failed" }
    },
    {
      id: "G_distribution",
      name: "分发复盘",
      type: "artifact",
      capability_requirements: ["publish.package"],
      recommended_libraries: ["distribution-library"],
      agent_candidates: ["distribution-agent"],
      inputs: [{ id: "md_master", kind: "artifact", artifact_type: "markdown", required: true }],
      outputs: [],
      failure_policy: { retry: 0, on_missing_input: "blocked", on_provider_failure: "failed" }
    }
  ],
  edges: [
    {
      from: "B_md_master",
      to: "G_distribution",
      required: true,
      artifact_selector: { artifact_type: "markdown", review_status: "approved" },
      join_policy: { wait_if_active: false, on_timeout: "continue_if_required_inputs_ready", on_no_qualified_artifact: "block_downstream" }
    }
  ],
  gates: [{ id: "md_master_gate", name: "母稿审核", target_artifact_ref: "md_master_artifact", required_before: ["G_distribution"], actions: ["approve", "reject"] }],
  artifacts: [
    {
      id: "md_master_artifact",
      type: "markdown",
      produced_by: "B_md_master",
      review_policy: { mode: "manual", gate_spec_id: "md_master_gate" },
      required_for: ["G_distribution"],
      versioning: { immutable: true, compare_by: "hash" }
    }
  ],
  provider_policy: { default_provider: "codex-local", allowed_providers: ["codex-local"], required_credentials: ["VOLC_TTS_API_KEY"], fallback_providers: ["mock-tts"] },
  layouts: { dag: { B_md_master: { x: 0, y: 0, stage: "内容策划与母稿" }, G_distribution: { x: 220, y: 0, stage: "分发与复盘" } } },
  registry_meta: { source: "local_registry", status: "stable" }
};

describe("workflow validation", () => {
  it("validates references and review boundaries", () => {
    const result = validateWorkflowSpec(workflow);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("returns credential and gate risks in dry-run", () => {
    const plan = createDryRunPlan(workflow, []);
    expect(plan.valid).toBe(false);
    expect(plan.risks.some((risk) => risk.code === "missing_credential")).toBe(true);
    expect(plan.risks.some((risk) => risk.code === "manual_gate_required")).toBe(true);
  });

  it("creates RunSpec and WorkflowSnapshot as separate facts", () => {
    const created = createRunFromWorkflow(workflow, { runId: "run_test_001", executionPolicy: "hybrid", roleProfile: "operator", createdAt: "2026-06-29T10:00:00.000Z" });
    expect(created.runSpec.workflow_snapshot_id).toBe("snap_run_test_001");
    expect(created.workflowSnapshot.workflow.id).toBe(workflow.id);
    expect(created.events[0].type).toBe("run_created");
  });

  it("builds DAG, Gate and Canvas projections without mutating runtime facts", () => {
    const nodeRuns: NodeRun[] = [
      { node_run_id: "nr_b", run_id: "run_test_001", node_id: "B_md_master", status: "reviewing", updated_at: "2026-06-29T10:00:00.000Z", upstream_artifacts: [], output_artifacts: ["art_md"] },
      { node_run_id: "nr_g", run_id: "run_test_001", node_id: "G_distribution", status: "queued", updated_at: "2026-06-29T10:00:00.000Z", upstream_artifacts: ["art_md"], output_artifacts: [] }
    ];
    const gate: GateInstance = {
      gate_instance_id: "gate_001",
      run_id: "run_test_001",
      gate_spec_id: "md_master_gate",
      target: { type: "ArtifactManifest", id: "art_md" },
      status: "pending_review",
      required_before: ["G_distribution"],
      decisions: []
    };

    expect(buildDagProjection(workflow, nodeRuns).edges[0]).toMatchObject({ label: "required", from: "B_md_master", to: "G_distribution" });
    expect(buildGateDecisionProjection(gate, workflow, nodeRuns, "approve")).toMatchObject({ projected_artifact_review_status: "approved", mutates_artifact: false });
    expect(buildCanvasDraftFromWorkflow(workflow).objects.some((object) => object.ref_id === "B_md_master")).toBe(true);
  });

  it("creates a mock AdapterResult and converts it into attempts and artifact manifests", () => {
    const created = createRunFromWorkflow(workflow, { runId: "run_test_runner", executionPolicy: "hybrid", roleProfile: "operator", createdAt: "2026-06-29T10:00:00.000Z" });
    const nodeRun = created.nodeRuns[0];
    const invocation = createAdapterInvocation({ runSpec: created.runSpec, workflow, nodeRun, createdAt: "2026-06-29T10:00:01.000Z" });
    const result = executeMockAdapter({ invocation, workflow, receivedAt: "2026-06-29T10:00:02.000Z" });
    const attempt = createNodeAttemptFromAdapterResult(result);
    const artifacts = createArtifactManifestsFromAdapterResult({ result, runId: created.runSpec.run_id, nodeRun, producer: "content-agent" });

    expect(result.status).toBe("succeeded");
    expect(result.operation_id).toBe(invocation.operation_id);
    expect(result.artifact_descriptors[0]).toMatchObject({ type: "markdown", review_status: "pending_review" });
    expect(attempt).toMatchObject({ node_run_id: nodeRun.node_run_id, status: "succeeded" });
    expect(artifacts[0]).toMatchObject({ run_id: "run_test_runner", review_status: "pending_review", producer: "content-agent" });
  });
});
