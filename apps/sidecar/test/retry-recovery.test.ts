import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RetryScheduleStore } from "../src/retry-store";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureWorkspace = path.join(repoRoot, "fixtures/mvp-workspace/.miracle");

let tempRoot = "";
let tempWorkspace = "";
let sidecar: ChildProcessWithoutNullStreams | undefined;
let baseUrl = "";
let sidecarOutput = "";
let port = 0;

const retryWorkflow = {
  id: "retry-recovery-v0",
  name: "Retry recovery test",
  version: "0.1.0",
  domain: "test",
  category: "test",
  nodes: [{
    id: "transient_node",
    name: "Transient node",
    type: "agent",
    capability_requirements: ["content.longform_draft"],
    recommended_libraries: [],
    agent_candidates: ["test-agent"],
    inputs: [],
    outputs: [{ id: "result", kind: "artifact", artifact_type: "markdown", required: true }],
    failure_policy: { retry: 1, on_missing_input: "blocked", on_provider_failure: "failed" }
  }],
  edges: [],
  gates: [],
  artifacts: [],
  provider_policy: {
    default_provider: "mock-failure",
    allowed_providers: ["mock-failure"],
    required_credentials: [],
    fallback_providers: []
  },
  layouts: { dag: { transient_node: { x: 0, y: 0 } } },
  registry_meta: { source: "test", status: "stable" }
};

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

async function startSidecar() {
  sidecarOutput = "";
  sidecar = spawn("npm", ["run", "dev", "-w", "apps/sidecar"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MIRACLE_WORKSPACE_DIR: tempWorkspace,
      MIRACLE_WORKFLOW_REGISTRY_DIR: path.join(tempWorkspace, "workflows"),
      MIRACLE_RUNTIME_WORKSPACE_DIR: path.join(tempRoot, "runtime"),
      MIRACLE_SIDECAR_PORT: String(port),
      npm_config_cache: path.join(repoRoot, ".npm-cache")
    }
  });
  sidecar.stdout.on("data", (chunk) => { sidecarOutput += chunk.toString(); });
  sidecar.stderr.on("data", (chunk) => { sidecarOutput += chunk.toString(); });
  await waitForHealth();
}

async function stopSidecar() {
  sidecar?.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  sidecar = undefined;
}

async function launchRun() {
  return fetchJson<{ run_id: string }>("/api/v0/runs", {
    method: "POST",
    body: JSON.stringify({ workflow_id: retryWorkflow.id, execution_policy: "auto" })
  });
}

describe("RetryScheduleStore", () => {
  it("atomically replaces the single active schedule for an operation", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "miracle-retry-store-"));
    const store = new RetryScheduleStore({ workspace_dir: workspace });
    const budget = {
      attempts_used: 1,
      elapsed_ms: 10,
      cost_used: 0,
      max_attempts: 3,
      total_time_budget_ms: 60_000,
      cost_budget: 5
    };
    await store.upsert("run-store", {
      operation_id: "op_store",
      node_run_id: "nr_store",
      attempt_number: 2,
      reason_code: "retryable_error",
      scheduled_for: "2026-07-31T00:00:01.000Z",
      budget_snapshot: budget
    });
    await store.upsert("run-store", {
      operation_id: "op_store",
      node_run_id: "nr_store",
      attempt_number: 3,
      reason_code: "retryable_error",
      scheduled_for: "2026-07-31T00:00:02.000Z",
      budget_snapshot: { ...budget, attempts_used: 2 }
    });

    expect(await store.list("run-store")).toEqual([
      expect.objectContaining({ operation_id: "op_store", attempt_number: 3 })
    ]);
    await expect(readFile(path.join(workspace, "runs/run-store/retry_schedule.json"), "utf8")).resolves.toContain("\"attempt_number\": 3");
    await rm(workspace, { recursive: true, force: true });
  });
});

describe("P7-05 retry recovery", () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "miracle-p7-05-"));
    tempWorkspace = path.join(tempRoot, "workspace", ".miracle");
    await cp(fixtureWorkspace, tempWorkspace, { recursive: true });
    await writeFile(
      path.join(tempWorkspace, "workflows", `${retryWorkflow.id}.json`),
      `${JSON.stringify(retryWorkflow, null, 2)}\n`,
      "utf8"
    );
    port = 6200 + Math.floor(Math.random() * 300);
    baseUrl = `http://127.0.0.1:${port}`;
    await startSidecar();
  }, 20_000);

  afterAll(async () => {
    await stopSidecar();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it("waits until due, recovers after restart, and dispatches the retry once", async () => {
    const { run_id: runId } = await launchRun();
    await fetchJson(`/api/v0/runs/${runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ max_nodes: 1 })
    });
    const afterFailure = await fetchJson<{
      attempts: Array<{ operation_id: string; attempt_number: number; status: string }>;
    }>(`/api/v0/runs/${runId}`);
    expect(afterFailure.attempts).toHaveLength(1);

    const notDue = await fetchJson<{ executed: unknown[] }>(`/api/v0/runs/${runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ max_nodes: 1 })
    });
    expect(notDue.executed).toEqual([]);

    const schedulePath = path.join(tempWorkspace, "runs", runId, "retry_schedule.json");
    const schedules = JSON.parse(await readFile(schedulePath, "utf8")) as Array<Record<string, unknown>>;
    schedules[0] = { ...schedules[0], scheduled_for: "2020-01-01T00:00:00.000Z" };
    await writeFile(schedulePath, `${JSON.stringify(schedules, null, 2)}\n`, "utf8");
    await stopSidecar();
    await startSidecar();

    await fetchJson(`/api/v0/runs/${runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ max_nodes: 1 })
    });
    const recovered = await fetchJson<{
      attempts: Array<{ operation_id: string; attempt_number: number; status: string }>;
    }>(`/api/v0/runs/${runId}`);
    expect(recovered.attempts).toHaveLength(2);
    expect(recovered.attempts.map((attempt) => attempt.operation_id)).toEqual([
      recovered.attempts[0]?.operation_id,
      recovered.attempts[0]?.operation_id
    ]);
    expect(recovered.attempts.map((attempt) => attempt.attempt_number)).toEqual([1, 2]);

    await stopSidecar();
    await startSidecar();
    await fetchJson(`/api/v0/runs/${runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ max_nodes: 1 })
    });
    const afterSecondRestart = await fetchJson<{ attempts: unknown[] }>(`/api/v0/runs/${runId}`);
    expect(afterSecondRestart.attempts).toHaveLength(2);

    const events = await fetchJson<{ events: Array<{ type: string }> }>(`/api/v0/runs/${runId}/events`);
    expect(events.events.filter((event) => event.type === "retry_scheduled")).toHaveLength(1);
    expect(events.events.filter((event) => event.type === "retry_exhausted")).toHaveLength(1);
    const attention = await fetchJson<{ attention: Array<{ root_cause_key: string; safe_actions: string[] }> }>(`/api/v0/attention?run_id=${runId}`);
    const retryAttention = attention.attention.filter((item) => item.root_cause_key.includes(runId));
    expect(retryAttention).toHaveLength(1);
    expect(retryAttention[0]?.safe_actions).toContain("retry_manually");

    const nodes = await fetchJson<{ nodes: Array<{ node_run_id: string }> }>(`/api/v0/runs/${runId}`);
    const detail = await fetchJson<{ retry_decision: { action: string; reason_code: string } }>(
      `/api/v0/runs/${runId}/nodes/${nodes.nodes[0]?.node_run_id}`
    );
    expect(detail.retry_decision).toMatchObject({
      action: "require_attention",
      reason_code: "attempt_budget_exhausted"
    });
  }, 30_000);
});
