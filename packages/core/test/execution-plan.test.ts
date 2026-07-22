import { describe, expect, it } from "vitest";
import {
  calculateExecutionPlan,
  resolveNodeInputs,
  type ArtifactManifest,
  type GateInstance,
  type NodeRun,
  type WorkflowSpec
} from "../src";

const now = "2026-07-22T08:00:00.000Z";

function workflowWithOptionalVideo(): WorkflowSpec {
  return {
    id: "codex-content-chain-v0",
    name: "Codex content chain",
    version: "0.1.0",
    domain: "content-production",
    category: "media",
    nodes: [
      node("A_fact_input", "source", [], [port("fact_input", "artifact", "json", true, "fact_artifact")]),
      node("B_content_plan", "transform", [port("fact_input", "artifact", "json", true, "fact_artifact")], [port("content_plan", "artifact", "markdown", true, "plan_artifact")]),
      node("C_md_master", "agent", [port("content_plan", "artifact", "markdown", true, "plan_artifact")], [port("md_master", "artifact", "markdown", true, "master_artifact")]),
      node("D_platform_summary", "agent", [port("content_plan", "artifact", "markdown", true, "plan_artifact")], [port("platform_summary", "artifact", "markdown", true, "summary_artifact")]),
      node("F_optional_video", "agent", [port("content_plan", "artifact", "markdown", true, "plan_artifact")], [port("video", "artifact", "video", true, "video_artifact")]),
      node("G_end", "end", [], [])
    ],
    edges: [
      edge("A_fact_input", "B_content_plan", true, { artifact_type: "json" }),
      edge("B_content_plan", "C_md_master", true, { artifact_type: "markdown", review_status: "approved" }),
      edge("B_content_plan", "D_platform_summary", true, { artifact_type: "markdown", review_status: "approved" }),
      edge("B_content_plan", "F_optional_video", true, { artifact_type: "markdown", review_status: "approved" }),
      edge("F_optional_video", "D_platform_summary", false, { artifact_type: "video" }, { wait_if_active: false, on_timeout: "continue_if_required_inputs_ready", on_no_qualified_artifact: "ignore_optional" }),
      edge("D_platform_summary", "G_end", true, { artifact_type: "markdown" })
    ],
    gates: [{ id: "plan_review", name: "Plan review", target_artifact_ref: "plan_artifact", required_before: ["D_platform_summary"], actions: ["approve", "reject"] }],
    artifacts: [
      artifactSpec("fact_artifact", "json", "A_fact_input"),
      artifactSpec("plan_artifact", "markdown", "B_content_plan", "manual"),
      artifactSpec("master_artifact", "markdown", "C_md_master"),
      artifactSpec("summary_artifact", "markdown", "D_platform_summary"),
      artifactSpec("video_artifact", "video", "F_optional_video")
    ],
    provider_policy: { default_provider: "codex-local", allowed_providers: ["codex-local"], required_credentials: [], fallback_providers: [] },
    layouts: { dag: {} },
    registry_meta: { source: "test", status: "stable" }
  };
}

function nodeRuns(): NodeRun[] {
  return [
    nodeRun("A_fact_input", "done"),
    nodeRun("B_content_plan", "done"),
    nodeRun("C_md_master", "queued"),
    nodeRun("D_platform_summary", "queued"),
    nodeRun("F_optional_video", "failed"),
    nodeRun("G_end", "waiting")
  ];
}

function artifacts(): ArtifactManifest[] {
  return [
    artifact("art_fact_v1", "A_fact_input", "json", 1, "sha256:fact", "approved"),
    artifact("art_plan_v1", "B_content_plan", "markdown", 1, "sha256:plan", "approved")
  ];
}

function pendingPlanGate(): GateInstance {
  return {
    gate_instance_id: "gate_plan_review",
    run_id: "run_p7_02",
    gate_spec_id: "plan_review",
    target: { type: "ArtifactManifest", id: "art_plan_v1" },
    status: "pending_review",
    required_before: ["D_platform_summary"],
    decisions: []
  };
}

describe("execution plan", () => {
  it("resolves the selected artifact version, hash, and media type for a required input", () => {
    const workflow = workflowWithOptionalVideo();
    const node = workflow.nodes.find((item) => item.id === "C_md_master");
    expect(node).toBeDefined();

    expect(resolveNodeInputs({ workflow, node: node!, nodeRuns: nodeRuns(), artifacts: artifacts(), calculatedAt: now })).toEqual([
      expect.objectContaining({
        input_id: "content_plan",
        artifact_id: "art_plan_v1",
        artifact_version: 1,
        artifact_hash: "sha256:plan",
        media_type: "markdown",
        required: true,
        resolved_at: now
      })
    ]);
  });

  it("only executes a node whose required edges and reviewed artifacts are satisfied", () => {
    const plan = calculateExecutionPlan({ workflow: workflowWithOptionalVideo(), nodeRuns: nodeRuns(), artifacts: artifacts(), gates: [pendingPlanGate()], calculatedAt: now });

    expect(plan.decisions.find((item) => item.node_id === "C_md_master")).toMatchObject({
      decision: "execute",
      resolved_inputs: [expect.objectContaining({ artifact_id: "art_plan_v1", artifact_hash: "sha256:plan" })]
    });
  });

  it("pauses a downstream node while its required gate lacks an approved decision", () => {
    const plan = calculateExecutionPlan({ workflow: workflowWithOptionalVideo(), nodeRuns: nodeRuns(), artifacts: artifacts(), gates: [pendingPlanGate()], calculatedAt: now });

    expect(plan.decisions.find((item) => item.node_id === "D_platform_summary")).toMatchObject({ decision: "pause_for_gate", reason_code: "required_gate_pending" });
    expect(plan.paused_node_run_ids).toEqual(["nr_D_platform_summary"]);
  });

  it("does not let an optional failed branch block the required path", () => {
    const workflow = workflowWithOptionalVideo();
    workflow.gates = [];
    const plan = calculateExecutionPlan({ workflow, nodeRuns: nodeRuns(), artifacts: artifacts(), gates: [], calculatedAt: now });

    expect(plan.decisions.find((item) => item.node_id === "D_platform_summary")?.decision).toBe("execute");
  });

  it("waits when an optional active branch requires a join", () => {
    const workflow = workflowWithOptionalVideo();
    workflow.gates = [];
    const optionalEdge = workflow.edges.find((item) => item.from === "F_optional_video" && item.to === "D_platform_summary");
    optionalEdge!.join_policy.wait_if_active = true;
    const activeRuns = nodeRuns().map((item) => (item.node_id === "F_optional_video" ? { ...item, status: "running" as const, started_at: now } : item));

    const plan = calculateExecutionPlan({ workflow, nodeRuns: activeRuns, artifacts: artifacts(), gates: [], calculatedAt: now });

    expect(plan.decisions.find((item) => item.node_id === "D_platform_summary")).toMatchObject({ decision: "wait", reason_code: "optional_edge_active" });
  });

  it("continues after an optional join times out when required inputs are ready", () => {
    const workflow = workflowWithOptionalVideo();
    workflow.gates = [];
    const optionalEdge = workflow.edges.find((item) => item.from === "F_optional_video" && item.to === "D_platform_summary");
    optionalEdge!.join_policy = { wait_if_active: true, max_wait: "PT1S", on_timeout: "continue_if_required_inputs_ready", on_no_qualified_artifact: "ignore_optional" };
    const activeRuns = nodeRuns().map((item) => (item.node_id === "F_optional_video" ? { ...item, status: "running" as const, started_at: now } : item));

    const plan = calculateExecutionPlan({ workflow, nodeRuns: activeRuns, artifacts: artifacts(), gates: [], calculatedAt: "2026-07-22T08:00:02.000Z" });

    expect(plan.decisions.find((item) => item.node_id === "D_platform_summary")?.decision).toBe("execute");
  });

  it("blocks after an optional join times out when the policy requires a decision", () => {
    const workflow = workflowWithOptionalVideo();
    workflow.gates = [];
    const optionalEdge = workflow.edges.find((item) => item.from === "F_optional_video" && item.to === "D_platform_summary");
    optionalEdge!.join_policy = { wait_if_active: true, max_wait: "PT1S", on_timeout: "require_decision", on_no_qualified_artifact: "ignore_optional" };
    const activeRuns = nodeRuns().map((item) => (item.node_id === "F_optional_video" ? { ...item, status: "running" as const, started_at: now } : item));

    const plan = calculateExecutionPlan({ workflow, nodeRuns: activeRuns, artifacts: artifacts(), gates: [], calculatedAt: "2026-07-22T08:00:02.000Z" });

    expect(plan.decisions.find((item) => item.node_id === "D_platform_summary")).toMatchObject({ decision: "blocked", reason_code: "optional_edge_timeout_require_decision" });
  });

  it("blocks when an optional edge has no qualifying artifact and requires downstream blocking", () => {
    const workflow = workflowWithOptionalVideo();
    workflow.gates = [];
    const optionalEdge = workflow.edges.find((item) => item.from === "F_optional_video" && item.to === "D_platform_summary");
    optionalEdge!.join_policy.on_no_qualified_artifact = "block_downstream";

    const plan = calculateExecutionPlan({ workflow, nodeRuns: nodeRuns(), artifacts: artifacts(), gates: [], calculatedAt: now });

    expect(plan.decisions.find((item) => item.node_id === "D_platform_summary")).toMatchObject({ decision: "blocked", reason_code: "optional_edge_no_qualified_artifact_block_downstream" });
  });

  it("blocks when an optional edge has no qualifying artifact and requires a decision", () => {
    const workflow = workflowWithOptionalVideo();
    workflow.gates = [];
    const optionalEdge = workflow.edges.find((item) => item.from === "F_optional_video" && item.to === "D_platform_summary");
    optionalEdge!.join_policy.on_no_qualified_artifact = "require_decision";

    const plan = calculateExecutionPlan({ workflow, nodeRuns: nodeRuns(), artifacts: artifacts(), gates: [], calculatedAt: now });

    expect(plan.decisions.find((item) => item.node_id === "D_platform_summary")).toMatchObject({ decision: "blocked", reason_code: "optional_edge_no_qualified_artifact_require_decision" });
  });

  it("continues when an optional edge has no qualifying artifact and may be ignored", () => {
    const workflow = workflowWithOptionalVideo();
    workflow.gates = [];

    const plan = calculateExecutionPlan({ workflow, nodeRuns: nodeRuns(), artifacts: artifacts(), gates: [], calculatedAt: now });

    expect(plan.decisions.find((item) => item.node_id === "D_platform_summary")?.decision).toBe("execute");
  });

  it("uses the newest timestamped gate decision regardless of decision array order", () => {
    const workflow = workflowWithOptionalVideo();
    const gate = { ...pendingPlanGate(), status: "decided" as const, decisions: [gateDecision("approve", "2026-07-22T08:00:01.000Z"), gateDecision("reject", "2026-07-22T08:00:02.000Z")] };
    const reorderedGate = { ...gate, decisions: [...gate.decisions].reverse() };

    const firstPlan = calculateExecutionPlan({ workflow, nodeRuns: nodeRuns(), artifacts: artifacts(), gates: [gate], calculatedAt: now });
    const reorderedPlan = calculateExecutionPlan({ workflow, nodeRuns: [...nodeRuns()].reverse(), artifacts: [...artifacts()].reverse(), gates: [reorderedGate], calculatedAt: now });

    expect(firstPlan.decisions.find((item) => item.node_id === "D_platform_summary")).toMatchObject({ decision: "blocked", reason_code: "required_gate_rejected" });
    expect(reorderedPlan).toEqual(firstPlan);
  });

  it("executes after an approved gate", () => {
    const workflow = workflowWithOptionalVideo();
    const approvedGate = { ...pendingPlanGate(), status: "decided" as const, decisions: [gateDecision("approve", now)] };

    const plan = calculateExecutionPlan({ workflow, nodeRuns: nodeRuns(), artifacts: artifacts(), gates: [approvedGate], calculatedAt: now });

    expect(plan.decisions.find((item) => item.node_id === "D_platform_summary")?.decision).toBe("execute");
  });

  it("keeps a terminal run open only for pending gates", () => {
    const workflow = workflowWithOptionalVideo();
    const terminalRuns = nodeRuns().map((item) => ({ ...item, status: "done" as const }));
    const pending = pendingPlanGate();
    const decided = { ...pending, status: "decided" as const, decisions: [gateDecision("approve", now)] };
    const invalidated = { ...pending, status: "invalidated" as const };

    expect(calculateExecutionPlan({ workflow, nodeRuns: terminalRuns, artifacts: artifacts(), gates: [pending], calculatedAt: now }).terminal).toBe(false);
    expect(calculateExecutionPlan({ workflow, nodeRuns: terminalRuns, artifacts: artifacts(), gates: [decided], calculatedAt: now }).terminal).toBe(true);
    expect(calculateExecutionPlan({ workflow, nodeRuns: terminalRuns, artifacts: artifacts(), gates: [invalidated], calculatedAt: now }).terminal).toBe(true);
  });

  it("does not bind an artifact input without a spec ref to an incompatible port type", () => {
    const workflow = workflowWithOptionalVideo();
    workflow.gates = [];
    workflow.artifacts = [];
    const contentPlan = workflow.nodes.find((item) => item.id === "C_md_master")!;
    contentPlan.inputs = [{ id: "content_plan", kind: "artifact", artifact_type: "markdown", required: true }];
    const planEdge = workflow.edges.find((item) => item.from === "B_content_plan" && item.to === "C_md_master")!;
    delete planEdge.artifact_selector;
    const wrongArtifact = artifact("art_plan_json", "B_content_plan", "json", 1, "sha256:json", "approved");

    const plan = calculateExecutionPlan({ workflow, nodeRuns: nodeRuns(), artifacts: [wrongArtifact], gates: [], calculatedAt: now });

    expect(plan.decisions.find((item) => item.node_id === "C_md_master")).toMatchObject({ decision: "blocked", reason_code: "required_input_missing", resolved_inputs: [] });
  });

  it("keeps queued node runs eligible for execution", () => {
    const workflow = workflowWithOptionalVideo();
    workflow.gates = [];

    const plan = calculateExecutionPlan({ workflow, nodeRuns: nodeRuns(), artifacts: artifacts(), gates: [], calculatedAt: now });

    expect(plan.decisions.find((item) => item.node_id === "C_md_master")?.decision).toBe("execute");
  });

  it("keeps waiting node runs waiting", () => {
    const workflow = workflowWithOptionalVideo();
    workflow.gates = [];
    const waitingRuns = nodeRuns().map((item) => (item.node_id === "C_md_master" ? { ...item, status: "waiting" as const } : item));

    const plan = calculateExecutionPlan({ workflow, nodeRuns: waitingRuns, artifacts: artifacts(), gates: [], calculatedAt: now });

    expect(plan.decisions.find((item) => item.node_id === "C_md_master")).toMatchObject({ decision: "wait", reason_code: "node_run_waiting" });
  });

  it("keeps restored running node runs eligible for execution", () => {
    const workflow = workflowWithOptionalVideo();
    workflow.gates = [];
    const runningRuns = nodeRuns().map((item) => (item.node_id === "C_md_master" ? { ...item, status: "running" as const } : item));

    const plan = calculateExecutionPlan({ workflow, nodeRuns: runningRuns, artifacts: artifacts(), gates: [], calculatedAt: now });

    expect(plan.decisions.find((item) => item.node_id === "C_md_master")?.decision).toBe("execute");
  });

  it("uses the gate for the latest target artifact after rework", () => {
    const workflow = workflowWithOptionalVideo();
    const artifactsAfterRework = [...artifacts(), { ...artifact("art_plan_v2", "B_content_plan", "markdown", 2, "sha256:plan-v2", "approved"), created_at: "2026-07-22T08:00:02.000Z" }];
    const rejectedV1 = { ...pendingPlanGate(), gate_instance_id: "gate_plan_v1", target: { type: "ArtifactManifest" as const, id: "art_plan_v1" }, status: "decided" as const, decisions: [gateDecision("reject", "2026-07-22T08:00:01.000Z")] };
    const approvedV2 = { ...pendingPlanGate(), gate_instance_id: "gate_plan_v2", target: { type: "ArtifactManifest" as const, id: "art_plan_v2" }, status: "decided" as const, decisions: [gateDecision("approve", "2026-07-22T08:00:03.000Z")] };

    const plan = calculateExecutionPlan({ workflow, nodeRuns: nodeRuns(), artifacts: artifactsAfterRework, gates: [rejectedV1, approvedV2], calculatedAt: now });

    expect(plan.decisions.find((item) => item.node_id === "D_platform_summary")?.decision).toBe("execute");
  });

  it("filters foreign run facts before selecting artifacts and gates", () => {
    const workflow = workflowWithOptionalVideo();
    const approvedCurrentGate = { ...pendingPlanGate(), status: "decided" as const, decisions: [gateDecision("approve", now)] };
    const foreignRun = "run_other";
    const foreignNodeRun = { ...nodeRun("B_content_plan", "done"), run_id: foreignRun, node_run_id: "nr_other_B_content_plan", updated_at: "2026-07-22T09:00:00.000Z" };
    const foreignArtifact = { ...artifact("art_plan_other", "B_content_plan", "markdown", 99, "sha256:other", "approved"), run_id: foreignRun, node_run_id: foreignNodeRun.node_run_id, created_at: "2026-07-22T09:00:00.000Z" };
    const foreignGate = { ...pendingPlanGate(), run_id: foreignRun, target: { type: "ArtifactManifest" as const, id: foreignArtifact.artifact_id } };

    const plan = calculateExecutionPlan({
      workflow,
      runId: "run_p7_02",
      nodeRuns: [...nodeRuns(), foreignNodeRun],
      artifacts: [...artifacts(), foreignArtifact],
      gates: [foreignGate, approvedCurrentGate],
      calculatedAt: now
    });

    expect(plan.decisions.find((item) => item.node_id === "C_md_master")).toMatchObject({ decision: "execute", resolved_inputs: [expect.objectContaining({ artifact_id: "art_plan_v1" })] });
    expect(plan.decisions.find((item) => item.node_id === "D_platform_summary")?.decision).toBe("execute");
  });

  it("uses the referenced ArtifactSpec type when a port omits artifact_type", () => {
    const workflow = workflowWithOptionalVideo();
    workflow.gates = [];
    const contentPlan = workflow.nodes.find((item) => item.id === "C_md_master")!;
    contentPlan.inputs = [{ id: "content_plan", kind: "artifact", required: true, artifact_spec_ref: "plan_artifact" }];
    const planEdge = workflow.edges.find((item) => item.from === "B_content_plan" && item.to === "C_md_master")!;
    delete planEdge.artifact_selector;
    workflow.artifacts.push(artifactSpec("plan_json_artifact", "json", "B_content_plan"));
    const wrongArtifact = artifact("art_plan_json", "B_content_plan", "json", 2, "sha256:json", "approved");

    const plan = calculateExecutionPlan({ workflow, nodeRuns: nodeRuns(), artifacts: [wrongArtifact], gates: [], calculatedAt: now });

    expect(plan.decisions.find((item) => item.node_id === "C_md_master")).toMatchObject({ decision: "blocked", reason_code: "required_input_missing", resolved_inputs: [] });
  });

  it("projects terminal runs from terminal node facts without dispatching end nodes", () => {
    const workflow = workflowWithOptionalVideo();
    const terminalRuns = nodeRuns().map((item) => (item.node_id === "G_end" ? { ...item, status: "skipped" as const } : { ...item, status: "done" as const }));

    const plan = calculateExecutionPlan({ workflow, nodeRuns: terminalRuns, artifacts: artifacts(), gates: [], calculatedAt: now });

    expect(plan.decisions.find((item) => item.node_id === "G_end")).toMatchObject({ decision: "skip", reason_code: "node_run_terminal" });
    expect(plan.terminal).toBe(true);
  });
});

function node(id: string, type: WorkflowSpec["nodes"][number]["type"], inputs: WorkflowSpec["nodes"][number]["inputs"], outputs: WorkflowSpec["nodes"][number]["outputs"]): WorkflowSpec["nodes"][number] {
  return {
    id,
    name: id,
    type,
    capability_requirements: ["content.longform_draft"],
    recommended_libraries: [],
    agent_candidates: ["content-agent"],
    inputs,
    outputs,
    failure_policy: { retry: 0, on_missing_input: "blocked", on_provider_failure: "failed" }
  };
}

function port(id: string, kind: "artifact" | "parameter", artifactType: string, required: boolean, artifactSpecRef?: string): WorkflowSpec["nodes"][number]["inputs"][number] {
  return { id, kind, artifact_type: artifactType, required, artifact_spec_ref: artifactSpecRef };
}

function edge(from: string, to: string, required: boolean, artifactSelector?: { artifact_type?: string; review_status?: "none" | "pending_review" | "approved" | "rejected" }, joinPolicy?: WorkflowSpec["edges"][number]["join_policy"]): WorkflowSpec["edges"][number] {
  return {
    from,
    to,
    required,
    artifact_selector: artifactSelector,
    join_policy: joinPolicy ?? { wait_if_active: false, on_timeout: "continue_if_required_inputs_ready", on_no_qualified_artifact: "block_downstream" }
  };
}

function artifactSpec(id: string, type: string, producedBy: string, reviewMode: "none" | "manual" = "none"): WorkflowSpec["artifacts"][number] {
  return {
    id,
    type,
    produced_by: producedBy,
    review_policy: { mode: reviewMode, ...(reviewMode === "manual" ? { gate_spec_id: "plan_review" } : {}) },
    required_for: [],
    versioning: { immutable: true, compare_by: "hash" }
  };
}

function nodeRun(nodeId: string, status: NodeRun["status"]): NodeRun {
  return {
    node_run_id: `nr_${nodeId}`,
    run_id: "run_p7_02",
    node_id: nodeId,
    status,
    updated_at: now,
    upstream_artifacts: [],
    output_artifacts: []
  };
}

function artifact(id: string, nodeId: string, type: string, version: number, hash: string, reviewStatus: ArtifactManifest["review_status"]): ArtifactManifest {
  return {
    artifact_id: id,
    run_id: "run_p7_02",
    node_run_id: `nr_${nodeId}`,
    type,
    version,
    path: `artifacts/${id}`,
    hash,
    status: "created",
    review_status: reviewStatus,
    producer: "content-agent",
    created_at: now
  };
}

function gateDecision(decision: "approve" | "reject" | "request_changes", createdAt: string) {
  return { decision_id: `decision_${decision}_${createdAt}`, actor: "reviewer", decision, comment: decision, created_at: createdAt };
}
