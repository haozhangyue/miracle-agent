import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { WorkflowSpec } from "@miracle/core";
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

async function replaceRetryStateWithLegacyFixture(runId: string, overrides: Record<string, unknown> = {}) {
  const records = JSON.parse(await readFile(retryStatePath(runId), "utf8")) as Array<Record<string, unknown>>;
  const current = records[0];
  if (!current) throw new Error("Expected current RetryState fixture");
  const {
    attempt_id: _attemptId,
    attempt_number: _attemptNumber,
    error: _error,
    effects_committed: _effectsCommitted,
    ...legacy
  } = current;
  const fixture = { ...legacy, ...overrides };
  await writeFile(retryStatePath(runId), `${JSON.stringify([fixture], null, 2)}\n`, "utf8");
  return { current, fixture };
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
      error: { code: string; message: string; recoverable: boolean };
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

  it("migrates a legacy waiting RetryState before Node detail, Scheduler, and direct execute read it", async () => {
    const failure = await failFirstAttempt(policyWorkflow.id);
    await writeFile(
      retrySchedulePath(failure.runId),
      `${JSON.stringify([{ ...failure.schedules[0], scheduled_for: "2020-01-01T00:00:00.000Z" }], null, 2)}\n`,
      "utf8"
    );
    const { fixture } = await replaceRetryStateWithLegacyFixture(failure.runId);
    expect(fixture).not.toHaveProperty("attempt_id");
    expect(fixture).not.toHaveProperty("error");

    const detail = await fetchJson<{
      retry_decision: { phase: string };
      execution_decision: { decision: string };
    }>(`/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}`);
    expect(detail.retry_decision.phase).toBe("due");
    expect(detail.execution_decision.decision).toBe("execute");

    const scheduler = await fetchJson<{
      decisions: Array<{ decision: string; retry_decision?: { phase: string } }>;
    }>(`/api/v0/runs/${failure.runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ dry_run: true, max_nodes: 1 })
    });
    expect(scheduler.decisions[0]).toMatchObject({
      decision: "execute",
      retry_decision: { phase: "due" }
    });

    const migrated = JSON.parse(await readFile(retryStatePath(failure.runId), "utf8")) as Array<Record<string, unknown>>;
    expect(migrated).toEqual([
      expect.objectContaining({
        operation_id: failure.attempt.operation_id,
        attempt_id: failure.attempt.attempt_id,
        attempt_number: failure.attempt.attempt_number,
        error: failure.attempt.error,
        effects_committed: true
      })
    ]);

    const direct = await fetch(`${baseUrl}/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(direct.status).toBe(200);
  });

  it("returns 409 instead of strict-parsing legacy RetryState while migration lock is busy", async () => {
    const failure = await failFirstAttempt(policyWorkflow.id);
    await replaceRetryStateWithLegacyFixture(failure.runId);
    const lockDir = path.join(
      tempWorkspace,
      "runs",
      failure.runId,
      "locks",
      `${failure.runId.replace(/[^a-zA-Z0-9._-]/g, "_")}.mutation.lock`
    );
    await mkdir(lockDir, { recursive: true });

    try {
      for (const request of [
        fetch(`${baseUrl}/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}`),
        fetch(`${baseUrl}/api/v0/runs/${failure.runId}/scheduler/tick`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dry_run: true, max_nodes: 1 })
        }),
        fetch(`${baseUrl}/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}/execute`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        })
      ]) {
        const response = await request;
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          error: { code: "operation_in_progress" }
        });
      }
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }

    const recovered = await fetchJson<{ retry_decision: { phase: string } }>(
      `/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}`
    );
    expect(["waiting_for_retry", "due"]).toContain(recovered.retry_decision.phase);
  });

  it("migrates a legacy exhausted RetryState without parse failures or duplicate terminal effects", async () => {
    const failure = await failFirstAttempt(costOverrideWorkflow.id);
    const { fixture } = await replaceRetryStateWithLegacyFixture(failure.runId);
    expect(fixture).not.toHaveProperty("effects_committed");

    const detail = await fetchJson<{
      retry_decision: { phase: string; reason_code: string };
      execution_decision: { decision: string; reason_code: string };
    }>(`/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}`);
    expect(detail.retry_decision).toMatchObject({
      phase: "exhausted",
      reason_code: "cost_budget_exhausted"
    });
    expect(detail.execution_decision.decision).toBe("blocked");

    const scheduler = await fetchJson<{
      stop_reason: string;
      next_suggested_actions: string[];
    }>(`/api/v0/runs/${failure.runId}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    expect(scheduler.stop_reason).toBe("attention_required");

    const direct = await fetch(`${baseUrl}/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(direct.status).toBe(409);
    const migrated = JSON.parse(await readFile(retryStatePath(failure.runId), "utf8")) as Array<Record<string, unknown>>;
    expect(migrated).toEqual([
      expect.objectContaining({
        operation_id: failure.attempt.operation_id,
        attempt_id: failure.attempt.attempt_id,
        attempt_number: failure.attempt.attempt_number,
        error: failure.attempt.error,
        effects_committed: true
      })
    ]);
    expect((await readEvents(failure.runId)).filter((event) => event.type === "retry_exhausted")).toHaveLength(1);
  });

  it("blocks an unresolvable legacy RetryState with a migration Attention instead of returning 500", async () => {
    const failure = await failFirstAttempt(policyWorkflow.id);
    const unmatchedOperationId = "op_unmatched_legacy_state";
    const currentState = (JSON.parse(await readFile(retryStatePath(failure.runId), "utf8")) as Array<Record<string, unknown>>)[0]!;
    const currentDecision = currentState.decision as Record<string, unknown>;
    await writeFile(retrySchedulePath(failure.runId), "[]\n", "utf8");
    await replaceRetryStateWithLegacyFixture(failure.runId, {
      operation_id: unmatchedOperationId,
      decision: { ...currentDecision, operation_id: unmatchedOperationId }
    });

    const detail = await fetchJson<{
      execution_decision: { decision: string; reason_code: string };
      next_suggested_actions: string[];
    }>(`/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}`);
    expect(detail.execution_decision).toMatchObject({
      decision: "blocked",
      reason_code: "retry_state_migration_failed"
    });
    expect(detail.next_suggested_actions).toEqual(["inspect_attention", "retry_manually"]);

    const scheduler = await fetchJson<{
      stop_reason: string;
      next_suggested_actions: string[];
    }>(`/api/v0/runs/${failure.runId}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    expect(scheduler.stop_reason).toBe("attention_required");
    expect(scheduler.next_suggested_actions).toEqual(detail.next_suggested_actions);

    const direct = await fetch(`${baseUrl}/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(direct.status).toBe(409);
    const attention = await fetchJson<{
      attention: Array<{ root_cause_key: string; safe_actions: string[] }>;
    }>(`/api/v0/attention?run_id=${failure.runId}`);
    expect(attention.attention).toEqual(expect.arrayContaining([
      expect.objectContaining({
        root_cause_key: `run:${failure.runId}:node:${failure.nodeRunId}:retry_state_migration:${unmatchedOperationId}`,
        safe_actions: ["inspect_retry_state", "repair_retry_state"]
      })
    ]));
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

  it.each([
    {
      phase: "exhausted",
      action: "require_attention",
      reasonCode: "attempt_budget_exhausted",
      error: { code: "mock_failure", message: "Retry budget exhausted.", recoverable: true }
    },
    {
      phase: "blocked",
      action: "fail_terminal",
      reasonCode: "error_not_retryable",
      error: { code: "permission_denied", message: "Adapter permission denied.", recoverable: false }
    }
  ] as const)("replays missing $phase effects from durable retry state after restart", async ({ phase, action, reasonCode, error }) => {
    const failure = await failFirstAttempt(policyWorkflow.id);
    const state = {
      operation_id: failure.attempt.operation_id,
      node_run_id: failure.nodeRunId,
      attempt_id: failure.attempt.attempt_id,
      attempt_number: failure.attempt.attempt_number,
      phase,
      reason_code: reasonCode,
      decision: {
        action,
        reason_code: reasonCode,
        operation_id: failure.attempt.operation_id,
        budget_snapshot: failure.schedules[0]!.budget_snapshot
      },
      error,
      effects_committed: false,
      updated_at: new Date().toISOString()
    };
    await writeFile(retryStatePath(failure.runId), `${JSON.stringify([state], null, 2)}\n`, "utf8");
    await writeEvents(failure.runId, (await readEvents(failure.runId)).filter((event) =>
      event.type !== "retry_exhausted" && event.type !== "attention_item_created" && event.type !== "attention_item_reopened"
    ));
    await writeFile(path.join(tempWorkspace, "runs", failure.runId, "attention.json"), "[]\n", "utf8");

    await stopSidecar();
    await startSidecar();
    await fetchJson(`/api/v0/runs/${failure.runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ dry_run: true, max_nodes: 1 })
    });

    expect(JSON.parse(await readFile(retryStatePath(failure.runId), "utf8"))).toEqual([
      expect.objectContaining({
        operation_id: failure.attempt.operation_id,
        phase,
        attempt_id: failure.attempt.attempt_id,
        error,
        effects_committed: true
      })
    ]);
    expect((await readEvents(failure.runId)).filter((event) => event.type === "retry_exhausted")).toHaveLength(1);
    const attention = await fetchJson<{
      attention: Array<{ root_cause_key: string; related_objects: Array<{ type: string; id: string }> }>;
    }>(`/api/v0/attention?run_id=${failure.runId}`);
    expect(attention.attention).toEqual([
      expect.objectContaining({
        root_cause_key: `run:${failure.runId}:node:${failure.nodeRunId}:retry:${error.code}`,
        related_objects: expect.arrayContaining([
          { type: "NodeAttempt", id: failure.attempt.attempt_id }
        ])
      })
    ]);
    expect(await new RetryScheduleStore({ workspace_dir: tempWorkspace }).list(failure.runId)).toEqual([]);

    await stopSidecar();
    await startSidecar();
    await fetchJson(`/api/v0/runs/${failure.runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ dry_run: true, max_nodes: 1 })
    });
    expect((await readEvents(failure.runId)).filter((event) => event.type === "retry_exhausted")).toHaveLength(1);
    expect((await fetchJson<{ attention: unknown[] }>(`/api/v0/attention?run_id=${failure.runId}`)).attention).toHaveLength(1);
  }, 30_000);

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

  it("recalculates a due retry through missing input and Gate state before exposing it as executable", async () => {
    const failure = await failFirstAttempt(policyWorkflow.id);
    await writeFile(
      retrySchedulePath(failure.runId),
      `${JSON.stringify([{ ...failure.schedules[0], scheduled_for: "2020-01-01T00:00:00.000Z" }], null, 2)}\n`,
      "utf8"
    );
    const runDir = path.join(tempWorkspace, "runs", failure.runId);
    const snapshotPath = path.join(runDir, "workflow_snapshot.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      workflow: WorkflowSpec;
    };
    const target = snapshot.workflow.nodes.find((node) => node.id === "transient_node")!;
    target.inputs = [{
      id: "required_source",
      kind: "artifact",
      artifact_type: "markdown",
      artifact_spec_ref: "required_source_artifact",
      required: true
    }];
    snapshot.workflow.nodes.unshift({
      ...target,
      id: "source_node",
      name: "Source node",
      inputs: [],
      outputs: [{
        id: "source_output",
        kind: "artifact",
        artifact_type: "markdown",
        artifact_spec_ref: "required_source_artifact",
        required: true
      }],
      failure_policy: { retry: 0, on_missing_input: "blocked", on_provider_failure: "failed" }
    });
    snapshot.workflow.edges = [{
      from: "source_node",
      to: "transient_node",
      required: true,
      artifact_selector: { artifact_type: "markdown" },
      join_policy: {
        wait_if_active: true,
        on_timeout: "blocked",
        on_no_qualified_artifact: "block_downstream"
      }
    }];
    snapshot.workflow.artifacts = [{
      id: "required_source_artifact",
      type: "markdown",
      produced_by: "source_node",
      review_policy: { mode: "none" },
      required_for: ["transient_node"],
      versioning: { immutable: true, compare_by: "hash" }
    }];
    snapshot.workflow.gates = [];
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    const nodesPath = path.join(runDir, "nodes.json");
    const nodes = JSON.parse(await readFile(nodesPath, "utf8")) as Array<Record<string, unknown>>;
    const sourceNodeRunId = `nr_${failure.runId}_source_node`;
    nodes.unshift({
      node_run_id: sourceNodeRunId,
      run_id: failure.runId,
      node_id: "source_node",
      status: "done",
      updated_at: new Date().toISOString(),
      upstream_artifacts: [],
      output_artifacts: []
    });
    await writeFile(nodesPath, `${JSON.stringify(nodes, null, 2)}\n`, "utf8");

    const blockedDryRun = await fetchJson<{
      execution_plan: {
        decisions: Array<{ node_id: string; decision: string; reason_code: string }>;
        ready_node_run_ids: string[];
        blocked_node_run_ids: string[];
        terminal: boolean;
      };
      decisions: Array<{ node_id: string; decision: string; reason_code: string; retry_decision?: { phase: string } }>;
      executable: unknown[];
    }>(`/api/v0/runs/${failure.runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ dry_run: true, max_nodes: 1 })
    });
    expect(blockedDryRun.execution_plan.decisions.find((decision) => decision.node_id === "transient_node")).toMatchObject({
      decision: "blocked",
      reason_code: "required_input_missing"
    });
    expect(blockedDryRun.decisions.find((decision) => decision.node_id === "transient_node")).toMatchObject({
      decision: "blocked",
      reason_code: "required_input_missing",
      retry_decision: { phase: "due" }
    });
    expect(blockedDryRun.execution_plan.ready_node_run_ids).not.toContain(failure.nodeRunId);
    expect(blockedDryRun.execution_plan.blocked_node_run_ids).toContain(failure.nodeRunId);
    expect(blockedDryRun.execution_plan.terminal).toBe(false);
    expect(blockedDryRun.executable).toEqual([]);
    expect((await fetchJson<{ attempts: unknown[] }>(`/api/v0/runs/${failure.runId}`)).attempts).toHaveLength(1);

    const stopped = await fetchJson<{
      stop_reason: string;
      next_suggested_actions: string[];
    }>(`/api/v0/runs/${failure.runId}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    const blockedDetail = await fetchJson<{
      execution_decision: { decision: string; reason_code: string };
      next_suggested_actions: string[];
    }>(`/api/v0/runs/${failure.runId}/nodes/${failure.nodeRunId}`);
    expect(stopped.stop_reason).toBe("attention_required");
    expect(stopped.next_suggested_actions).toEqual(blockedDetail.next_suggested_actions);
    expect(blockedDetail.execution_decision).toMatchObject({
      decision: "blocked",
      reason_code: "required_input_missing"
    });

    snapshot.workflow.artifacts[0]!.review_policy = {
      mode: "manual",
      gate_spec_id: "required_source_gate"
    };
    snapshot.workflow.gates = [{
      id: "required_source_gate",
      name: "Required source review",
      target_artifact_ref: "required_source_artifact",
      required_before: ["transient_node"],
      actions: ["approve", "reject"]
    }];
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    const artifactId = `art_${failure.runId}_required_source_v1`;
    await writeFile(path.join(runDir, "artifacts.json"), `${JSON.stringify([{
      artifact_id: artifactId,
      artifact_spec_ref: "required_source_artifact",
      run_id: failure.runId,
      node_run_id: sourceNodeRunId,
      type: "markdown",
      version: 1,
      path: `artifacts/${artifactId}.md`,
      hash: "sha256:required-source",
      status: "created",
      review_status: "pending_review",
      producer: "source-agent",
      created_at: new Date().toISOString()
    }], null, 2)}\n`, "utf8");
    const nodesWithSourceArtifact = JSON.parse(await readFile(nodesPath, "utf8")) as Array<Record<string, unknown>>;
    nodesWithSourceArtifact.find((node) => node.node_run_id === sourceNodeRunId)!.output_artifacts = [artifactId];
    await writeFile(nodesPath, `${JSON.stringify(nodesWithSourceArtifact, null, 2)}\n`, "utf8");
    const gatePath = path.join(runDir, "gates.json");
    await writeFile(gatePath, `${JSON.stringify([{
      gate_instance_id: `gate_${artifactId}`,
      run_id: failure.runId,
      gate_spec_id: "required_source_gate",
      target: { type: "ArtifactManifest", id: artifactId },
      status: "pending_review",
      required_before: ["transient_node"],
      decisions: []
    }], null, 2)}\n`, "utf8");

    const paused = await fetchJson<{
      execution_plan: {
        decisions: Array<{ node_id: string; decision: string; reason_code: string }>;
        paused_node_run_ids: string[];
        blocked_node_run_ids: string[];
        terminal: boolean;
      };
    }>(`/api/v0/runs/${failure.runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ dry_run: true, max_nodes: 1 })
    });
    expect(paused.execution_plan.decisions.find((decision) => decision.node_id === "transient_node")).toMatchObject({
      decision: "pause_for_gate",
      reason_code: "required_gate_pending"
    });
    expect(paused.execution_plan.paused_node_run_ids).toContain(failure.nodeRunId);
    expect(paused.execution_plan.blocked_node_run_ids).not.toContain(failure.nodeRunId);
    expect(paused.execution_plan.terminal).toBe(false);

    const gates = JSON.parse(await readFile(gatePath, "utf8")) as Array<Record<string, unknown>>;
    gates[0] = {
      ...gates[0],
      status: "decided",
      decisions: [{
        decision_id: "decision_required_source_approved",
        actor: "reviewer",
        decision: "approve",
        comment: "approved",
        created_at: new Date().toISOString()
      }]
    };
    await writeFile(gatePath, `${JSON.stringify(gates, null, 2)}\n`, "utf8");
    const due = await fetchJson<{
      execution_plan: {
        decisions: Array<{ node_id: string; decision: string; reason_code: string }>;
        ready_node_run_ids: string[];
        paused_node_run_ids: string[];
        blocked_node_run_ids: string[];
        terminal: boolean;
      };
    }>(`/api/v0/runs/${failure.runId}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ dry_run: true, max_nodes: 1 })
    });
    expect(due.execution_plan.decisions.find((decision) => decision.node_id === "transient_node")).toMatchObject({
      decision: "execute",
      reason_code: "retry_due"
    });
    expect(due.execution_plan.ready_node_run_ids).toContain(failure.nodeRunId);
    expect(due.execution_plan.paused_node_run_ids).not.toContain(failure.nodeRunId);
    expect(due.execution_plan.blocked_node_run_ids).not.toContain(failure.nodeRunId);
    expect(due.execution_plan.terminal).toBe(false);
  }, 30_000);

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
    const retryStates = JSON.parse(await readFile(retryStatePath(failure.runId), "utf8")) as Array<Record<string, unknown>>;
    retryStates[0] = { ...retryStates[0], effects_committed: false };
    await writeFile(retryStatePath(failure.runId), `${JSON.stringify(retryStates, null, 2)}\n`, "utf8");
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
