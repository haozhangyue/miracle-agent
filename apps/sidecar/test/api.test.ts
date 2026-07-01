import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureWorkspace = path.join(repoRoot, "fixtures/mvp-workspace/.miracle");

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

    const lockName = gateId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const lockDir = path.join(tempWorkspace, "runs", created.run_id, "locks", `${lockName}.gate.lock`);
    await mkdir(lockDir, { recursive: true });

    const locked = await fetch(`${baseUrl}/api/v0/gates/${gateId}/decision?run_id=${created.run_id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", actor: "api-test" })
    });
    expect(locked.status).toBe(409);
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

  it("publishes a canvas draft as a validated Workflow draft", async () => {
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
      workflow: { id: string; registry_meta: { status: string } };
    }>(`/api/v0/workflows/${published.workflow_id}`);
    expect(detail.workflow.registry_meta.status).toBe("draft");
  });

  it("returns adapter plugin shells", async () => {
    const body = await fetchJson<{
      adapters: Array<{ id: string; kind: string }>;
    }>("/api/v0/adapters");

    expect(body.adapters.map((adapter) => adapter.kind)).toEqual(expect.arrayContaining(["mock-local", "codex", "hermes", "openclaw", "official-api"]));
  });

  it("returns the project roadmap with git and evidence sync state", async () => {
    const body = await fetchJson<{
      current_node_id: string;
      phase_timeline: Array<{ id: string; status: string }>;
      mvp_execution_plan: Array<{ id: string; day: string }>;
      sync_state: {
        git: { available: boolean; head: string; recent_commits: Array<{ short_hash: string; subject: string }> };
        evidence: Array<{ path: string; exists: boolean; tracked: boolean }>;
      };
    }>("/api/v0/project/roadmap");

    expect(body.current_node_id).toBe("p4-05");
    expect(body.phase_timeline.some((phase) => phase.id === "p4-05" && phase.status === "current")).toBe(true);
    expect(body.mvp_execution_plan.some((task) => task.day === "D10")).toBe(true);
    expect(body.sync_state.git.available).toBe(true);
    expect(body.sync_state.git.head).toMatch(/[0-9a-f]{40}/);
    expect(body.sync_state.git.recent_commits.length).toBeGreaterThan(0);
    expect(body.sync_state.evidence.some((item) => item.path === "27_P4第四轮_Gate推进Canvas发布与执行UI交付说明.md" && item.exists)).toBe(true);
  });

  it("serves the standalone task baseline page outside the web workspace", async () => {
    const response = await fetch(`${baseUrl}/task-baseline`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("MVP 执行计划与长期系统路线");
    expect(html).toContain("不属于 Miracle 产品工作台页面");
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
      adapter_result: { status: string; operation_id: string; artifact_descriptors: Array<{ artifact_id: string }> };
      committed: { node_run: { status: string; output_artifacts: string[] }; attempt: { status: string }; created_events: string[] };
    }>(`/api/v0/runs/${created.run_id}/nodes/${nodeRunId}/execute`, { method: "POST", body: JSON.stringify({}) });

    expect(executed.accepted).toBe(true);
    expect(executed.adapter_result.status).toBe("succeeded");
    expect(executed.committed.attempt.status).toBe("succeeded");
    expect(executed.committed.node_run.status).toBe("done");
    expect(executed.committed.node_run.output_artifacts.length).toBeGreaterThan(0);
    expect(executed.committed.created_events).toEqual(expect.arrayContaining([`evt_${executed.adapter_result.operation_id}_committed`]));

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
    expect(planned.executable).toEqual([{ node_run_id: created.initial_node_runs[0], node_id: "A_collect", decision: "execute", reason: "queued NodeRun is executable", status: "queued" }]);
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
    expect(tick.created_events.length).toBe(2);

    const run = await fetchJson<{ nodes: Array<{ node_id: string; status: string }> }>(`/api/v0/runs/${created.run_id}`);
    expect(run.nodes.find((node) => node.node_id === "B_md_master")?.status).toBe("queued");

    const events = await fetchJson<{ events: Array<{ type: string }> }>(`/api/v0/runs/${created.run_id}/events`);
    expect(events.events.map((event) => event.type)).toEqual(expect.arrayContaining(["scheduler_tick_started", "scheduler_tick_completed"]));
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

  it("does not queue downstream optional media nodes when the artifact selector is not qualified", async () => {
    const created = await fetchJson<{
      run_id: string;
      initial_node_runs: string[];
    }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "hybrid", role_profile: "operator" })
    });

    const nodesPath = path.join(tempWorkspace, "runs", created.run_id, "nodes.json");
    const nodes = JSON.parse(await readFile(nodesPath, "utf8")) as Array<{ node_run_id: string; node_id: string; status: string; updated_at: string }>;
    const ttsNode = nodes.find((node) => node.node_id === "E_tts");
    const videoNode = nodes.find((node) => node.node_id === "F_video");
    if (!ttsNode || !videoNode) throw new Error("Expected TTS and video nodes in content-production-v0");
    ttsNode.status = "queued";
    videoNode.status = "waiting";
    await writeFile(nodesPath, `${JSON.stringify(nodes, null, 2)}\n`, "utf8");

    await fetchJson(`/api/v0/runs/${created.run_id}/nodes/${ttsNode.node_run_id}/execute`, { method: "POST", body: JSON.stringify({}) });

    const run = await fetchJson<{ nodes: Array<{ node_id: string; status: string }> }>(`/api/v0/runs/${created.run_id}`);
    expect(run.nodes.find((node) => node.node_id === "E_tts")?.status).toBe("done");
    expect(run.nodes.find((node) => node.node_id === "F_video")?.status).toBe("waiting");
  });
});
