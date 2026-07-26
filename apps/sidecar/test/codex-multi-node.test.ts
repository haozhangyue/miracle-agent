import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureWorkspace = path.join(repoRoot, "fixtures/mvp-workspace/.miracle");
const fakeCodex = path.join(repoRoot, "apps/sidecar/test/fixtures/bin/fake-codex.mjs");

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
  const body = await response.json() as T;
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}: ${JSON.stringify(body)}`);
  return body;
}

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/v0/health`)).ok) return;
    } catch {
      // Sidecar is starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Sidecar did not become healthy.\n${sidecarOutput}`);
}

async function launchRun(workflowId = "codex-content-chain-v0") {
  const created = await fetchJson<{ draft: { draft_id: string; revision: number } }>("/api/v0/run-drafts", {
    method: "POST",
    body: JSON.stringify({ workflow_id: workflowId, inputs: {}, execution_policy: "auto" })
  });
  const dryRun = await fetchJson<{ draft: { revision: number }; plan: { draft_plan_id: string; plan_hash: string; required_acknowledgements: string[] } }>(
    `/api/v0/run-drafts/${created.draft.draft_id}/dry-run`,
    { method: "POST", body: JSON.stringify({ expected_revision: created.draft.revision }) }
  );
  const confirmation = await fetchJson<{ confirmation: { confirmation_id: string } }>(`/api/v0/run-drafts/${created.draft.draft_id}/confirmation`, {
    method: "POST",
    body: JSON.stringify({ decision: "confirm", expected_revision: dryRun.draft.revision, plan_hash: dryRun.plan.plan_hash, acknowledgements: dryRun.plan.required_acknowledgements, actor: "p7-04-test" })
  });
  return fetchJson<{ run_id: string }>("/api/v0/runs", {
    method: "POST",
    body: JSON.stringify({ draft_id: created.draft.draft_id, draft_plan_id: dryRun.plan.draft_plan_id, plan_hash: dryRun.plan.plan_hash, confirmation_id: confirmation.confirmation.confirmation_id })
  });
}

async function runScheduler(runId: string) {
  return fetchJson<{
    stop_reason: string;
    summary: { nodes_executed: number };
    execution_plan: { decisions: Array<{ node_id: string; decision: string; reason_code: string }> };
  }>(`/api/v0/runs/${runId}/scheduler/run`, {
    method: "POST",
    body: JSON.stringify({ max_ticks: 8, max_nodes_per_tick: 1 })
  });
}

async function getRun(runId: string) {
  return fetchJson<{
    nodes: Array<{ node_id: string; node_run_id: string; status: string; upstream_artifacts: string[] }>;
    attempts: Array<{ node_run_id: string }>;
    gates: Array<{ gate_instance_id: string; status: string }>;
  }>(`/api/v0/runs/${runId}`);
}

function node(bundle: Awaited<ReturnType<typeof getRun>>, nodeId: string) {
  const found = bundle.nodes.find((item) => item.node_id === nodeId);
  if (!found) throw new Error(`Node ${nodeId} was not found`);
  return found;
}

function pendingGate(bundle: Awaited<ReturnType<typeof getRun>>) {
  const found = bundle.gates.find((item) => item.status === "pending_review");
  if (!found) throw new Error("Pending gate was not found");
  return found;
}

async function decideGate(runId: string, gateInstanceId: string, decision: "approve" | "reject") {
  return fetchJson(`/api/v0/gates/${gateInstanceId}/decision?run_id=${runId}`, {
    method: "POST",
    body: JSON.stringify({ actor: "p7-04-test", decision })
  });
}

describe("P7-04 Codex Scheduler continuous execution", () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "miracle-p7-04-"));
    tempWorkspace = path.join(tempRoot, "workspace", ".miracle");
    await cp(fixtureWorkspace, tempWorkspace, { recursive: true });
    const port = 5900 + Math.floor(Math.random() * 300);
    baseUrl = `http://127.0.0.1:${port}`;
    sidecar = spawn("npm", ["run", "dev", "-w", "apps/sidecar"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MIRACLE_WORKSPACE_DIR: tempWorkspace,
        MIRACLE_WORKFLOW_REGISTRY_DIR: path.join(tempWorkspace, "workflows"),
        MIRACLE_RUNTIME_WORKSPACE_DIR: path.join(tempRoot, "runtime"),
        MIRACLE_SIDECAR_PORT: String(port),
        MIRACLE_CODEX_CLI_PATH: process.execPath,
        MIRACLE_CODEX_CLI_ARGUMENT_PREFIX: fakeCodex,
        MIRACLE_ENABLE_REAL_CODEX: "1",
        npm_config_cache: path.join(repoRoot, ".npm-cache")
      }
    });
    sidecar.stdout.on("data", (chunk) => { sidecarOutput += chunk.toString(); });
    sidecar.stderr.on("data", (chunk) => { sidecarOutput += chunk.toString(); });
    await waitForHealth();
  }, 20_000);

  afterAll(async () => {
    sidecar?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it("runs B and C, pauses at the gate, then resumes D after approval", async () => {
    const { run_id: runId } = await launchRun();
    const first = await runScheduler(runId);
    expect(first.stop_reason).toBe("paused_for_gate");
    expect(first.summary.nodes_executed).toBe(2);
    expect(first.execution_plan.decisions.find((item) => item.node_id === "D_platform_summary")).toMatchObject({ decision: "pause_for_gate", reason_code: "required_gate_pending" });

    const beforeApproval = await getRun(runId);
    expect(node(beforeApproval, "D_platform_summary").status).toBe("waiting");
    await decideGate(runId, pendingGate(beforeApproval).gate_instance_id, "approve");

    const afterApproval = await getRun(runId);
    expect(node(afterApproval, "D_platform_summary").upstream_artifacts).toHaveLength(1);

    const resumed = await runScheduler(runId);
    expect(resumed.summary.nodes_executed).toBe(1);
    expect(node(await getRun(runId), "D_platform_summary").status).toBe("done");
  });

  it("does not advance D after a rejected gate", async () => {
    const { run_id: runId } = await launchRun();
    await runScheduler(runId);
    const beforeReject = await getRun(runId);
    await decideGate(runId, pendingGate(beforeReject).gate_instance_id, "reject");

    const stopped = await runScheduler(runId);
    const afterReject = await getRun(runId);
    expect(stopped.stop_reason).toBe("paused_for_gate");
    expect(node(afterReject, "D_platform_summary").status).not.toBe("running");
    expect(afterReject.attempts.filter((attempt) => attempt.node_run_id === node(afterReject, "C_md_master").node_run_id)).toHaveLength(1);
  });

  it("records planner audit facts without artifact content", async () => {
    const { run_id: runId } = await launchRun();
    await runScheduler(runId);
    const events = await fetchJson<{ events: Array<{ type: string; message: string }> }>(`/api/v0/runs/${runId}/events`);
    const plannerEvents = events.events.filter((event) => event.type === "execution_plan_calculated");
    const inputEvents = events.events.filter((event) => event.type === "node_inputs_resolved");

    expect(plannerEvents).not.toHaveLength(0);
    expect(inputEvents).toHaveLength(2);
    expect([...plannerEvents, ...inputEvents].map((event) => event.message).join("\n")).not.toContain("fake-codex");
    expect([...plannerEvents, ...inputEvents].map((event) => event.message).join("\n")).not.toContain("这是 fake-codex");
  });

  it("recalculates inside each execution lock so a same-tick gate blocks its downstream root", async () => {
    const { run_id: runId } = await launchRun("codex-same-tick-gate-v0");
    const tick = await fetchJson<{
      initial_candidates: Array<{ node_id: string }>;
      executable: Array<{ node_id: string }>;
      executed: Array<{ decision: { node_id: string } }>;
      failed: unknown[];
      paused: Array<{ node_id: string; decision: string }>;
    }>(`/api/v0/runs/${runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ max_nodes: 2 })
    });
    const after = await getRun(runId);

    expect(tick.executed.map((item) => item.decision.node_id)).toEqual(["B_review_source"]);
    expect(tick.failed).toEqual([]);
    expect(tick.initial_candidates.map((item) => item.node_id)).toEqual(["B_review_source", "D_guarded_summary"]);
    expect(tick.executable).toEqual([]);
    expect(tick.paused).toEqual([expect.objectContaining({ node_id: "D_guarded_summary", decision: "pause_for_gate" })]);
    expect(node(after, "D_guarded_summary").status).toBe("queued");
    expect(after.attempts.filter((attempt) => attempt.node_run_id === node(after, "D_guarded_summary").node_run_id)).toHaveLength(0);
  });

  it("rejects direct node execution when the locked execution plan pauses its gate", async () => {
    const { run_id: runId } = await launchRun("codex-same-tick-gate-v0");
    const first = await getRun(runId);
    await fetchJson(`/api/v0/runs/${runId}/nodes/${node(first, "B_review_source").node_run_id}/execute`, { method: "POST", body: JSON.stringify({}) });
    const afterSource = await getRun(runId);
    const response = await fetch(`${baseUrl}/api/v0/runs/${runId}/nodes/${node(afterSource, "D_guarded_summary").node_run_id}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "node_not_executable", reason_code: "required_gate_pending" } });
    expect((await getRun(runId)).attempts.filter((attempt) => attempt.node_run_id === node(afterSource, "D_guarded_summary").node_run_id)).toHaveLength(0);
  });

  it("reports the exact gate instance selected by the execution plan", async () => {
    const { run_id: runId } = await launchRun("codex-same-tick-gate-v0");
    const first = await getRun(runId);
    await fetchJson(`/api/v0/runs/${runId}/nodes/${node(first, "B_review_source").node_run_id}/execute`, { method: "POST", body: JSON.stringify({}) });
    const afterSource = await getRun(runId);
    const actualGate = pendingGate(afterSource);
    const gatesPath = path.join(tempWorkspace, "runs", runId, "gates.json");
    const gates = JSON.parse(await readFile(gatesPath, "utf8")) as Array<Record<string, unknown>>;
    gates.push({ ...actualGate, gate_instance_id: "gate_sibling_should_not_match", gate_spec_id: "sibling_gate", required_before: ["D_guarded_summary"] });
    await writeFile(gatesPath, `${JSON.stringify(gates, null, 2)}\n`, "utf8");

    const plan = await fetchJson<{ paused: Array<{ node_id: string; gate_instance_id?: string }> }>(`/api/v0/runs/${runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ dry_run: true, max_nodes: 2 })
    });

    expect(plan.paused.find((item) => item.node_id === "D_guarded_summary")?.gate_instance_id).toBe(actualGate.gate_instance_id);
  });
});
