import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  calculateExecutionPlan,
  createAdapterInvocation,
  type ArtifactManifest,
  type GateInstance,
  type NodeRun,
  type ResolvedNodeInput,
  type RunSpec,
  type WorkflowSpec
} from "@miracle/core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureWorkspace = path.join(repoRoot, "fixtures/mvp-workspace/.miracle");
const historicalFixtures = path.join(repoRoot, "apps/sidecar/test/fixtures/historical");
const fakeCodex = path.join(repoRoot, "apps/sidecar/test/fixtures/bin/fake-codex.mjs");

function dispatchIntentPath(runId: string, nodeRunId: string) {
  const prefix = nodeRunId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "node";
  const suffix = createHash("sha256").update(nodeRunId).digest("hex").slice(0, 16);
  return path.join(tempWorkspace, "runs", runId, "dispatches", `${prefix}_${suffix}.json`);
}

function matchingPreparedIntent(runId: string, nodeRunId: string) {
  const dispatchedAt = "2026-07-26T00:00:00.000Z";
  const operationId = `op_${nodeRunId}_${Date.parse(dispatchedAt)}`;
  const attemptId = `attempt_${operationId}`;
  return {
    node_run_id: nodeRunId,
    invocation: {
      operation_id: operationId,
      attempt_id: attemptId,
      run_id: runId,
      node_run_id: nodeRunId,
      node_id: "A_collect",
      adapter_kind: "codex",
      adapter_id: "codex-mock-compatible-adapter",
      provider: "codex-local",
      capability_requirements: ["source.collect", "fact.verify"],
      input_artifacts: [] as string[],
      resolved_inputs: [] as ResolvedNodeInput[],
      expected_outputs: [{ output_id: "clean_events", artifact_type: "json", artifact_spec_ref: "clean_events_artifact", required: true }],
      runtime_control: { timeout_ms: 1_800_000, cancellation_token_id: `cancel_${operationId}`, attempt_workspace: `runtime/${runId}/${nodeRunId}/${attemptId}`, sandbox: "workspace-write" },
      prompt_path: `runtime/${runId}/${nodeRunId}/${attemptId}/prompt.md`,
      output_schema_path: "runtime/schemas/adapter-result-v0.json",
      dispatched_at: dispatchedAt
    },
    decision: { reason_code: "ready", resolved_input_count: 0, resolved_input_ids: [] as string[] },
    event: {
      event_id: `evt_${attemptId}_inputs_resolved`,
      run_id: runId,
      type: "node_inputs_resolved",
      subject: { type: "NodeRun", id: nodeRunId },
      message: `NodeRun ${nodeRunId} resolved 0 input(s); reason_code=ready`,
      created_at: dispatchedAt
    },
    state: "prepared",
    prepared_at: dispatchedAt
  };
}

let tempRoot = "";
let tempWorkspace = "";
let sidecar: ChildProcessWithoutNullStreams | undefined;
let baseUrl = "";
let sidecarOutput = "";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${url}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  const body = (await response.json()) as T;
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}: ${JSON.stringify(body)}`);
  return body;
}

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v0/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Sidecar did not become healthy. Last error: ${String(lastError)}\n${sidecarOutput}`);
}

describe("sidecar api", () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "miracle-sidecar-"));
    tempWorkspace = path.join(tempRoot, ".miracle");
    await cp(fixtureWorkspace, tempWorkspace, { recursive: true });
    const port = 4500 + Math.floor(Math.random() * 1000);
    baseUrl = `http://127.0.0.1:${port}`;
    sidecar = spawn("npm", ["run", "dev", "-w", "apps/sidecar"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MIRACLE_WORKSPACE_DIR: tempWorkspace,
        MIRACLE_SIDECAR_PORT: String(port),
        MIRACLE_IMPORT_ROOTS: historicalFixtures,
        MIRACLE_CODEX_CLI_PATH: process.execPath,
        MIRACLE_CODEX_CLI_ARGUMENT_PREFIX: fakeCodex,
        npm_config_cache: path.join(repoRoot, ".npm-cache")
      }
    });
    sidecar.stdout.on("data", (chunk) => {
      sidecarOutput += chunk.toString();
    });
    sidecar.stderr.on("data", (chunk) => {
      sidecarOutput += chunk.toString();
    });
    await waitForHealth();
  });

  afterAll(async () => {
    sidecar?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it("previews and commits an allowlisted historical run while rejecting an outside source", async () => {
    const sourceRunDir = path.join(historicalFixtures, "w24-minimal");
    const workflowValidation = await fetchJson<{ valid: boolean; errors: unknown[] }>("/api/v0/workflows/content-production-real-v0/validate", { method: "POST", body: JSON.stringify({}) });
    expect(workflowValidation).toMatchObject({ valid: true, errors: [] });

    const preview = await fetchJson<{
      preview: { import_id: string; run_id: string; valid: boolean; projected_counts: { nodes: number; gates: number } };
    }>("/api/v0/historical-imports/preview", {
      method: "POST",
      body: JSON.stringify({ source_run_dir: sourceRunDir, workflow_id: "content-production-real-v0", sample_kind: "w24" })
    });
    expect(preview.preview).toMatchObject({ valid: true, projected_counts: { nodes: 8, gates: 3 } });

    const committed = await fetchJson<{ import_id: string; run_id: string; reused: boolean }>("/api/v0/historical-imports", {
      method: "POST",
      body: JSON.stringify({ source_run_dir: sourceRunDir, workflow_id: "content-production-real-v0", sample_kind: "w24" })
    });
    expect(committed.reused).toBe(false);

    const imported = await fetchJson<{ import_id: string; run_id: string; status: string }>(`/api/v0/historical-imports/${committed.import_id}`);
    expect(imported).toMatchObject({ import_id: committed.import_id, run_id: committed.run_id, status: "committed" });

    const missingImport = await fetch(`${baseUrl}/api/v0/historical-imports/import_0000000000000000`);
    expect(missingImport.status).toBe(404);
    expect(await missingImport.json()).toMatchObject({ error: { code: "historical_import_not_found" } });

    const runs = await fetchJson<{ runs: Array<{ run_id: string; view_meta: { origin: string; mode: string; source_confidence: string; source_meta_available: boolean } }> }>("/api/v0/runs");
    expect(runs.runs.some((run) => run.run_id === committed.run_id)).toBe(true);
    expect(runs.runs.find((run) => run.run_id === committed.run_id)?.view_meta).toEqual({ origin: "historical_import", mode: "historical_readonly", source_confidence: "mixed", source_meta_available: true });

    const schedulerWrite = await fetch(`${baseUrl}/api/v0/runs/${committed.run_id}/scheduler/tick`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dry_run: false })
    });
    expect(schedulerWrite.status).toBe(409);
    expect(await schedulerWrite.json()).toMatchObject({ error: { code: "historical_run_read_only" } });

    const importedRun = await fetchJson<{
      view_meta: { origin: string; mode: string; source_confidence: string; source_meta_available: boolean };
      source_meta: { mode: string; source_run_dir: string; gaps: unknown[] };
      nodes: Array<{ node_run_id: string }>;
      gates: Array<{ gate_instance_id: string }>;
      artifacts: unknown[];
    }>(`/api/v0/runs/${committed.run_id}`);
    expect(importedRun.view_meta).toEqual({ origin: "historical_import", mode: "historical_readonly", source_confidence: "mixed", source_meta_available: true });
    expect(importedRun.source_meta).toMatchObject({ mode: "historical_readonly", source_run_dir: sourceRunDir });
    const nodeWrite = await fetch(`${baseUrl}/api/v0/runs/${committed.run_id}/nodes/${importedRun.nodes[0]?.node_run_id}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(nodeWrite.status).toBe(409);
    expect(await nodeWrite.json()).toMatchObject({ error: { code: "historical_run_read_only" } });

    const factsBefore = await fetchJson<{ events: unknown[] }>(`/api/v0/runs/${committed.run_id}/events`);
    const gateId = importedRun.gates[0]?.gate_instance_id;
    expect(gateId).toBeTruthy();
    const gateDecision = await fetch(`${baseUrl}/api/v0/gates/${gateId}/decision?run_id=${committed.run_id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "reviewer", decision: "approve", comment: "must remain read-only" })
    });
    expect(gateDecision.status).toBe(409);
    expect(await gateDecision.json()).toMatchObject({ error: { code: "historical_run_read_only" } });

    const gateRework = await fetch(`${baseUrl}/api/v0/gates/${gateId}/rework?run_id=${committed.run_id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "reviewer", comment: "must remain read-only" })
    });
    expect(gateRework.status).toBe(409);
    expect(await gateRework.json()).toMatchObject({ error: { code: "historical_run_read_only" } });

    const factsAfter = await fetchJson<{ events: unknown[]; gates: unknown[]; artifacts: unknown[] }>(`/api/v0/runs/${committed.run_id}`);
    const eventsAfter = await fetchJson<{ events: unknown[] }>(`/api/v0/runs/${committed.run_id}/events`);
    expect(eventsAfter.events).toEqual(factsBefore.events);
    expect(factsAfter.gates).toEqual(importedRun.gates);
    expect(factsAfter.artifacts).toEqual(importedRun.artifacts);

    const collaboration = await fetchJson<{ run_id: string; view_meta: { mode: string }; agents: Array<{ active_runs: string[]; current_node_runs: string[]; source_confidence?: string }> }>(`/api/v0/agents/collaboration?run_id=${committed.run_id}`);
    expect(collaboration).toMatchObject({ run_id: committed.run_id, view_meta: { mode: "historical_readonly" } });
    expect(collaboration.agents.some((agent) => agent.active_runs.includes(committed.run_id) && agent.current_node_runs.length > 0 && agent.source_confidence === "observed")).toBe(true);

    const outside = await fetch(`${baseUrl}/api/v0/historical-imports/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_run_dir: tempRoot, workflow_id: "content-production-real-v0", sample_kind: "w24" })
    });
    expect(outside.status).toBe(403);
    expect(await outside.json()).toMatchObject({ error: { code: "source_path_not_allowed" } });

    const unsafeWorkflow = await fetch(`${baseUrl}/api/v0/historical-imports/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_run_dir: sourceRunDir, workflow_id: "../../outside", sample_kind: "w24" })
    });
    expect(unsafeWorkflow.status).toBe(400);
    expect(await unsafeWorkflow.json()).toMatchObject({ error: { code: "invalid_workflow_id" } });
  });

  it("serves Codex CLI health without returning executable secrets or starting a content task", async () => {
    const health = await fetchJson<{ adapter_id: string; status: string; version?: string; authenticated: boolean; reasons: string[] }>("/api/v0/adapters/codex-cli/health");
    expect(health).toEqual({ adapter_id: "codex-cli-real", status: "healthy", executable_path: path.basename(process.execPath), version: "0.142.1", authenticated: true, reasons: [], checked_at: expect.any(String) });

    const refreshed = await fetchJson<{ status: string }>("/api/v0/adapters/codex-cli/health/refresh", { method: "POST", body: JSON.stringify({}) });
    expect(refreshed.status).toBe("healthy");

    const unknownCancel = await fetch(`${baseUrl}/api/v0/operations/op_missing/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    expect(unknownCancel.status).toBe(404);
    expect(await unknownCancel.json()).toMatchObject({ error: { code: "operation_not_found" } });
    await expect(readFile(path.join(tempWorkspace, "runs", "run_001", "attempts.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns a DAG projection with required and optional edges", async () => {
    const body = await fetchJson<{
      dag: { edges: Array<{ label: string; required: boolean }>; nodes: Array<{ id: string; status: string }> };
    }>("/api/v0/runs/run-demo-001/dag");

    expect(body.dag.nodes.some((node) => node.id === "E_tts" && node.status === "blocked")).toBe(true);
    expect(body.dag.edges.some((edge) => edge.label === "required" && edge.required)).toBe(true);
    expect(body.dag.edges.some((edge) => edge.label === "optional" && !edge.required)).toBe(true);
  });

  it("returns artifact preview and refuses paths outside the workspace", async () => {
    const body = await fetchJson<{
      preview: { available: boolean; mode: string; content?: string };
    }>("/api/v0/artifacts/art_md_master_v2?run_id=run-demo-001");

    expect(body.preview.available).toBe(true);
    expect(body.preview.mode).toBe("markdown");
    expect(body.preview.content).toContain("Codex");
  });

  it("records one gate decision and rejects a duplicate decision", async () => {
    const first = await fetchJson<{
      accepted: boolean;
      projection: { projected_artifact_review_status: string; mutates_artifact: boolean };
    }>("/api/v0/gates/gate-md-master-001/decision?run_id=run-demo-001", {
      method: "POST",
      body: JSON.stringify({ decision: "approve", actor: "api-test", comment: "集成测试通过" })
    });
    expect(first.accepted).toBe(true);
    expect(first.projection.projected_artifact_review_status).toBe("approved");
    expect(first.projection.mutates_artifact).toBe(true);

    const artifact = await fetchJson<{
      artifact: { review_status: string };
    }>("/api/v0/artifacts/art_md_master_v2?run_id=run-demo-001");
    expect(artifact.artifact.review_status).toBe("approved");

    const duplicate = await fetch(`${baseUrl}/api/v0/gates/gate-md-master-001/decision?run_id=run-demo-001`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" })
    });
    expect(duplicate.status).toBe(409);
  });

  it("approves a generated gate and queues downstream nodes through selectors", async () => {
    const created = await fetchJson<{
      run_id: string;
      initial_node_runs: string[];
    }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
    });

    await fetchJson(`/api/v0/runs/${created.run_id}/nodes/${created.initial_node_runs[0]}/execute`, { method: "POST", body: JSON.stringify({}) });
    const afterCollect = await fetchJson<{ nodes: Array<{ node_run_id: string; node_id: string; status: string }> }>(`/api/v0/runs/${created.run_id}`);
    const mdNode = afterCollect.nodes.find((node) => node.node_id === "B_md_master");
    if (!mdNode) throw new Error("Expected B_md_master node");
    expect(mdNode.status).toBe("queued");

    const mdExecution = await fetchJson<{
      committed: { node_run: { status: string }; gates: Array<{ gate_instance_id: string }> };
    }>(`/api/v0/runs/${created.run_id}/nodes/${mdNode.node_run_id}/execute`, { method: "POST", body: JSON.stringify({}) });
    expect(mdExecution.committed.node_run.status).toBe("reviewing");
    const gateId = mdExecution.committed.gates[0]?.gate_instance_id;
    expect(gateId).toBeTruthy();

    const workflowPath = path.join(tempWorkspace, "workflows", "content-production-v0.json");
    const originalWorkflowRaw = await readFile(workflowPath, "utf8");
    let afterGate: {
      nodes: Array<{ node_id: string; status: string }>;
      artifacts: Array<{ node_run_id: string; type: string; review_status: string }>;
    };
    try {
      const workflow = JSON.parse(originalWorkflowRaw) as { edges: Array<{ from: string; to: string }> };
      workflow.edges = workflow.edges.filter((edge) => !(edge.from === "B_md_master" && edge.to === "G_distribution"));
      await writeFile(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");

      await fetchJson(`/api/v0/gates/${gateId}/decision?run_id=${created.run_id}`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve", actor: "api-test", comment: "通过后推进主链路" })
      });

      afterGate = await fetchJson(`/api/v0/runs/${created.run_id}`);
    } finally {
      await writeFile(workflowPath, originalWorkflowRaw, "utf8");
    }
    expect(afterGate.nodes.find((node) => node.node_id === "B_md_master")?.status).toBe("done");
    expect(afterGate.nodes.find((node) => node.node_id === "C_script")?.status).toBe("queued");
    expect(afterGate.nodes.find((node) => node.node_id === "G_distribution")?.status).toBe("queued");
    expect(afterGate.artifacts.some((artifact) => artifact.type === "markdown" && artifact.review_status === "approved")).toBe(true);
  });

  it("creates a rework attempt with a new artifact version after gate reject", async () => {
    const created = await fetchJson<{
      run_id: string;
      initial_node_runs: string[];
    }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
    });

    await fetchJson(`/api/v0/runs/${created.run_id}/nodes/${created.initial_node_runs[0]}/execute`, { method: "POST", body: JSON.stringify({}) });
    const afterCollect = await fetchJson<{ nodes: Array<{ node_run_id: string; node_id: string }> }>(`/api/v0/runs/${created.run_id}`);
    const mdNode = afterCollect.nodes.find((node) => node.node_id === "B_md_master");
    if (!mdNode) throw new Error("Expected B_md_master node");

    const mdExecution = await fetchJson<{
      committed: { gates: Array<{ gate_instance_id: string }>; artifacts: Array<{ artifact_id: string; version: number }> };
    }>(`/api/v0/runs/${created.run_id}/nodes/${mdNode.node_run_id}/execute`, { method: "POST", body: JSON.stringify({}) });
    const rejectedGateId = mdExecution.committed.gates[0]?.gate_instance_id;
    const rejectedArtifactId = mdExecution.committed.artifacts[0]?.artifact_id;
    if (!rejectedGateId || !rejectedArtifactId) throw new Error("Expected generated gate and artifact");

    await fetchJson(`/api/v0/gates/${rejectedGateId}/decision?run_id=${created.run_id}`, {
      method: "POST",
      body: JSON.stringify({ decision: "reject", actor: "api-test", comment: "需要补充事实来源" })
    });

    const rejectedPlan = await fetchJson<{
      stop_reason: string;
      next_suggested_actions: string[];
      execution_plan: { decisions: Array<{ node_run_id: string; reason_code: string }> };
    }>(`/api/v0/runs/${created.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    const rejectedDecision = rejectedPlan.execution_plan.decisions.find((decision) => decision.reason_code === "required_gate_rejected");
    if (!rejectedDecision) throw new Error("Expected a rejected gate Scheduler decision");
    const rejectedDetail = await fetchJson<{
      execution_decision: { reason_code: string };
      next_suggested_actions: string[];
    }>(`/api/v0/runs/${created.run_id}/nodes/${rejectedDecision.node_run_id}`);
    expect(rejectedPlan.stop_reason).toBe("attention_required");
    expect(rejectedPlan.next_suggested_actions).toEqual([
      "inspect_attention",
      "restore_required_artifact",
      "rerun_upstream_node",
      "retry_manually"
    ]);
    expect(rejectedDetail.execution_decision.reason_code).toBe("required_gate_rejected");
    expect(rejectedDetail.next_suggested_actions).toEqual(["inspect_gate", "create_rework"]);

    const attentionPath = path.join(tempWorkspace, "runs", created.run_id, "attention.json");
    const gateOnlyAttention = JSON.parse(await readFile(attentionPath, "utf8")) as Array<Record<string, unknown>>;
    await writeFile(attentionPath, `${JSON.stringify([
      ...gateOnlyAttention,
      {
        attention_id: "att_parallel_runtime_blocker",
        root_cause_key: `run:${created.run_id}:node:parallel:credential_missing`,
        title: "并行运行凭证缺失",
        severity: "P0",
        status: "open",
        related_objects: [{ type: "NodeRun", id: "parallel-runtime-node" }],
        impact: { blocked_nodes: ["parallel-runtime-node"], waiting_agents: [], unaffected_paths: [] },
        safe_actions: ["configure_credentials"]
      }
    ], null, 2)}\n`, "utf8");
    const mixedBlockers = await fetchJson<{
      stop_reason: string;
      next_suggested_actions: string[];
    }>(`/api/v0/runs/${created.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    expect(mixedBlockers.stop_reason).toBe("attention_required");
    expect(mixedBlockers.next_suggested_actions).toContain("inspect_attention");
    expect(mixedBlockers.next_suggested_actions).not.toContain("create_rework");
    await writeFile(attentionPath, `${JSON.stringify(gateOnlyAttention, null, 2)}\n`, "utf8");

    const rework = await fetchJson<{
      accepted: boolean;
      rework_attempt_id: string;
      artifact: { artifact_id: string; version: number; review_status: string; supersedes_artifact_id: string };
      gate: { gate_instance_id: string; status: string; target: { id: string } };
    }>(`/api/v0/gates/${rejectedGateId}/rework?run_id=${created.run_id}`, {
      method: "POST",
      body: JSON.stringify({ actor: "api-test", comment: "返工后重新提交" })
    });

    expect(rework.accepted).toBe(true);
    expect(rework.artifact.version).toBe(2);
    expect(rework.artifact.review_status).toBe("pending_review");
    expect(rework.artifact.supersedes_artifact_id).toBe(rejectedArtifactId);
    expect(rework.gate.status).toBe("pending_review");
    expect(rework.gate.target.id).toBe(rework.artifact.artifact_id);

    const afterRework = await fetchJson<{
      nodes: Array<{ node_id: string; status: string; blocked_reason?: string; output_artifacts: string[] }>;
      artifacts: Array<{ artifact_id: string; review_status: string }>;
      gates: Array<{ gate_instance_id: string; status: string }>;
    }>(`/api/v0/runs/${created.run_id}`);
    expect(afterRework.artifacts.find((artifact) => artifact.artifact_id === rejectedArtifactId)?.review_status).toBe("rejected");
    expect(afterRework.nodes.find((node) => node.node_id === "B_md_master")?.status).toBe("reviewing");
    expect(afterRework.nodes.find((node) => node.node_id === "B_md_master")?.output_artifacts).toContain(rework.artifact.artifact_id);
    expect(afterRework.nodes.find((node) => node.node_id === "C_script")?.status).toBe("blocked");
    expect(afterRework.nodes.find((node) => node.node_id === "G_distribution")?.blocked_reason).toContain(rework.gate.gate_instance_id);

    await fetchJson(`/api/v0/gates/${rework.gate.gate_instance_id}/decision?run_id=${created.run_id}`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", actor: "api-test", comment: "返工通过" })
    });

    const afterApprove = await fetchJson<{
      nodes: Array<{ node_id: string; status: string; upstream_artifacts: string[] }>;
      artifacts: Array<{ artifact_id: string; review_status: string }>;
    }>(`/api/v0/runs/${created.run_id}`);
    expect(afterApprove.artifacts.find((artifact) => artifact.artifact_id === rework.artifact.artifact_id)?.review_status).toBe("approved");
    expect(afterApprove.nodes.find((node) => node.node_id === "C_script")?.status).toBe("queued");
    expect(afterApprove.nodes.find((node) => node.node_id === "G_distribution")?.status).toBe("queued");
    expect(afterApprove.nodes.find((node) => node.node_id === "C_script")?.upstream_artifacts).toContain(rework.artifact.artifact_id);
  });

  it("releases the GateDecision mutation lock before immediate rework responses", async () => {
    for (let index = 0; index < 4; index += 1) {
      const created = await fetchJson<{ run_id: string; initial_node_runs: string[] }>("/api/v0/runs", {
        method: "POST",
        body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
      });
      await fetchJson(`/api/v0/runs/${created.run_id}/nodes/${created.initial_node_runs[0]}/execute`, { method: "POST", body: JSON.stringify({}) });
      const run = await fetchJson<{ nodes: Array<{ node_run_id: string; node_id: string }> }>(`/api/v0/runs/${created.run_id}`);
      const mdNode = run.nodes.find((node) => node.node_id === "B_md_master");
      if (!mdNode) throw new Error("Expected B_md_master node");
      const execution = await fetchJson<{ committed: { gates: Array<{ gate_instance_id: string }> } }>(`/api/v0/runs/${created.run_id}/nodes/${mdNode.node_run_id}/execute`, {
        method: "POST",
        body: JSON.stringify({})
      });
      const gateId = execution.committed.gates[0]?.gate_instance_id;
      if (!gateId) throw new Error("Expected generated gate");

      const prematureRework = await fetch(`${baseUrl}/api/v0/gates/${gateId}/rework?run_id=${created.run_id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: "api-test", comment: "before decision" })
      });
      expect(prematureRework.status).toBe(409);

      await fetchJson(`/api/v0/gates/${gateId}/decision?run_id=${created.run_id}`, {
        method: "POST",
        body: JSON.stringify({ decision: "reject", actor: "api-test", comment: `immediate rework ${index}` })
      });
      const duplicateDecision = await fetch(`${baseUrl}/api/v0/gates/${gateId}/decision?run_id=${created.run_id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "reject", actor: "api-test", comment: "duplicate decision" })
      });
      expect(duplicateDecision.status).toBe(409);
      const rework = await fetch(`${baseUrl}/api/v0/gates/${gateId}/rework?run_id=${created.run_id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: "api-test", comment: "immediately after decision" })
      });
      expect(rework.status).toBe(201);
    }
  });

  it("rejects gate decisions while a gate operation lock exists", async () => {
    const created = await fetchJson<{
      run_id: string;
      initial_node_runs: string[];
    }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
    });

    await fetchJson(`/api/v0/runs/${created.run_id}/nodes/${created.initial_node_runs[0]}/execute`, { method: "POST", body: JSON.stringify({}) });
    const afterCollect = await fetchJson<{ nodes: Array<{ node_run_id: string; node_id: string }> }>(`/api/v0/runs/${created.run_id}`);
    const mdNode = afterCollect.nodes.find((node) => node.node_id === "B_md_master");
    if (!mdNode) throw new Error("Expected B_md_master node");
    const mdExecution = await fetchJson<{
      committed: { gates: Array<{ gate_instance_id: string }> };
    }>(`/api/v0/runs/${created.run_id}/nodes/${mdNode.node_run_id}/execute`, { method: "POST", body: JSON.stringify({}) });
    const gateId = mdExecution.committed.gates[0]?.gate_instance_id;
    if (!gateId) throw new Error("Expected generated gate");

    const lockName = created.run_id.replace(/[^a-zA-Z0-9._-]/g, "_");
    const lockDir = path.join(tempWorkspace, "runs", created.run_id, "locks", `${lockName}.mutation.lock`);
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({
        instance_id: "concurrent-sidecar",
        owner_token: "gate-test-lock",
        pid: process.pid,
        created_at: new Date().toISOString()
      })}\n`,
      "utf8"
    );

    const locked = await fetch(`${baseUrl}/api/v0/gates/${gateId}/decision?run_id=${created.run_id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", actor: "api-test" })
    });
    expect(locked.status).toBe(409);
    await rm(lockDir, { recursive: true, force: true });
  });

  it("saves and reads a canvas draft", async () => {
    const current = await fetchJson<{
      draft: { objects: Array<{ id: string; x: number; y: number }> };
    }>("/api/v0/workflows/content-production-v0/canvas-draft");
    const moved = current.draft.objects.map((object, index) => (index === 0 ? { ...object, x: object.x + 12, y: object.y + 8 } : object));

    const saved = await fetchJson<{
      accepted: boolean;
      draft: { objects: Array<{ id: string; x: number; y: number }> };
    }>("/api/v0/workflows/content-production-v0/canvas-draft", {
      method: "POST",
      body: JSON.stringify({ objects: moved })
    });

    expect(saved.accepted).toBe(true);
    expect(saved.draft.objects[0].x).toBe(moved[0].x);
  });

  it("creates a Canvas NodeSpec draft with validate-before-save", async () => {
    const current = await fetchJson<{
      draft: { objects: Array<{ id: string; x: number; y: number }> };
    }>("/api/v0/workflows/content-production-v0/canvas-draft");
    const moved = current.draft.objects.map((object, index) => (index === 0 ? { ...object, x: object.x + 24, y: object.y + 16 } : object));
    const created = await fetchJson<{
      accepted: boolean;
      draft: { objects: Array<{ id: string; x: number; y: number }> };
      node_object: { ref_id: string; node_spec_draft: { status: string; node_spec: { id: string; capability_requirements: string[] } } };
      validation: { valid: boolean; errors: unknown[] };
      spec_diff_preview: { operations: Array<{ op: string; path: string }> };
    }>("/api/v0/workflows/content-production-v0/canvas-draft/nodes", {
      method: "POST",
      body: JSON.stringify({
        objects: moved,
        title: "Pencil 原型设计",
        capability: "prototype.pencil",
        zone_id: "content"
      })
    });

    expect(created.accepted).toBe(true);
    expect(created.validation.valid).toBe(true);
    expect(created.node_object.node_spec_draft.status).toBe("ready");
    expect(created.node_object.node_spec_draft.node_spec.capability_requirements).toEqual(["prototype.pencil"]);
    expect(created.draft.objects.find((object) => object.id === moved[0]?.id)?.x).toBe(moved[0]?.x);
    expect(created.spec_diff_preview.operations.some((operation) => operation.op === "add" && operation.path === "/nodes/-")).toBe(true);

    const draft = await fetchJson<{
      draft: { objects: Array<{ ref_id?: string; node_spec_draft?: { node_spec: { id: string } } }> };
      validation: { valid: boolean };
    }>("/api/v0/workflows/content-production-v0/canvas-draft");
    expect(draft.validation.valid).toBe(true);
    expect(draft.draft.objects.some((object) => object.ref_id === created.node_object.node_spec_draft.node_spec.id && object.node_spec_draft)).toBe(true);
  });

  it("publishes a canvas draft as a validated Workflow draft", async () => {
    const created = await fetchJson<{
      node_object: { node_spec_draft: { node_spec: { id: string } } };
    }>("/api/v0/workflows/content-production-v0/canvas-draft/nodes", {
      method: "POST",
      body: JSON.stringify({ title: "内容精细策划", capability: "content.refine_plan", zone_id: "content" })
    });

    const published = await fetchJson<{
      accepted: boolean;
      workflow_id: string;
      validation: { valid: boolean };
    }>("/api/v0/workflows/content-production-v0/canvas-draft/publish", {
      method: "POST",
      body: JSON.stringify({})
    });

    expect(published.accepted).toBe(true);
    expect(published.workflow_id).toContain("content-production-v0-canvas-draft");
    expect(published.validation.valid).toBe(true);

    const detail = await fetchJson<{
      workflow: { id: string; registry_meta: { status: string }; nodes: Array<{ id: string; capability_requirements: string[] }> };
    }>(`/api/v0/workflows/${published.workflow_id}`);
    expect(detail.workflow.registry_meta.status).toBe("draft");
    expect(detail.workflow.nodes.some((node) => node.id === created.node_object.node_spec_draft.node_spec.id && node.capability_requirements.includes("content.refine_plan"))).toBe(true);
  });

  it("returns adapter manifests with credential status", async () => {
    const body = await fetchJson<{
      adapters: Array<{ id: string; kind: string; execution_mode: string; executable: boolean; credential_status: Array<{ key: string; configured: boolean }>; health?: { ready: boolean; status: string; authenticated: boolean; reasons: string[] } }>;
      summary: { total: number; executable: number; missing_credentials: string[] };
    }>("/api/v0/adapters");

    expect(body.summary.total).toBeGreaterThanOrEqual(6);
    expect(body.summary.executable).toBeGreaterThanOrEqual(2);
    expect(body.summary.missing_credentials).toContain("PROVIDER_API_KEY");
    expect(body.adapters.map((adapter) => adapter.kind)).toEqual(expect.arrayContaining(["mock-local", "codex", "hermes", "openclaw", "official-api"]));
    expect(body.adapters.find((adapter) => adapter.id === "codex-mock-compatible-adapter")).toMatchObject({ execution_mode: "mock-compatible", executable: true });
    expect(body.adapters.find((adapter) => adapter.id === "codex-cli-real")).toMatchObject({ execution_mode: "shell", executable: false, health: { ready: true, status: "healthy", authenticated: true, reasons: [] } });
    expect(body.adapters.find((adapter) => adapter.id === "official-api-adapter-shell")?.credential_status.some((credential) => credential.key === "PROVIDER_API_KEY" && !credential.configured)).toBe(true);
  });

  it("rejects a mismatched AdapterResult before committing NodeAttempt, Artifact or Trace facts", async () => {
    const created = await fetchJson<{ run_id: string; initial_node_runs: string[] }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
    });
    const runDir = path.join(tempWorkspace, "runs", created.run_id);
    const nodesPath = path.join(runDir, "nodes.json");
    const nodes = JSON.parse(await readFile(nodesPath, "utf8")) as Array<{ node_run_id: string; status: string; provider?: string }>;
    const target = nodes.find((node) => node.node_run_id === created.initial_node_runs[0]);
    if (!target) throw new Error("Expected initial NodeRun");
    target.provider = "mock-invalid-receipt";
    await writeFile(nodesPath, `${JSON.stringify(nodes, null, 2)}\n`, "utf8");

    const beforeAttempts = JSON.parse(await readFile(path.join(runDir, "attempts.json"), "utf8"));
    const beforeArtifacts = JSON.parse(await readFile(path.join(runDir, "artifacts.json"), "utf8"));
    const response = await fetch(`${baseUrl}/api/v0/runs/${created.run_id}/nodes/${target.node_run_id}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "sidecar_error" } });

    const after = await fetchJson<{ nodes: Array<{ node_run_id: string; status: string }> }>(`/api/v0/runs/${created.run_id}`);
    expect(after.nodes.find((node) => node.node_run_id === target.node_run_id)?.status).toBe("queued");
    expect(JSON.parse(await readFile(path.join(runDir, "attempts.json"), "utf8"))).toEqual(beforeAttempts);
    expect(JSON.parse(await readFile(path.join(runDir, "artifacts.json"), "utf8"))).toEqual(beforeArtifacts);
    const events = (await readFile(path.join(runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; event_id: string });
    expect(events.filter((event) => event.type === "node_inputs_resolved")).toHaveLength(1);
    expect(new Set(events.filter((event) => event.type === "node_inputs_resolved").map((event) => event.event_id)).size).toBe(1);

    const replay = await fetch(`${baseUrl}/api/v0/runs/${created.run_id}/nodes/${target.node_run_id}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(replay.status).toBe(409);
    const replayEvents = (await readFile(path.join(runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; event_id: string });
    expect(replayEvents.filter((event) => event.type === "node_inputs_resolved")).toHaveLength(1);
  });

  it("fails closed for malformed dispatch intents without dispatching a duplicate Adapter invocation", async () => {
    const created = await fetchJson<{ run_id: string; initial_node_runs: string[] }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
    });
    const nodeRunId = created.initial_node_runs[0]!;
    const runDir = path.join(tempWorkspace, "runs", created.run_id);
    const intentPath = dispatchIntentPath(created.run_id, nodeRunId);
    await mkdir(path.dirname(intentPath), { recursive: true });

    await writeFile(intentPath, "{malformed", "utf8");
    const malformedJson = await fetch(`${baseUrl}/api/v0/runs/${created.run_id}/nodes/${nodeRunId}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(malformedJson.status).toBe(500);

    await writeFile(intentPath, "{}\n", "utf8");
    const malformedIntent = await fetch(`${baseUrl}/api/v0/runs/${created.run_id}/nodes/${nodeRunId}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(malformedIntent.status).toBe(500);

    const operationId = `op_${nodeRunId}_0`;
    await writeFile(intentPath, `${JSON.stringify({
      node_run_id: nodeRunId,
      invocation: {
        operation_id: operationId,
        attempt_id: `attempt_${operationId}`,
        run_id: "foreign-run",
        node_run_id: nodeRunId,
        node_id: "A_collect",
        adapter_kind: "codex",
        adapter_id: "codex-mock-compatible-adapter",
        provider: "codex-local",
        capability_requirements: [],
        input_artifacts: [],
        resolved_inputs: [],
        expected_outputs: [],
        runtime_control: { timeout_ms: 1, cancellation_token_id: "cancel_foreign", attempt_workspace: "runtime/foreign", sandbox: "workspace-write" },
        prompt_path: "runtime/foreign/prompt.md",
        output_schema_path: "runtime/foreign/schema.json",
        dispatched_at: "2026-07-26T00:00:00.000Z"
      },
      decision: { reason_code: "ready", resolved_input_count: 0, resolved_input_ids: [] },
      event: {
        event_id: `evt_attempt_${operationId}_inputs_resolved`,
        run_id: "foreign-run",
        type: "node_inputs_resolved",
        subject: { type: "NodeRun", id: nodeRunId },
        message: "foreign shaped intent",
        created_at: "2026-07-26T00:00:00.000Z"
      },
      state: "prepared",
      prepared_at: "2026-07-26T00:00:00.000Z"
    }, null, 2)}\n`, "utf8");
    const foreignIntent = await fetch(`${baseUrl}/api/v0/runs/${created.run_id}/nodes/${nodeRunId}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(foreignIntent.status).toBe(500);

    expect(JSON.parse(await readFile(path.join(runDir, "attempts.json"), "utf8"))).toEqual([]);
    const events = (await readFile(path.join(runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.filter((event) => event.type === "node_inputs_resolved")).toEqual([]);
  });

  it("rejects semantically stale prepared intents and still resumes a complete prepared intent", async () => {
    const assertRejected = async (mutate: (intent: ReturnType<typeof matchingPreparedIntent>) => void) => {
      const created = await fetchJson<{ run_id: string; initial_node_runs: string[] }>("/api/v0/runs", {
        method: "POST",
        body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
      });
      const nodeRunId = created.initial_node_runs[0]!;
      const intent = matchingPreparedIntent(created.run_id, nodeRunId);
      mutate(intent);
      const intentPath = dispatchIntentPath(created.run_id, nodeRunId);
      await mkdir(path.dirname(intentPath), { recursive: true });
      await writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`, "utf8");

      const response = await fetch(`${baseUrl}/api/v0/runs/${created.run_id}/nodes/${nodeRunId}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      expect(response.status).toBe(500);
      const run = await fetchJson<{ attempts: unknown[]; artifacts: unknown[] }>(`/api/v0/runs/${created.run_id}`);
      expect(run.attempts).toEqual([]);
      expect(run.artifacts).toEqual([]);
      const events = (await readFile(path.join(tempWorkspace, "runs", created.run_id, "events.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string });
      expect(events.filter((event) => event.type === "node_inputs_resolved")).toEqual([]);
    };

    await assertRejected((intent) => { intent.invocation.expected_outputs = []; });
    await assertRejected((intent) => { delete (intent.event as Partial<typeof intent.event>).message; });
    await assertRejected((intent) => { delete (intent as Partial<typeof intent>).prepared_at; });
    await assertRejected((intent) => {
      intent.invocation.resolved_inputs = [{
        input_id: "stale_input",
        source_kind: "run_input",
        source_ref: "stale",
        media_type: "text/plain",
        required: false,
        resolved_at: "2026-07-26T00:00:00.000Z"
      }];
      intent.decision = { reason_code: "ready", resolved_input_count: 1, resolved_input_ids: ["stale_input"] };
    });
    await assertRejected((intent) => { intent.invocation.provider = "tampered-provider"; });
    await assertRejected((intent) => { intent.invocation.adapter_kind = "mock-local"; intent.invocation.adapter_id = "mock-local-adapter"; });
    await assertRejected((intent) => { intent.invocation.input_artifacts = ["tampered-artifact"]; });
    await assertRejected((intent) => { intent.invocation.runtime_control.timeout_ms = 1; });
    await assertRejected((intent) => { intent.invocation.runtime_control.sandbox = "read-only"; });
    await assertRejected((intent) => { intent.invocation.prompt_path = "runtime/tampered/prompt.md"; });
    await assertRejected((intent) => { intent.invocation.output_schema_path = "runtime/tampered/schema.json"; });

    const resumed = await fetchJson<{ run_id: string; initial_node_runs: string[] }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
    });
    const resumedNodeRunId = resumed.initial_node_runs[0]!;
    const intentPath = dispatchIntentPath(resumed.run_id, resumedNodeRunId);
    await mkdir(path.dirname(intentPath), { recursive: true });
    await writeFile(intentPath, `${JSON.stringify(matchingPreparedIntent(resumed.run_id, resumedNodeRunId), null, 2)}\n`, "utf8");
    const response = await fetchJson<{ accepted: boolean; invocation: { attempt_id: string } }>(`/api/v0/runs/${resumed.run_id}/nodes/${resumedNodeRunId}/execute`, {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(response).toMatchObject({ accepted: true, invocation: { attempt_id: matchingPreparedIntent(resumed.run_id, resumedNodeRunId).invocation.attempt_id } });
  });

  it("fails closed for source_kind-only Artifact input tampering and rebuilds trusted input events", async () => {
    const created = await fetchJson<{ run_id: string; initial_node_runs: string[] }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
    });
    await fetchJson(`/api/v0/runs/${created.run_id}/nodes/${created.initial_node_runs[0]}/execute`, { method: "POST", body: JSON.stringify({}) });
    const bundle = await fetchJson<{
      run: RunSpec;
      workflow: WorkflowSpec;
      nodes: NodeRun[];
      artifacts: ArtifactManifest[];
      gates: GateInstance[];
    }>(`/api/v0/runs/${created.run_id}`);
    const nodeRun = bundle.nodes.find((node) => node.node_id === "B_md_master");
    const nodeSpec = bundle.workflow.nodes.find((node) => node.id === "B_md_master");
    if (!nodeRun || !nodeSpec) throw new Error("Expected B_md_master downstream facts");
    const plan = calculateExecutionPlan({
      runId: created.run_id,
      workflowSnapshotId: bundle.run.workflow_snapshot_id,
      workflow: bundle.workflow,
      nodeRuns: bundle.nodes,
      artifacts: bundle.artifacts,
      gates: bundle.gates,
      calculatedAt: "2026-07-26T00:00:00.000Z"
    });
    const decision = plan.decisions.find((item) => item.node_run_id === nodeRun.node_run_id);
    if (!decision || decision.decision !== "execute") throw new Error("Expected executable B_md_master decision");
    const dispatchedAt = "2026-07-26T00:00:00.000Z";
    const invocation = createAdapterInvocation({
      runSpec: bundle.run,
      workflow: bundle.workflow,
      nodeRun,
      createdAt: dispatchedAt,
      adapterKind: "codex",
      adapterId: "codex-mock-compatible-adapter",
      resolvedInputs: decision.resolved_inputs.map((input) => ({ ...input, resolved_at: dispatchedAt }))
    });
    const trustedInvocation = structuredClone(invocation);
    const prepared = {
      node_run_id: nodeRun.node_run_id,
      invocation: structuredClone(invocation),
      decision: { reason_code: decision.reason_code, resolved_input_count: invocation.resolved_inputs.length, resolved_input_ids: invocation.resolved_inputs.map((input) => input.input_id) },
      event: {
        event_id: `evt_${invocation.attempt_id}_inputs_resolved`,
        run_id: created.run_id,
        type: "node_inputs_resolved",
        subject: { type: "NodeRun", id: nodeRun.node_run_id },
        message: "SECRET_ARTIFACT_CONTENT must never be persisted",
        created_at: "2020-01-01T00:00:00.000Z",
        secret: "do-not-trust"
      },
      state: "prepared",
      prepared_at: dispatchedAt
    };
    const intentPath = dispatchIntentPath(created.run_id, nodeRun.node_run_id);
    await mkdir(path.dirname(intentPath), { recursive: true });
    prepared.invocation.resolved_inputs[0]!.source_kind = "parameter";
    await writeFile(intentPath, `${JSON.stringify(prepared, null, 2)}\n`, "utf8");
    const tampered = await fetch(`${baseUrl}/api/v0/runs/${created.run_id}/nodes/${nodeRun.node_run_id}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(tampered.status).toBe(500);
    const afterTamper = await fetchJson<{ attempts: unknown[]; artifacts: ArtifactManifest[] }>(`/api/v0/runs/${created.run_id}`);
    expect(afterTamper.attempts).toHaveLength(1);
    expect(afterTamper.artifacts).toHaveLength(1);

    prepared.invocation = trustedInvocation;
    await writeFile(intentPath, `${JSON.stringify(prepared, null, 2)}\n`, "utf8");
    const resumed = await fetchJson<{ accepted: boolean }>(`/api/v0/runs/${created.run_id}/nodes/${nodeRun.node_run_id}/execute`, { method: "POST", body: JSON.stringify({}) });
    expect(resumed.accepted).toBe(true);
    const events = await fetchJson<{ events: Array<{ type: string; message: string; created_at: string }>}>(`/api/v0/runs/${created.run_id}/events`);
    const inputEvent = events.events.find((event) => event.type === "node_inputs_resolved" && event.message.includes(nodeRun.node_run_id));
    expect(inputEvent).toMatchObject({ created_at: dispatchedAt });
    expect(JSON.stringify(inputEvent)).not.toContain("SECRET_ARTIFACT_CONTENT");
    expect(JSON.stringify(inputEvent)).not.toContain("do-not-trust");
  });

  it("surfaces invalid adapter manifests instead of falling back silently", async () => {
    const badManifestPath = path.join(tempWorkspace, "adapters", "broken.json");
    await writeFile(badManifestPath, `${JSON.stringify({ id: "broken-adapter" }, null, 2)}\n`, "utf8");
    try {
      const response = await fetch(`${baseUrl}/api/v0/adapters`);
      const body = (await response.json()) as { error?: { code: string; message: string } };

      expect(response.status).toBe(500);
      expect(body.error?.code).toBe("sidecar_error");
      expect(body.error?.message).toContain("Invalid input");
    } finally {
      await rm(badManifestPath, { force: true });
    }
  });

  it("uses the same adapter fallback rule in dry-run routing as execution", async () => {
    const body = await fetchJson<{
      adapter_routing: Array<{ node_id: string; selected_adapter_id?: string; selected_adapter_kind?: string; executable: boolean }>;
    }>("/api/v0/workflows/content-production-v0/dry-run", {
      method: "POST",
      body: JSON.stringify({})
    });

    expect(body.adapter_routing.find((route) => route.node_id === "B_md_master")).toMatchObject({
      selected_adapter_id: "codex-mock-compatible-adapter",
      selected_adapter_kind: "codex",
      executable: true
    });
    expect(body.adapter_routing.find((route) => route.node_id === "E_tts")).toMatchObject({
      selected_adapter_id: "mock-local-adapter",
      selected_adapter_kind: "mock-local",
      executable: true
    });
  });

  it.each([
    { name: "keychain credential", source: "keychain", status: "experimental", credential: "MODEL_API_FIXTURE_CREDENTIAL" },
    { name: "missing env credential", source: "env", status: "experimental", credential: "MODEL_API_MISSING_CREDENTIAL" },
    { name: "blocked adapter", source: "env", status: "blocked", credential: "MODEL_API_FIXTURE_CREDENTIAL" }
  ])("does not route a non-executable Model API adapter in dry-run: $name", async ({ source, status, credential }) => {
    const manifestPath = path.join(tempWorkspace, "adapters", "model-api.json");
    const workflowPath = path.join(tempWorkspace, "workflows", "model-api-unavailable-v0.json");
    const originalManifest = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(originalManifest) as Record<string, unknown>;
    const profiles = manifest.provider_profiles as Array<Record<string, unknown>>;
    manifest.status = status;
    manifest.required_credentials = [{ key: credential, label: "Fixture credential", source, required: true, providers: ["fixture-compatible"] }];
    manifest.provider_profiles = [profiles[0]!];
    profiles[0]!.credential_ref = credential;
    const workflow = {
      id: "model-api-unavailable-v0",
      name: "Unavailable model API dry-run",
      version: "0.1.0",
      domain: "test",
      category: "test",
      nodes: [{ id: "model_call", name: "Model call", type: "agent", capability_requirements: ["model.call"], recommended_libraries: [], agent_candidates: [], inputs: [], outputs: [], failure_policy: { retry: 0, on_missing_input: "blocked", on_provider_failure: "failed" } }],
      edges: [],
      gates: [],
      artifacts: [],
      provider_policy: { default_provider: "fixture-compatible", allowed_providers: ["fixture-compatible"], required_credentials: [credential], fallback_providers: [] },
      layouts: { dag: { model_call: { x: 0, y: 0 } } },
      registry_meta: { source: "test", status: "experimental" }
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
    try {
      const body = await fetchJson<{
        adapter_routing: Array<{ node_id: string; selected_adapter_id?: string; executable: boolean; missing_capabilities: string[] }>;
      }>("/api/v0/workflows/model-api-unavailable-v0/dry-run", { method: "POST", body: JSON.stringify({}) });

      expect(body.adapter_routing).toEqual([{
        node_id: "model_call",
        selected_adapter_id: undefined,
        executable: false,
        missing_capabilities: ["model.call"]
      }]);
    } finally {
      await writeFile(manifestPath, originalManifest);
      await rm(workflowPath, { force: true });
    }
  });

  it("returns the project roadmap with git and evidence sync state", async () => {
    const body = await fetchJson<{
      current_node_id: string | null;
      phase_timeline: Array<{ id: string; status: string }>;
      mvp_execution_plan: Array<{ id: string; day: string; status: string }>;
      sync_state: {
        git: { available: boolean; head: string; recent_commits: Array<{ short_hash: string; subject: string }> };
        evidence: Array<{ path: string; exists: boolean; tracked: boolean }>;
      };
    }>("/api/v0/project/roadmap");

    if (body.current_node_id) {
      expect(body.mvp_execution_plan.find((task) => task.id === body.current_node_id)?.status).toBe("current");
    } else {
      expect(body.mvp_execution_plan.some((task) => task.status === "current")).toBe(false);
      expect(body.phase_timeline.some((phase) => phase.status === "current")).toBe(false);
    }
    expect(body.mvp_execution_plan.some((task) => task.day === "D10")).toBe(true);
    expect(body.sync_state.git.available).toBe(true);
    expect(body.sync_state.git.head).toMatch(/[0-9a-f]{40}/);
    expect(body.sync_state.git.recent_commits.length).toBeGreaterThan(0);
    expect(body.sync_state.evidence.some((item) => item.path === "docs/05-delivery/p4-mvp/27_P4第四轮_Gate推进Canvas发布与执行UI交付说明.md" && item.exists)).toBe(true);
  });

  it("serves the standalone task baseline page outside the web workspace", async () => {
    const response = await fetch(`${baseUrl}/task-baseline`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("MVP 执行计划与长期系统路线");
    expect(html).toContain("不属于 Miracle 产品工作台页面");
    expect(html).toContain("下一阶段待规划");
  });

  it("starts a run and executes the first queued node through the mock runner protocol", async () => {
    const created = await fetchJson<{
      run_id: string;
      initial_node_runs: string[];
    }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
    });
    const nodeRunId = created.initial_node_runs[0];

    const executed = await fetchJson<{
      accepted: boolean;
      invocation: { adapter_id?: string; adapter_kind: string; attempt_id: string };
      adapter_result: { status: string; operation_id: string; provider_receipt: { adapter_kind: string }; artifact_descriptors: Array<{ artifact_id: string }> };
      committed: { node_run: { status: string; output_artifacts: string[] }; attempt: { status: string }; created_events: string[] };
    }>(`/api/v0/runs/${created.run_id}/nodes/${nodeRunId}/execute`, { method: "POST", body: JSON.stringify({}) });

    expect(executed.accepted).toBe(true);
    expect(executed.invocation).toMatchObject({ adapter_id: "codex-mock-compatible-adapter", adapter_kind: "codex" });
    expect(executed.adapter_result.status).toBe("succeeded");
    expect(executed.adapter_result.provider_receipt.adapter_kind).toBe("codex");
    expect(executed.committed.attempt.status).toBe("succeeded");
    expect(executed.committed.node_run.status).toBe("done");
    expect(executed.committed.node_run.output_artifacts.length).toBeGreaterThan(0);
    expect(executed.committed.created_events).toEqual(expect.arrayContaining([
      `evt_${executed.invocation.attempt_id}_inputs_resolved`,
      `evt_${executed.adapter_result.operation_id}_committed`
    ]));

    const nodeDetail = await fetchJson<{ attempts: Array<{ operation_id: string }> }>(`/api/v0/runs/${created.run_id}/nodes/${nodeRunId}`);
    expect(nodeDetail.attempts.some((attempt) => attempt.operation_id === executed.adapter_result.operation_id)).toBe(true);

    const events = await fetchJson<{ events: Array<{ type: string }> }>(`/api/v0/runs/${created.run_id}/events`);
    expect(events.events.map((event) => event.type)).toEqual(expect.arrayContaining(["runner_operation_dispatched", "adapter_result_received", "node_run_committed"]));

    const duplicate = await fetch(`${baseUrl}/api/v0/runs/${created.run_id}/nodes/${nodeRunId}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(duplicate.status).toBe(409);
  });

  it("dry-runs scheduler decisions without writing scheduler events", async () => {
    const created = await fetchJson<{
      run_id: string;
      initial_node_runs: string[];
    }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
    });

    const planned = await fetchJson<{
      mode: string;
      executable: Array<{ node_run_id: string; node_id: string; decision: string }>;
      paused: unknown[];
    }>(`/api/v0/runs/${created.run_id}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ dry_run: true, max_nodes: 2 })
    });

    expect(planned.mode).toBe("dry_run");
    expect(planned.executable).toEqual([{ node_run_id: created.initial_node_runs[0], node_id: "A_collect", decision: "execute", reason_code: "ready", status: "queued" }]);
    expect(planned.paused).toEqual([]);

    const events = await fetchJson<{ events: Array<{ type: string }> }>(`/api/v0/runs/${created.run_id}/events`);
    expect(events.events.some((event) => event.type.startsWith("scheduler_tick_"))).toBe(false);
  });

  it("runs one scheduler tick and commits the next queued node", async () => {
    const created = await fetchJson<{
      run_id: string;
      initial_node_runs: string[];
    }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
    });

    const tick = await fetchJson<{
      mode: string;
      executed: Array<{ decision: { node_id: string }; result: { accepted: boolean; committed: { node_run: { status: string } } } }>;
      paused: unknown[];
      created_events: string[];
    }>(`/api/v0/runs/${created.run_id}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ max_nodes: 1 })
    });

    expect(tick.mode).toBe("commit");
    expect(tick.executed.length).toBe(1);
    expect(tick.executed[0]?.decision.node_id).toBe("A_collect");
    expect(tick.executed[0]?.result.accepted).toBe(true);
    expect(tick.executed[0]?.result.committed.node_run.status).toBe("done");
    expect(tick.paused).toEqual([]);
    expect(tick.created_events.length).toBe(3);

    const run = await fetchJson<{ nodes: Array<{ node_id: string; status: string }> }>(`/api/v0/runs/${created.run_id}`);
    expect(run.nodes.find((node) => node.node_id === "B_md_master")?.status).toBe("queued");

    const events = await fetchJson<{ events: Array<{ type: string }> }>(`/api/v0/runs/${created.run_id}/events`);
    expect(events.events.map((event) => event.type)).toEqual(expect.arrayContaining(["execution_plan_calculated", "scheduler_tick_started", "node_inputs_resolved", "scheduler_tick_completed"]));
  });

  it("pauses scheduler decisions on pending review gates", async () => {
    const created = await fetchJson<{
      run_id: string;
      initial_node_runs: string[];
    }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
    });

    await fetchJson(`/api/v0/runs/${created.run_id}/nodes/${created.initial_node_runs[0]}/execute`, { method: "POST", body: JSON.stringify({}) });
    const afterCollect = await fetchJson<{ nodes: Array<{ node_run_id: string; node_id: string }> }>(`/api/v0/runs/${created.run_id}`);
    const mdNode = afterCollect.nodes.find((node) => node.node_id === "B_md_master");
    if (!mdNode) throw new Error("Expected B_md_master node");

    await fetchJson(`/api/v0/runs/${created.run_id}/nodes/${mdNode.node_run_id}/execute`, { method: "POST", body: JSON.stringify({}) });
    const planned = await fetchJson<{
      executable: unknown[];
      paused: Array<{ node_id: string; decision: string; gate_instance_id?: string }>;
    }>(`/api/v0/runs/${created.run_id}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ dry_run: true, max_nodes: 3 })
    });

    expect(planned.executable).toEqual([]);
    expect(planned.paused.some((item) => item.node_id === "C_script" && item.decision === "pause_for_gate" && item.gate_instance_id)).toBe(true);
    expect(planned.paused.some((item) => item.node_id === "G_distribution" && item.decision === "pause_for_gate" && item.gate_instance_id)).toBe(true);
  });

  it("runs scheduler continuously until a pending review gate pauses downstream nodes", async () => {
    const created = await fetchJson<{
      run_id: string;
    }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
    });

    const scheduled = await fetchJson<{
      stop_reason: string;
      summary: { nodes_executed: number; ticks_committed: number };
      ticks: Array<{ mode: string; paused?: Array<{ node_id: string; decision: string }> }>;
    }>(`/api/v0/runs/${created.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 5, max_nodes_per_tick: 1 })
    });

    expect(scheduled.stop_reason).toBe("paused_for_gate");
    expect(scheduled.summary.nodes_executed).toBe(2);
    expect(scheduled.summary.ticks_committed).toBe(2);
    expect(scheduled.ticks.at(-1)?.mode).toBe("dry_stop");
    expect(scheduled.ticks.at(-1)?.paused?.some((item) => item.node_id === "C_script" && item.decision === "pause_for_gate")).toBe(true);

    const run = await fetchJson<{
      nodes: Array<{ node_id: string; status: string }>;
      gates: Array<{ status: string }>;
    }>(`/api/v0/runs/${created.run_id}`);
    expect(run.nodes.find((node) => node.node_id === "A_collect")?.status).toBe("done");
    expect(run.nodes.find((node) => node.node_id === "B_md_master")?.status).toBe("reviewing");
    expect(run.gates.some((gate) => gate.status === "pending_review")).toBe(true);

    const events = await fetchJson<{ events: Array<{ type: string }> }>(`/api/v0/runs/${created.run_id}/events`);
    expect(events.events.map((event) => event.type)).toEqual(expect.arrayContaining(["scheduler_run_started", "scheduler_run_completed", "scheduler_tick_started", "scheduler_tick_completed"]));
  });

  it("reports gate pause instead of max tick limit when the terminal state is blocked by review", async () => {
    const created = await fetchJson<{
      run_id: string;
    }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
    });

    const scheduled = await fetchJson<{
      stop_reason: string;
      summary: { nodes_executed: number; ticks_committed: number };
      ticks: Array<{ mode: string; paused?: Array<{ node_id: string; decision: string }> }>;
    }>(`/api/v0/runs/${created.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 2, max_nodes_per_tick: 1 })
    });

    expect(scheduled.stop_reason).toBe("paused_for_gate");
    expect(scheduled.summary.nodes_executed).toBe(2);
    expect(scheduled.summary.ticks_committed).toBe(2);
    expect(scheduled.ticks.at(-1)?.mode).toBe("dry_stop");
    expect(scheduled.ticks.at(-1)?.paused?.some((item) => item.node_id === "G_distribution" && item.decision === "pause_for_gate")).toBe(true);
  });

  it("schedules a retry before opening Attention for a retryable scheduler failure", async () => {
    const created = await fetchJson<{
      run_id: string;
      initial_node_runs: string[];
    }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
    });

    const nodesPath = path.join(tempWorkspace, "runs", created.run_id, "nodes.json");
    const nodes = JSON.parse(await readFile(nodesPath, "utf8")) as Array<{ node_run_id: string; provider?: string }>;
    const firstNode = nodes.find((node) => node.node_run_id === created.initial_node_runs[0]);
    if (!firstNode) throw new Error("Expected first NodeRun");
    firstNode.provider = "mock-failure";
    await writeFile(nodesPath, `${JSON.stringify(nodes, null, 2)}\n`, "utf8");

    const scheduled = await fetchJson<{
      stop_reason: string;
      summary: { nodes_executed: number; failures: number; attention_items_created: number };
      next_suggested_actions: string[];
      ticks: Array<{
        failed?: Array<{ error: { code: string }; retry_decision?: { action: string } }>;
        attention_items?: Array<{ root_cause_key: string }>;
      }>;
    }>(`/api/v0/runs/${created.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 3, max_nodes_per_tick: 1 })
    });

    expect(scheduled.stop_reason).toBe("waiting_for_retry");
    expect(scheduled.next_suggested_actions).toEqual(["wait_for_retry"]);
    expect(scheduled.summary.nodes_executed).toBe(1);
    expect(scheduled.summary.failures).toBe(1);
    expect(scheduled.summary.attention_items_created).toBe(0);
    expect(scheduled.ticks[0]?.failed?.[0]?.error.code).toBe("mock_failure");
    expect(scheduled.ticks[0]?.failed?.[0]?.retry_decision).toMatchObject({ action: "schedule_retry" });
    expect(scheduled.ticks[0]?.attention_items).toEqual([]);

    const attention = await fetchJson<{ attention: Array<{ root_cause_key: string; status: string; safe_actions: string[] }> }>(`/api/v0/attention?run_id=${created.run_id}`);
    expect(attention.attention).toEqual([]);
    const events = await fetchJson<{ events: Array<{ type: string }> }>(`/api/v0/runs/${created.run_id}/events`);
    expect(events.events.map((event) => event.type)).toContain("retry_scheduled");
    expect(events.events.map((event) => event.type)).not.toContain("attention_item_created");
  });

  it("waits for an active artifact producer, blocks a terminal missing input, and recovers after the artifact is restored", async () => {
    const created = await fetchJson<{
      run_id: string;
      initial_node_runs: string[];
    }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
    });

    const nodesPath = path.join(tempWorkspace, "runs", created.run_id, "nodes.json");
    const nodes = JSON.parse(await readFile(nodesPath, "utf8")) as Array<{
      node_run_id: string;
      node_id: string;
      status: string;
      updated_at: string;
      blocked_reason?: string;
      output_artifacts: string[];
    }>;
    const scriptNode = nodes.find((node) => node.node_id === "C_script");
    const ttsNode = nodes.find((node) => node.node_id === "E_tts");
    const videoNode = nodes.find((node) => node.node_id === "F_video");
    if (!scriptNode || !ttsNode || !videoNode) throw new Error("Expected script, TTS, and video nodes in content-production-v0");
    scriptNode.status = "running";
    ttsNode.status = "queued";
    videoNode.status = "waiting";
    await writeFile(nodesPath, `${JSON.stringify(nodes, null, 2)}\n`, "utf8");

    const active = await fetchJson<{
      decisions: Array<{ node_id: string; decision: string; reason_code: string }>;
    }>(`/api/v0/runs/${created.run_id}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ dry_run: true, max_nodes: 1 })
    });
    expect(active.decisions.find((decision) => decision.node_id === "E_tts")).toMatchObject({
      decision: "wait",
      reason_code: "optional_edge_active"
    });
    expect((await fetchJson<{ attention: unknown[] }>(`/api/v0/attention?run_id=${created.run_id}`)).attention).toEqual([]);

    scriptNode.status = "done";
    await writeFile(nodesPath, `${JSON.stringify(nodes, null, 2)}\n`, "utf8");
    const response = await fetch(`${baseUrl}/api/v0/runs/${created.run_id}/nodes/${ttsNode.node_run_id}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });

    const run = await fetchJson<{ nodes: Array<{ node_id: string; status: string; blocked_reason?: string }> }>(`/api/v0/runs/${created.run_id}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "node_not_executable", reason_code: "required_input_missing" } });
    expect(run.nodes.find((node) => node.node_id === "E_tts")).toMatchObject({
      status: "blocked",
      blocked_reason: expect.stringContaining("required_input_missing")
    });
    expect(run.nodes.find((node) => node.node_id === "F_video")?.status).toBe("waiting");

    const rootCauseKey = `run:${created.run_id}:node:${ttsNode.node_run_id}:execution_plan:required_input_missing`;
    const blockedAttention = await fetchJson<{
      attention: Array<{ root_cause_key: string; status: string; safe_actions: string[] }>;
    }>(`/api/v0/attention?run_id=${created.run_id}`);
    expect(blockedAttention.attention).toEqual([
      expect.objectContaining({
        root_cause_key: rootCauseKey,
        status: "open",
        safe_actions: expect.arrayContaining(["restore_required_artifact", "rerun_upstream_node"])
      })
    ]);

    const artifactId = `art_${created.run_id}_script_recovered`;
    const artifactsPath = path.join(tempWorkspace, "runs", created.run_id, "artifacts.json");
    const artifacts = JSON.parse(await readFile(artifactsPath, "utf8")) as unknown[];
    artifacts.push({
      artifact_id: artifactId,
      artifact_spec_ref: "script_artifact",
      run_id: created.run_id,
      node_run_id: scriptNode.node_run_id,
      type: "script",
      version: 1,
      path: `artifacts/${artifactId}.md`,
      hash: "sha256:restored-script",
      status: "created",
      review_status: "none",
      producer: "content-agent",
      created_at: new Date().toISOString()
    });
    await writeFile(artifactsPath, `${JSON.stringify(artifacts, null, 2)}\n`, "utf8");
    const blockedNodes = JSON.parse(await readFile(nodesPath, "utf8")) as typeof nodes;
    const recoveredScriptNode = blockedNodes.find((node) => node.node_id === "C_script")!;
    recoveredScriptNode.output_artifacts = [artifactId];
    await writeFile(nodesPath, `${JSON.stringify(blockedNodes, null, 2)}\n`, "utf8");

    const recovered = await fetchJson<{
      execution_plan: {
        decisions: Array<{ node_id: string; decision: string; reason_code: string }>;
        ready_node_run_ids: string[];
        blocked_node_run_ids: string[];
      };
    }>(`/api/v0/runs/${created.run_id}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ dry_run: true, max_nodes: 1 })
    });
    expect(recovered.execution_plan.decisions.find((decision) => decision.node_id === "E_tts")).toMatchObject({
      decision: "execute",
      reason_code: "ready"
    });
    expect(recovered.execution_plan.ready_node_run_ids).toContain(ttsNode.node_run_id);
    expect(recovered.execution_plan.blocked_node_run_ids).not.toContain(ttsNode.node_run_id);

    const detail = await fetchJson<{
      node: { status: string; blocked_reason?: string };
      execution_decision: { decision: string; reason_code: string };
      next_suggested_actions: string[];
    }>(`/api/v0/runs/${created.run_id}/nodes/${ttsNode.node_run_id}`);
    expect(detail.node).toMatchObject({ status: "queued" });
    expect(detail.node.blocked_reason).toBeUndefined();
    expect(detail.execution_decision).toMatchObject({ decision: "execute", reason_code: "ready" });
    expect(detail.next_suggested_actions).toEqual(["run_scheduler_tick"]);
    const recoveredAttention = await fetchJson<{
      attention: Array<{ root_cause_key: string; status: string }>;
    }>(`/api/v0/attention?run_id=${created.run_id}`);
    expect(recoveredAttention.attention.find((item) => item.root_cause_key === rootCauseKey)?.status).toBe("resolved");
  });

  it("creates, dry-runs and confirms a RunDraft without writing formal run facts", async () => {
    const runsBefore = await fetchJson<{ runs: Array<{ run_id: string }> }>("/api/v0/runs");
    const created = await fetchJson<{
      draft: { draft_id: string; status: string; revision: number; latest_plan_hash?: string };
    }>("/api/v0/run-drafts", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: "content-production-real-v0",
        inputs: { topic_brief: "Codex 与 Claude Code 最新动态" },
        enabled_optional_paths: [],
        execution_policy: "hybrid"
      })
    });
    expect(created.draft.status).toBe("draft");

    const patched = await fetchJson<{ draft: { status: string; revision: number } }>(`/api/v0/run-drafts/${created.draft.draft_id}`, {
      method: "PATCH",
      body: JSON.stringify({
        expected_revision: created.draft.revision,
        inputs: { topic_brief: "Codex、Claude Code 与本地 Agent OS" },
        enabled_optional_paths: []
      })
    });
    expect(patched.draft.status).toBe("ready_for_dry_run");

    const dryRun = await fetchJson<{
      draft: { status: string; revision: number; latest_plan_hash: string };
      plan: {
        plan_hash: string;
        startability: { required_path: string; full_workflow: string };
        draft_plan_id: string;
        branch_impact: Array<{ branch_id: string; selection: string; enabled: boolean; readiness: string }>;
        gate_plan: Array<{ gate_spec_id: string }>;
        required_acknowledgements: string[];
      };
    }>(`/api/v0/run-drafts/${created.draft.draft_id}/dry-run`, { method: "POST", body: JSON.stringify({ expected_revision: patched.draft.revision }) });
    expect(dryRun.draft.status).toBe("ready_for_confirmation");
    expect(dryRun.draft.latest_plan_hash).toBe(dryRun.plan.plan_hash);
    expect(dryRun.plan.startability.required_path).toBe("ready");
    expect(dryRun.plan.branch_impact.some((branch) => branch.selection === "optional" && !branch.enabled && branch.readiness === "not_selected")).toBe(true);
    expect(dryRun.plan.gate_plan.some((gate) => gate.gate_spec_id === "F_final_render_gate")).toBe(true);

    const confirmed = await fetchJson<{
      draft: { status: string; revision: number };
      confirmation: { confirmation_id: string; decision: string; plan_hash: string };
    }>(`/api/v0/run-drafts/${created.draft.draft_id}/confirmation`, {
      method: "POST",
      body: JSON.stringify({
        decision: "confirm",
        expected_revision: dryRun.draft.revision,
        plan_hash: dryRun.plan.plan_hash,
        acknowledgements: dryRun.plan.required_acknowledgements,
        actor: "operator",
        comment: "启动前确认"
      })
    });
    expect(confirmed.draft.status).toBe("confirmed");
    expect(confirmed.confirmation).toMatchObject({ decision: "confirmed", plan_hash: dryRun.plan.plan_hash });

    const launch = await fetch(`${baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft_id: created.draft.draft_id,
        draft_plan_id: dryRun.plan.draft_plan_id,
        plan_hash: dryRun.plan.plan_hash,
        confirmation_id: confirmed.confirmation.confirmation_id
      })
    });
    expect(launch.status).toBe(409);
    expect(await launch.json()).toMatchObject({ error: { code: "adapter_not_ready" } });

    const repeated = await fetchJson<{
      draft: { status: string; revision: number };
      confirmation: { confirmation_id: string; decision: string; plan_hash: string };
    }>(`/api/v0/run-drafts/${created.draft.draft_id}/confirmation`, {
      method: "POST",
      body: JSON.stringify({
        decision: "confirm",
        expected_revision: dryRun.draft.revision,
        plan_hash: dryRun.plan.plan_hash,
        acknowledgements: dryRun.plan.required_acknowledgements,
        actor: "operator"
      })
    });
    expect(repeated.confirmation.confirmation_id).toBe(confirmed.confirmation.confirmation_id);
    expect(repeated.draft.revision).toBe(confirmed.draft.revision);

    const revised = await fetchJson<{ draft: { status: string; revision: number } }>(`/api/v0/run-drafts/${created.draft.draft_id}/confirmation`, {
      method: "POST",
      body: JSON.stringify({ decision: "revise", expected_revision: confirmed.draft.revision, actor: "operator" })
    });
    expect(revised.draft.status).toBe("ready_for_dry_run");
    const cancelled = await fetchJson<{ draft: { status: string; revision: number } }>(`/api/v0/run-drafts/${created.draft.draft_id}/confirmation`, {
      method: "POST",
      body: JSON.stringify({ decision: "cancel", expected_revision: revised.draft.revision, actor: "operator" })
    });
    expect(cancelled.draft.status).toBe("cancelled");

    const bundle = await fetchJson<{
      draft: { status: string };
      audit: Array<{ type: string }>;
    }>(`/api/v0/run-drafts/${created.draft.draft_id}`);
    expect(bundle.draft.status).toBe("cancelled");
    expect(bundle.audit.map((event) => event.type)).toEqual(expect.arrayContaining(["run_draft_created", "run_draft_updated", "dry_run_generated", "launch_confirmation_recorded", "run_draft_cancelled"]));
    const runsAfter = await fetchJson<{ runs: Array<{ run_id: string }> }>("/api/v0/runs");
    expect(runsAfter.runs.map((run) => run.run_id)).toEqual(runsBefore.runs.map((run) => run.run_id));
  });
});
