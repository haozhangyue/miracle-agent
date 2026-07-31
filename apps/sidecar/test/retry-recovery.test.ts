import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
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

const costOverrideWorkflow = {
  ...retryWorkflow,
  id: "retry-cost-override-v0",
  name: "Retry cost override test",
  nodes: retryWorkflow.nodes.map((node) => ({
    ...node,
    failure_policy: { ...node.failure_policy, cost_budget: 0 }
  }))
};

const policyWorkflow = {
  ...retryWorkflow,
  id: "retry-policy-override-v0",
  name: "Retry policy override test",
  nodes: retryWorkflow.nodes.map((node) => ({
    ...node,
    failure_policy: {
      ...node.failure_policy,
      retry_policy: {
        max_attempts: 2,
        backoff: "fixed",
        initial_delay_ms: 0,
        max_delay_ms: 0,
        retryable_error_codes: ["mock_failure"],
        attempt_timeout_ms: 1_234,
        total_time_budget_ms: 5_000,
        cost_budget: 5
      }
    }
  }))
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

async function launchRun(workflowId = retryWorkflow.id) {
  return fetchJson<{ run_id: string }>("/api/v0/runs", {
    method: "POST",
    body: JSON.stringify({ workflow_id: workflowId, execution_policy: "auto" })
  });
}

function retrySchedulePath(runId: string) {
  return path.join(tempWorkspace, "runs", runId, "retry_schedule.json");
}

function attemptsPath(runId: string) {
  return path.join(tempWorkspace, "runs", runId, "attempts.json");
}

function retryStatePath(runId: string) {
  return path.join(tempWorkspace, "runs", runId, "retry_state.json");
}

function eventsPath(runId: string) {
  return path.join(tempWorkspace, "runs", runId, "events.jsonl");
}

function dispatchIntentPath(runId: string, nodeRunId: string) {
  const prefix = nodeRunId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48) || "node";
  const suffix = createHash("sha256").update(nodeRunId).digest("hex").slice(0, 16);
  return path.join(tempWorkspace, "runs", runId, "dispatches", `${prefix}_${suffix}.json`);
}

async function readEvents(runId: string) {
  return (await readFile(eventsPath(runId), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown> & { event_id: string; type: string });
}

async function writeEvents(runId: string, events: Array<Record<string, unknown>>) {
  await writeFile(eventsPath(runId), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

async function failFirstAttempt(workflowId = retryWorkflow.id) {
  const { run_id: runId } = await launchRun(workflowId);
  const tick = await fetchJson<{
    executed: Array<{
      result: {
        invocation: {
          operation_id: string;
          attempt_id: string;
          attempt_number: number;
          run_id: string;
          node_run_id: string;
          node_id: string;
          resolved_inputs: Array<{ input_id: string }>;
          runtime_control: { timeout_ms: number };
          dispatched_at: string;
        };
        retry_decision?: { action: string; reason_code: string };
      };
    }>;
  }>(`/api/v0/runs/${runId}/scheduler/tick`, {
    method: "POST",
    body: JSON.stringify({ max_nodes: 1 })
  });
  const bundle = await fetchJson<{
    nodes: Array<{ node_run_id: string }>;
    attempts: Array<{
      attempt_id: string;
      operation_id: string;
      attempt_number: number;
      status: string;
      started_at?: string;
      dispatched_at?: string;
      created_at: string;
      provider_receipt: Record<string, unknown>;
    }>;
  }>(`/api/v0/runs/${runId}`);
  const schedules = await new RetryScheduleStore({ workspace_dir: tempWorkspace }).list(runId);
  return {
    runId,
    nodeRunId: bundle.nodes[0]!.node_run_id,
    attempt: bundle.attempts[0]!,
    invocation: tick.executed[0]!.result.invocation,
    retryDecision: tick.executed[0]!.result.retry_decision,
    schedules
  };
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
    await writeFile(
      path.join(tempWorkspace, "workflows", `${costOverrideWorkflow.id}.json`),
      `${JSON.stringify(costOverrideWorkflow, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(tempWorkspace, "workflows", `${policyWorkflow.id}.json`),
      `${JSON.stringify(policyWorkflow, null, 2)}\n`,
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

  it("persists real dispatch timing, finite legacy cost budget, and restores a missing schedule event", async () => {
    const failure = await failFirstAttempt();
    expect(failure.attempt).toMatchObject({
      started_at: failure.invocation.dispatched_at,
      dispatched_at: failure.invocation.dispatched_at
    });
    expect(failure.schedules).toEqual([
      expect.objectContaining({
        operation_id: failure.attempt.operation_id,
        budget_snapshot: expect.objectContaining({ cost_budget: 5 })
      })
    ]);

    const originalEvents = await readEvents(failure.runId);
    const scheduledEvent = originalEvents.find((event) => event.type === "retry_scheduled");
    expect(scheduledEvent).toBeDefined();
    await writeFile(
      retrySchedulePath(failure.runId),
      `${JSON.stringify([{ ...failure.schedules[0], scheduled_for: "2100-01-01T00:00:00.000Z" }], null, 2)}\n`,
      "utf8"
    );
    await writeEvents(failure.runId, originalEvents.filter((event) => event.type !== "retry_scheduled"));

    await fetchJson(`/api/v0/runs/${failure.runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ max_nodes: 1 })
    });
    const restored = (await readEvents(failure.runId)).filter((event) => event.type === "retry_scheduled");
    expect(restored).toHaveLength(1);
    expect(restored[0]?.event_id).toBe(scheduledEvent?.event_id);
    expect((await fetchJson<{ attempts: unknown[] }>(`/api/v0/runs/${failure.runId}`)).attempts).toHaveLength(1);
  });

  it("projects waiting and due retry consistently across Scheduler and Node detail", async () => {
    const failure = await failFirstAttempt();
    const waitingRun = await fetchJson<{
      stop_reason: string;
      ticks: Array<{ decisions: Array<{ decision: string; reason_code: string; retry_decision?: { phase: string } }> }>;
    }>(`/api/v0/runs/${failure.runId}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    expect(waitingRun.stop_reason).toBe("waiting_for_retry");
    expect(waitingRun.ticks[0]?.decisions[0]).toMatchObject({
      decision: "wait",
      reason_code: "waiting_for_retry",
      retry_decision: { phase: "waiting_for_retry" }
    });
    const waitingDetail = await fetchJson<{ retry_decision: { phase: string; action: string } }>(
      `/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}`
    );
    expect(waitingDetail.retry_decision).toMatchObject({
      phase: "waiting_for_retry",
      action: "schedule_retry"
    });

    await writeFile(
      retrySchedulePath(failure.runId),
      `${JSON.stringify([{ ...failure.schedules[0], scheduled_for: "2020-01-01T00:00:00.000Z" }], null, 2)}\n`,
      "utf8"
    );
    const due = await fetchJson<{
      execution_plan: { decisions: Array<{ decision: string; reason_code: string }> };
      decisions: Array<{ decision: string; reason_code: string; retry_decision?: { phase: string } }>;
    }>(`/api/v0/runs/${failure.runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ dry_run: true, max_nodes: 1 })
    });
    expect(due.execution_plan.decisions[0]).toMatchObject({ decision: "execute", reason_code: "retry_due" });
    expect(due.decisions[0]).toMatchObject({
      decision: "execute",
      reason_code: "retry_due",
      retry_decision: { phase: "due" }
    });
    const dueDetail = await fetchJson<{ retry_decision: { phase: string } }>(
      `/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}`
    );
    expect(dueDetail.retry_decision.phase).toBe("due");
  });

  it("honors an explicit NodeSpec cost budget override", async () => {
    const failure = await failFirstAttempt(costOverrideWorkflow.id);
    expect(failure.retryDecision).toMatchObject({
      action: "require_attention",
      reason_code: "cost_budget_exhausted"
    });
    expect(failure.schedules).toEqual([]);
    const attention = await fetchJson<{ attention: unknown[] }>(`/api/v0/attention?run_id=${failure.runId}`);
    expect(attention.attention).toHaveLength(1);
    const detail = await fetchJson<{ retry_decision: { phase: string; action: string; reason_code: string } }>(
      `/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}`
    );
    expect(detail.retry_decision).toMatchObject({
      phase: "exhausted",
      action: "require_attention",
      reason_code: "cost_budget_exhausted"
    });
  });

  it("merges a new Attempt into an existing root-cause Attention and reopens it", async () => {
    const failure = await failFirstAttempt(policyWorkflow.id);
    const rootCauseKey = `run:${failure.runId}:node:${failure.nodeRunId}:retry:mock_failure`;
    await writeFile(
      path.join(tempWorkspace, "runs", failure.runId, "attention.json"),
      `${JSON.stringify([{
        attention_id: `att_${rootCauseKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
        root_cause_key: rootCauseKey,
        title: "Resolved first failure",
        severity: "P0",
        status: "resolved",
        related_objects: [
          { type: "NodeRun", id: failure.nodeRunId },
          { type: "NodeAttempt", id: failure.attempt.attempt_id }
        ],
        impact: { blocked_nodes: [failure.nodeRunId], waiting_agents: [], unaffected_paths: [] },
        safe_actions: ["retry_manually"]
      }], null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      retrySchedulePath(failure.runId),
      `${JSON.stringify([{ ...failure.schedules[0], scheduled_for: "2020-01-01T00:00:00.000Z" }], null, 2)}\n`,
      "utf8"
    );

    await fetchJson(`/api/v0/runs/${failure.runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ max_nodes: 1 })
    });

    const attention = await fetchJson<{
      attention: Array<{ root_cause_key: string; status: string; related_objects: Array<{ type: string; id: string }> }>;
    }>(`/api/v0/attention?run_id=${failure.runId}`);
    const item = attention.attention.find((candidate) => candidate.root_cause_key === rootCauseKey);
    const attempts = item?.related_objects.filter((object) => object.type === "NodeAttempt").map((object) => object.id);
    expect(item?.status).toBe("open");
    expect(attempts).toEqual(expect.arrayContaining([
      failure.attempt.attempt_id,
      `attempt_${failure.attempt.operation_id}_2`
    ]));
  });

  it("uses a complete NodeSpec retry policy for the first Attempt timeout", async () => {
    const failure = await failFirstAttempt(policyWorkflow.id);
    expect(failure.invocation.runtime_control.timeout_ms).toBe(1_234);
    expect(failure.schedules[0]).toMatchObject({
      attempt_number: 2,
      scheduled_for: expect.any(String)
    });
  });

  it("recovers a post-commit missing retry effect before direct execute and caps timeout by remaining budget", async () => {
    const failure = await failFirstAttempt(policyWorkflow.id);
    await writeFile(retrySchedulePath(failure.runId), "[]\n", "utf8");
    const attempts = JSON.parse(await readFile(attemptsPath(failure.runId), "utf8")) as Array<Record<string, unknown>>;
    const firstDispatch = new Date(Date.now() - 4_300).toISOString();
    attempts[0] = { ...attempts[0], started_at: firstDispatch, dispatched_at: firstDispatch };
    await writeFile(attemptsPath(failure.runId), `${JSON.stringify(attempts, null, 2)}\n`, "utf8");

    const response = await fetch(`${baseUrl}/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const body = await response.json() as {
      invocation?: { runtime_control: { timeout_ms: number } };
      error?: { code: string };
    };
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.invocation?.runtime_control.timeout_ms).toBeGreaterThan(0);
    expect(body.invocation?.runtime_control.timeout_ms).toBeLessThan(1_000);
    expect((await fetchJson<{ attempts: unknown[] }>(`/api/v0/runs/${failure.runId}`)).attempts).toHaveLength(2);
  });

  it("persists an exhausted tombstone and does not revive it from an old received_at", async () => {
    const failure = await failFirstAttempt(policyWorkflow.id);
    const attempts = JSON.parse(await readFile(attemptsPath(failure.runId), "utf8")) as Array<Record<string, unknown>>;
    attempts[0] = {
      ...attempts[0],
      started_at: "2020-01-01T00:00:00.000Z",
      dispatched_at: "2020-01-01T00:00:00.000Z",
      created_at: "2020-01-01T00:00:00.100Z"
    };
    await writeFile(attemptsPath(failure.runId), `${JSON.stringify(attempts, null, 2)}\n`, "utf8");
    await writeFile(
      retrySchedulePath(failure.runId),
      `${JSON.stringify([{ ...failure.schedules[0], scheduled_for: "2020-01-01T00:00:00.200Z" }], null, 2)}\n`,
      "utf8"
    );

    await fetchJson(`/api/v0/runs/${failure.runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ max_nodes: 1 })
    });
    await fetchJson(`/api/v0/runs/${failure.runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ max_nodes: 1 })
    });

    expect(await new RetryScheduleStore({ workspace_dir: tempWorkspace }).list(failure.runId)).toEqual([]);
    expect(JSON.parse(await readFile(retryStatePath(failure.runId), "utf8"))).toEqual([
      expect.objectContaining({
        operation_id: failure.attempt.operation_id,
        phase: "exhausted",
        reason_code: "time_budget_exhausted"
      })
    ]);
    expect((await fetchJson<{ attempts: unknown[] }>(`/api/v0/runs/${failure.runId}`)).attempts).toHaveLength(1);
  });

  it("projects queued time exhaustion before Scheduler reconcile and keeps Scheduler consistent", async () => {
    const failure = await failFirstAttempt(policyWorkflow.id);
    const attempts = JSON.parse(await readFile(attemptsPath(failure.runId), "utf8")) as Array<Record<string, unknown>>;
    attempts[0] = {
      ...attempts[0],
      started_at: "2020-01-01T00:00:00.000Z",
      dispatched_at: "2020-01-01T00:00:00.000Z"
    };
    await writeFile(attemptsPath(failure.runId), `${JSON.stringify(attempts, null, 2)}\n`, "utf8");
    await writeFile(
      retrySchedulePath(failure.runId),
      `${JSON.stringify([{ ...failure.schedules[0], scheduled_for: "2100-01-01T00:00:00.000Z" }], null, 2)}\n`,
      "utf8"
    );

    const detail = await fetchJson<{ retry_decision: { phase: string; action: string; reason_code: string } }>(
      `/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}`
    );
    expect(detail.retry_decision).toMatchObject({
      phase: "exhausted",
      action: "require_attention",
      reason_code: "time_budget_exhausted"
    });

    const dryRun = await fetchJson<{
      decisions: Array<{ decision: string; reason_code: string; retry_decision: { phase: string } }>;
      executable: unknown[];
    }>(`/api/v0/runs/${failure.runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ dry_run: true, max_nodes: 1 })
    });
    expect(dryRun.decisions[0]).toMatchObject({
      decision: "blocked",
      reason_code: "time_budget_exhausted",
      retry_decision: { phase: "exhausted" }
    });
    expect(dryRun.executable).toEqual([]);
  });

  it("rechecks elapsed time at Scheduler consumption and does not dispatch an exhausted retry", async () => {
    const failure = await failFirstAttempt();
    const attempts = JSON.parse(await readFile(attemptsPath(failure.runId), "utf8")) as Array<Record<string, unknown>>;
    attempts[0] = {
      ...attempts[0],
      started_at: "2020-01-01T00:00:00.000Z",
      dispatched_at: "2020-01-01T00:00:00.000Z"
    };
    await writeFile(attemptsPath(failure.runId), `${JSON.stringify(attempts, null, 2)}\n`, "utf8");
    await writeFile(
      retrySchedulePath(failure.runId),
      `${JSON.stringify([{ ...failure.schedules[0], scheduled_for: "2020-01-01T00:00:01.000Z" }], null, 2)}\n`,
      "utf8"
    );
    const dispatchesBefore = (await readEvents(failure.runId)).filter((event) => event.type === "runner_operation_dispatched").length;

    const tick = await fetchJson<{ executed: unknown[] }>(`/api/v0/runs/${failure.runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ max_nodes: 1 })
    });
    expect(tick.executed).toEqual([]);
    expect((await fetchJson<{ attempts: unknown[] }>(`/api/v0/runs/${failure.runId}`)).attempts).toHaveLength(1);
    expect((await readEvents(failure.runId)).filter((event) => event.type === "runner_operation_dispatched")).toHaveLength(dispatchesBefore);
    expect(await new RetryScheduleStore({ workspace_dir: tempWorkspace }).list(failure.runId)).toEqual([]);
    expect((await readEvents(failure.runId)).filter((event) => event.type === "retry_exhausted")).toHaveLength(1);
  });

  it("rechecks cost inside direct execute and blocks before adapter dispatch", async () => {
    const failure = await failFirstAttempt();
    const attempts = JSON.parse(await readFile(attemptsPath(failure.runId), "utf8")) as Array<Record<string, unknown>>;
    attempts[0] = {
      ...attempts[0],
      provider_receipt: { ...(attempts[0]?.provider_receipt as Record<string, unknown>), cost: 5 }
    };
    await writeFile(attemptsPath(failure.runId), `${JSON.stringify(attempts, null, 2)}\n`, "utf8");
    await writeFile(
      retrySchedulePath(failure.runId),
      `${JSON.stringify([{ ...failure.schedules[0], scheduled_for: "2020-01-01T00:00:01.000Z" }], null, 2)}\n`,
      "utf8"
    );
    const dispatchesBefore = (await readEvents(failure.runId)).filter((event) => event.type === "runner_operation_dispatched").length;

    const response = await fetch(`${baseUrl}/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "retry_budget_exhausted", reason_code: "cost_budget_exhausted" }
    });
    expect((await fetchJson<{ attempts: unknown[] }>(`/api/v0/runs/${failure.runId}`)).attempts).toHaveLength(1);
    expect((await readEvents(failure.runId)).filter((event) => event.type === "runner_operation_dispatched")).toHaveLength(dispatchesBefore);
    expect(await new RetryScheduleStore({ workspace_dir: tempWorkspace }).list(failure.runId)).toEqual([]);
  });

  it("projects unknown and invalid dispatch intents as blockers instead of scheduled retry", async () => {
    const failure = await failFirstAttempt();
    await writeFile(
      retrySchedulePath(failure.runId),
      `${JSON.stringify([{ ...failure.schedules[0], scheduled_for: "2100-01-01T00:00:00.000Z" }], null, 2)}\n`,
      "utf8"
    );
    const intentPath = dispatchIntentPath(failure.runId, failure.nodeRunId);
    await mkdir(path.dirname(intentPath), { recursive: true });
    const baseIntent = {
      node_run_id: failure.nodeRunId,
      invocation: failure.invocation,
      decision: {
        reason_code: "retryable_error",
        resolved_input_count: failure.invocation.resolved_inputs.length,
        resolved_input_ids: failure.invocation.resolved_inputs.map((input) => input.input_id)
      },
      event: {
        event_id: `evt_${failure.invocation.attempt_id}_inputs_resolved`,
        run_id: failure.runId,
        type: "node_inputs_resolved",
        subject: { type: "NodeRun", id: failure.nodeRunId },
        message: "Retry inputs resolved",
        created_at: failure.invocation.dispatched_at
      },
      prepared_at: failure.invocation.dispatched_at
    };
    await writeFile(intentPath, `${JSON.stringify({
      ...baseIntent,
      state: "dispatched_unknown",
      dispatched_at: failure.invocation.dispatched_at
    }, null, 2)}\n`, "utf8");
    const unknown = await fetchJson<{ retry_decision: { action: string; reason_code: string } }>(
      `/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}`
    );
    expect(unknown.retry_decision).toMatchObject({
      action: "require_attention",
      reason_code: "dispatch_result_unknown"
    });

    await writeFile(intentPath, `${JSON.stringify({
      ...baseIntent,
      state: "invalid_result",
      error: { code: "adapter_result_invalid", message: "Receipt association failed." }
    }, null, 2)}\n`, "utf8");
    const invalid = await fetchJson<{ retry_decision: { action: string; reason_code: string } }>(
      `/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}`
    );
    expect(invalid.retry_decision).toMatchObject({
      action: "fail_terminal",
      reason_code: "adapter_result_invalid"
    });
  });

  it("recovers a committed retry attempt behind a stale schedule without duplicate dispatch", async () => {
    const failure = await failFirstAttempt();
    const staleSchedule = { ...failure.schedules[0], scheduled_for: "2020-01-01T00:00:00.000Z" };
    await writeFile(retrySchedulePath(failure.runId), `${JSON.stringify([staleSchedule], null, 2)}\n`, "utf8");
    await stopSidecar();
    await startSidecar();
    await fetchJson(`/api/v0/runs/${failure.runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ max_nodes: 1 })
    });
    const afterRetry = await fetchJson<{
      attempts: Array<{ operation_id: string; attempt_number: number }>;
    }>(`/api/v0/runs/${failure.runId}`);
    expect(afterRetry.attempts.map((attempt) => attempt.attempt_number)).toEqual([1, 2]);
    expect(new Set(afterRetry.attempts.map((attempt) => attempt.operation_id))).toEqual(new Set([failure.attempt.operation_id]));
    const afterRetryEvents = await readEvents(failure.runId);
    expect(afterRetryEvents.filter((event) => event.type === "runner_operation_dispatched")).toHaveLength(2);

    await writeFile(retrySchedulePath(failure.runId), `${JSON.stringify([staleSchedule], null, 2)}\n`, "utf8");
    await writeEvents(failure.runId, afterRetryEvents.filter((event) => event.type !== "retry_exhausted" && event.type !== "attention_item_created"));
    await writeFile(path.join(tempWorkspace, "runs", failure.runId, "attention.json"), "[]\n", "utf8");
    await stopSidecar();
    await startSidecar();
    await fetchJson(`/api/v0/runs/${failure.runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ max_nodes: 1 })
    });

    const recovered = await fetchJson<{ attempts: unknown[] }>(`/api/v0/runs/${failure.runId}`);
    expect(recovered.attempts).toHaveLength(2);
    const recoveredEvents = await readEvents(failure.runId);
    expect(recoveredEvents.filter((event) => event.type === "runner_operation_dispatched")).toHaveLength(2);
    expect(recoveredEvents.filter((event) => event.type === "retry_exhausted")).toHaveLength(1);
    expect(await new RetryScheduleStore({ workspace_dir: tempWorkspace }).list(failure.runId)).toEqual([]);
    const attention = await fetchJson<{ attention: unknown[] }>(`/api/v0/attention?run_id=${failure.runId}`);
    expect(attention.attention).toHaveLength(1);
  }, 30_000);
});
