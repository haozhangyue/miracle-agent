import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAdapterInvocation,
  type NodeAttempt,
  type NodeRun,
  type RetryScheduleRecord,
  type RunSpec,
  type WorkflowSpec
} from "@miracle/core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureWorkspace = path.join(repoRoot, "fixtures/mvp-workspace/.miracle");
let tempRoot = "";
let workspace = "";
let sidecar: ChildProcessWithoutNullStreams | undefined;
let providerServer: ReturnType<typeof createServer> | undefined;
let baseUrl = "";
let output = "";
let providerBaseUrl = "";

const fallbackWorkflow: WorkflowSpec = {
  id: "provider-fallback-v0",
  name: "Provider fallback test",
  version: "0.1.0",
  domain: "test",
  category: "test",
  nodes: [{
    id: "model_node",
    name: "Model node",
    type: "agent",
    capability_requirements: ["model.call"],
    recommended_libraries: [],
    agent_candidates: ["test-agent"],
    inputs: [],
    outputs: [],
    failure_policy: {
      retry: 1,
      retry_policy: {
        max_attempts: 2,
        backoff: "fixed",
        initial_delay_ms: 0,
        max_delay_ms: 0,
        retryable_error_codes: ["rate_limit"],
        attempt_timeout_ms: 5_000,
        total_time_budget_ms: 30_000,
        cost_budget: 5
      },
      on_missing_input: "blocked",
      on_provider_failure: "failed"
    }
  }],
  edges: [],
  gates: [],
  artifacts: [],
  provider_policy: {
    default_provider: "deepseek",
    allowed_providers: ["deepseek", "kimi"],
    required_credentials: ["DEEPSEEK_API_KEY", "MOONSHOT_API_KEY"],
    fallback_providers: ["kimi"]
  },
  layouts: { dag: { model_node: { x: 0, y: 0 } } },
  registry_meta: { source: "test", status: "experimental" }
};

const crossKindWorkflow = {
  ...fallbackWorkflow,
  id: "cross-kind-fallback-v0",
  name: "Cross-kind fallback confirmation test",
  nodes: [{
    ...fallbackWorkflow.nodes[0],
    id: "content_node",
    capability_requirements: ["model.call"],
    recommended_libraries: ["codex-cli-real"],
    runtime_policy: {
      allowed_adapter_kinds: ["codex", "model-api"],
      automatic_cross_kind_fallback: false
    },
    failure_policy: {
      retry: 1,
      retry_policy: {
        max_attempts: 2,
        backoff: "fixed",
        initial_delay_ms: 0,
        max_delay_ms: 0,
        retryable_error_codes: ["adapter_process_error"],
        attempt_timeout_ms: 5_000,
        total_time_budget_ms: 30_000,
        cost_budget: 5
      },
      on_missing_input: "blocked",
      on_provider_failure: "failed"
    }
  }],
  provider_policy: {
    default_provider: "codex-local",
    allowed_providers: ["codex-local", "kimi"],
    required_credentials: ["MOONSHOT_API_KEY"],
    fallback_providers: ["kimi"]
  },
  layouts: { dag: { content_node: { x: 0, y: 0 } } }
};

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/v0/health`)).ok) return;
    } catch {
      // Sidecar is starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Sidecar did not become healthy: ${output}`);
}

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Port probe did not bind.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "miracle-provider-fallback-"));
  workspace = path.join(tempRoot, ".miracle");
  await cp(fixtureWorkspace, workspace, { recursive: true });
  const providerPort = await unusedLoopbackPort();
  providerBaseUrl = `http://127.0.0.1:${providerPort}`;
  providerServer = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200).end("ok");
      return;
    }
    for await (const _chunk of request) {
      // Consume the request body.
    }
    if (request.headers.authorization === "Bearer deepseek-fixture-key") {
      response.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "rate limited" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      id: "kimi-fallback-success",
      choices: [{ message: { content: "fallback succeeded" } }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
    }));
  });
  await new Promise<void>((resolve) => providerServer?.listen(providerPort, "127.0.0.1", resolve));
  await mkdir(path.join(workspace, "workflows"), { recursive: true });
  await writeFile(path.join(workspace, "workflows/provider-fallback-v0.json"), `${JSON.stringify(fallbackWorkflow, null, 2)}\n`, "utf8");
  await writeFile(path.join(workspace, "workflows/cross-kind-fallback-v0.json"), `${JSON.stringify(crossKindWorkflow, null, 2)}\n`, "utf8");
  const providerEntry = (input: { id: string; driver: string; apiPath: string; credential: string; priority: number; costTier: number }) => ({
    id: input.id,
    display_name: input.id,
    driver_id: input.driver,
    profile: {
      id: `${input.id}-default`,
      provider: input.id,
      model: `${input.id}-fixture`,
      base_url: providerBaseUrl,
      api_path: input.apiPath,
      credential_ref: input.credential,
      verification_status: "healthy",
      verified_at: "2026-08-01T00:00:00.000Z"
    },
    credential: { key: input.credential, source: "env" },
    documentation: { official_url: `https://example.invalid/${input.id}`, verified_at: "2026-08-01T00:00:00.000Z" },
    capabilities: ["model.call"],
    cancellation: "http_abort",
    routing: { user_priority: input.priority, cost_tier: input.costTier, estimated_cost: { currency: "USD", min: 0.01, max: 0.02 } }
  });
  await writeFile(path.join(workspace, "providers/deepseek.json"), `${JSON.stringify(providerEntry({ id: "deepseek", driver: "deepseek", apiPath: "/chat/completions", credential: "DEEPSEEK_API_KEY", priority: 1, costTier: 1 }), null, 2)}\n`, "utf8");
  await writeFile(path.join(workspace, "providers/kimi.json"), `${JSON.stringify(providerEntry({ id: "kimi", driver: "kimi", apiPath: "/v1/chat/completions", credential: "MOONSHOT_API_KEY", priority: 2, costTier: 2 }), null, 2)}\n`, "utf8");
  await rm(path.join(workspace, "providers/minimax.json"), { force: true });
  const port = await unusedLoopbackPort();
  baseUrl = `http://127.0.0.1:${port}`;
  sidecar = spawn("npm", ["run", "dev", "-w", "apps/sidecar"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MIRACLE_WORKSPACE_DIR: workspace,
      MIRACLE_SIDECAR_PORT: String(port),
      MIRACLE_ENABLE_REAL_CODEX: "1",
      DEEPSEEK_API_KEY: "deepseek-fixture-key",
      MOONSHOT_API_KEY: "kimi-fixture-key"
    }
  });
  sidecar.stdout.on("data", (chunk) => { output += chunk.toString(); });
  sidecar.stderr.on("data", (chunk) => { output += chunk.toString(); });
  await waitForHealth();
}, 15_000);

afterAll(async () => {
  sidecar?.kill("SIGTERM");
  if (providerServer?.listening) await new Promise<void>((resolve, reject) => providerServer?.close((error) => error ? reject(error) : resolve()));
  await new Promise((resolve) => setTimeout(resolve, 200));
  await rm(tempRoot, { recursive: true, force: true });
});

async function prepareCrossKindRetry(operationId: string) {
  const runResponse = await fetch(`${baseUrl}/api/v0/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflow_id: crossKindWorkflow.id, execution_policy: "auto" })
  });
  const run = await runResponse.json() as { run_id: string; initial_node_runs: string[] };
  expect(runResponse.status).toBe(201);
  const nodeRunId = run.initial_node_runs[0]!;
  const attemptedAt = new Date(Date.now() - 1_000).toISOString();
  const runDir = path.join(workspace, `runs/${run.run_id}`);
  const runSpec = JSON.parse(await readFile(path.join(runDir, "run_spec.json"), "utf8")) as { resolved_components: string[] };
  runSpec.resolved_components = [...new Set([...runSpec.resolved_components, "codex-cli-real"])];
  await writeFile(path.join(runDir, "run_spec.json"), `${JSON.stringify(runSpec, null, 2)}\n`, "utf8");
  await writeFile(path.join(runDir, "attempts.json"), `${JSON.stringify([{
    attempt_id: `attempt_${operationId}`,
    node_run_id: nodeRunId,
    operation_id: operationId,
    attempt_number: 1,
    attempt_kind: "execute",
    status: "failed",
    provider_receipt: { provider: "codex-local", adapter_kind: "codex", adapter_id: "codex-cli-real", operation_id: operationId },
    error: { code: "adapter_process_error", message: "fixture", recoverable: true },
    created_at: attemptedAt,
    dispatched_at: attemptedAt,
    received_at: attemptedAt
  }], null, 2)}\n`, "utf8");
  await writeFile(path.join(runDir, "retry_schedule.json"), `${JSON.stringify([{
    operation_id: operationId,
    node_run_id: nodeRunId,
    attempt_number: 2,
    reason_code: "retryable_error",
    scheduled_for: attemptedAt,
    budget_snapshot: { attempts_used: 1, elapsed_ms: 1_000, cost_used: 0, max_attempts: 2, total_time_budget_ms: 30_000, cost_budget: 5 }
  }], null, 2)}\n`, "utf8");
  return { runId: run.run_id, nodeRunId };
}

function nodeDispatchIntentPath(runId: string, nodeRunId: string) {
  const prefix = nodeRunId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48) || "node";
  const suffix = createHash("sha256").update(nodeRunId).digest("hex").slice(0, 16);
  return path.join(workspace, "runs", runId, "dispatches", `${prefix}_${suffix}.json`);
}

describe("provider fallback orchestration", () => {
  it("returns a read-only observability projection with complete fallback attempts and no secrets", async () => {
    const runResponse = await fetch(`${baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_id: fallbackWorkflow.id, execution_policy: "auto" })
    });
    const run = await runResponse.json() as { run_id: string; initial_node_runs: string[] };
    expect(runResponse.status).toBe(201);
    await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${run.initial_node_runs[0]}/execute`, { method: "POST" });
    await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${run.initial_node_runs[0]}/execute`, { method: "POST" });

    const response = await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/observability`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      operations: Array<{ operation_id: string; attempts: Array<{ provider: string; provider_profile_id?: string; model?: string }> }>;
      scheduler: { next_suggested_actions: string[] };
    };
    expect(body.operations).toEqual([
      expect.objectContaining({
        attempts: [
          expect.objectContaining({ provider: "deepseek", provider_profile_id: "deepseek-default" }),
          expect.objectContaining({ provider: "kimi", provider_profile_id: "kimi-default", model: "kimi-fixture" })
        ]
      })
    ]);
    expect(body.scheduler.next_suggested_actions).toEqual(expect.any(Array));
    expect(JSON.stringify(body)).not.toContain("fixture-key");
    expect(JSON.stringify(body)).not.toContain("prompt_path");
    expect(JSON.stringify(body)).not.toContain("attempt_workspace");
  });

  it("stops an active automatic retry through the Orchestrator and leaves an auditable terminal state", async () => {
    const runResponse = await fetch(`${baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_id: fallbackWorkflow.id, execution_policy: "auto" })
    });
    const run = await runResponse.json() as { run_id: string; initial_node_runs: string[] };
    await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${run.initial_node_runs[0]}/execute`, { method: "POST" });

    const stopped = await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${run.initial_node_runs[0]}/retry/stop`, { method: "POST" });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ status: "stopped", operation_id: expect.any(String), reason_code: "auto_retry_stopped" });

    const node = await (await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${run.initial_node_runs[0]}`)).json() as {
      retry_decision?: { phase?: string; reason_code?: string };
    };
    expect(node.retry_decision).toMatchObject({ phase: "exhausted", reason_code: "auto_retry_stopped" });
  });

  it("reuses the operation id and creates a new Attempt when falling back from DeepSeek 429 to Kimi", async () => {
    const runResponse = await fetch(`${baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_id: fallbackWorkflow.id, execution_policy: "auto" })
    });
    const run = await runResponse.json() as { run_id: string; initial_node_runs: string[] };
    expect(runResponse.status).toBe(201);

    const firstResponse = await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${run.initial_node_runs[0]}/execute`, { method: "POST" });
    const first = await firstResponse.json() as { invocation: { operation_id: string }; adapter_result: { status: string }; retry_decision: { action: string } };
    expect(firstResponse.status).toBe(200);
    expect(first).toMatchObject({ adapter_result: { status: "failed" }, retry_decision: { action: "schedule_retry" } });

    const secondResponse = await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${run.initial_node_runs[0]}/execute`, { method: "POST" });
    const second = await secondResponse.json() as { invocation: { operation_id: string; attempt_number: number; provider: string; provider_profile_id?: string }; adapter_result: { status: string } };
    expect(secondResponse.status).toBe(200);
    expect(second).toMatchObject({
      invocation: { operation_id: first.invocation.operation_id, attempt_number: 2, provider: "kimi", provider_profile_id: "kimi-default" },
      adapter_result: { status: "succeeded", provider_receipt: { provider_profile_id: "kimi-default" } }
    });

    const detail = await (await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${run.initial_node_runs[0]}`)).json() as {
      attempts: Array<{ operation_id: string; provider_receipt?: { provider?: string } }>;
    };
    expect(detail.attempts.map((attempt) => [attempt.operation_id, attempt.provider_receipt?.provider])).toEqual([
      [first.invocation.operation_id, "deepseek"],
      [first.invocation.operation_id, "kimi"]
    ]);

    const routing = await (await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/routing-decisions`)).json() as {
      routing_decisions: Array<{ selected_provider_profile_id?: string }>;
    };
    expect(routing.routing_decisions).toContainEqual(expect.objectContaining({ selected_provider_profile_id: "kimi-default" }));
    const events = await (await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/events`)).json() as { events: Array<{ type: string }> };
    expect(events.events.map((event) => event.type)).toEqual(expect.arrayContaining(["provider_fallback_started", "provider_fallback_completed"]));
  });

  it("executes the exact selected Profile when one Provider has multiple Profiles", async () => {
    const sourcePath = path.join(workspace, "providers/kimi.json");
    const alternatePath = path.join(workspace, "providers/kimi-alternate.json");
    const alternate = JSON.parse(await readFile(sourcePath, "utf8")) as {
      id: string;
      display_name: string;
      profile: { id: string; model: string };
      routing: { user_priority: number; cost_tier: number };
    };
    alternate.id = "kimi-alternate";
    alternate.display_name = "kimi alternate";
    alternate.profile.id = "kimi-alternate-profile";
    alternate.profile.model = "kimi-alternate-fixture";
    alternate.routing = { user_priority: 0, cost_tier: 0 };
    await writeFile(alternatePath, `${JSON.stringify(alternate, null, 2)}\n`, "utf8");
    try {
      const runResponse = await fetch(`${baseUrl}/api/v0/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow_id: fallbackWorkflow.id, execution_policy: "auto" })
      });
      const run = await runResponse.json() as { run_id: string; initial_node_runs: string[] };
      const first = await (await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${run.initial_node_runs[0]}/execute`, { method: "POST" })).json() as {
        invocation: { operation_id: string };
      };
      const secondResponse = await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${run.initial_node_runs[0]}/execute`, { method: "POST" });
      expect(secondResponse.status).toBe(200);
      expect(await secondResponse.json()).toMatchObject({
        invocation: { operation_id: first.invocation.operation_id, provider: "kimi", provider_profile_id: "kimi-alternate-profile" },
        adapter_result: {
          status: "succeeded",
          provider_receipt: { provider: "kimi", provider_profile_id: "kimi-alternate-profile", model: "kimi-alternate-fixture" }
        }
      });
    } finally {
      await rm(alternatePath, { force: true });
    }
  });

  it("reroutes a prepared fallback dispatch intent when the selected Profile changes before dispatch", async () => {
    const runResponse = await fetch(`${baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_id: fallbackWorkflow.id, execution_policy: "auto" })
    });
    const run = await runResponse.json() as { run_id: string; initial_node_runs: string[] };
    const nodeRunId = run.initial_node_runs[0]!;
    const first = await (await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${nodeRunId}/execute`, { method: "POST" })).json() as {
      invocation: { operation_id: string };
    };
    const bundle = await (await fetch(`${baseUrl}/api/v0/runs/${run.run_id}`)).json() as {
      run: RunSpec;
      nodes: NodeRun[];
      attempts: NodeAttempt[];
    };
    const schedule = (JSON.parse(await readFile(path.join(workspace, `runs/${run.run_id}/retry_schedule.json`), "utf8")) as RetryScheduleRecord[])[0]!;
    const firstDispatchedAt = bundle.attempts[0]!.dispatched_at!;
    const operationDeadlineAt = new Date(Date.parse(firstDispatchedAt) + 30_000).toISOString();
    const preparedAt = new Date().toISOString();
    const invocation = createAdapterInvocation({
      runSpec: bundle.run,
      workflow: fallbackWorkflow,
      nodeRun: { ...bundle.nodes[0]!, provider: "kimi" },
      createdAt: preparedAt,
      adapterKind: "model-api",
      adapterId: "model-api-compatible-adapter",
      resolvedInputs: [],
      operationId: schedule.operation_id,
      attemptNumber: schedule.attempt_number,
      providerProfileId: "kimi-default",
      remainingTotalBudgetMs: Date.parse(operationDeadlineAt) - Date.parse(preparedAt)
    });
    const intentPath = nodeDispatchIntentPath(run.run_id, nodeRunId);
    await mkdir(path.dirname(intentPath), { recursive: true });
    await writeFile(intentPath, `${JSON.stringify({
      node_run_id: nodeRunId,
      invocation,
      decision: { reason_code: schedule.reason_code, resolved_input_count: 0, resolved_input_ids: [] },
      event: {
        event_id: `evt_${invocation.attempt_id}_inputs_resolved`,
        run_id: run.run_id,
        type: "node_inputs_resolved",
        subject: { type: "NodeRun", id: nodeRunId },
        message: `NodeRun ${nodeRunId} resolved 0 input(s); reason_code=${schedule.reason_code}`,
        created_at: preparedAt
      },
      state: "prepared",
      prepared_at: preparedAt,
      operation_deadline_at: operationDeadlineAt
    }, null, 2)}\n`, "utf8");

    const sourcePath = path.join(workspace, "providers/kimi.json");
    const replacementPath = path.join(workspace, "providers/kimi-recovery.json");
    const replacement = JSON.parse(await readFile(sourcePath, "utf8")) as {
      id: string;
      display_name: string;
      profile: { id: string; model: string };
      routing: { user_priority: number; cost_tier: number };
    };
    replacement.id = "kimi-recovery";
    replacement.display_name = "kimi recovery";
    replacement.profile.id = "kimi-recovery-profile";
    replacement.profile.model = "kimi-recovery-fixture";
    replacement.routing = { user_priority: 0, cost_tier: 0 };
    await writeFile(replacementPath, `${JSON.stringify(replacement, null, 2)}\n`, "utf8");
    try {
      const resumed = await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${nodeRunId}/execute`, { method: "POST" });
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toMatchObject({
        invocation: { operation_id: first.invocation.operation_id, provider_profile_id: "kimi-recovery-profile" },
        adapter_result: { status: "succeeded", provider_receipt: { provider_profile_id: "kimi-recovery-profile" } }
      });
    } finally {
      await rm(replacementPath, { force: true });
    }
  });

  it("migrates a legacy routing Decision before reusing the same routing result", async () => {
    const operationId = "op_cross_kind_legacy_decision";
    const { runId, nodeRunId } = await prepareCrossKindRetry(operationId);
    expect((await fetch(`${baseUrl}/api/v0/runs/${runId}/nodes/${nodeRunId}/execute`, { method: "POST" })).status).toBe(409);
    const firstHistory = await (await fetch(`${baseUrl}/api/v0/runs/${runId}/routing-decisions`)).json() as {
      routing_decisions: Array<Record<string, unknown>>;
    };
    const legacy = { ...firstHistory.routing_decisions[0] };
    delete legacy.decision_id;
    delete legacy.revision;
    await writeFile(path.join(workspace, `runs/${runId}/routing_decisions.json`), `${JSON.stringify([legacy], null, 2)}\n`, "utf8");

    expect((await fetch(`${baseUrl}/api/v0/runs/${runId}/nodes/${nodeRunId}/execute`, { method: "POST" })).status).toBe(409);
    const migrated = await (await fetch(`${baseUrl}/api/v0/runs/${runId}/routing-decisions`)).json() as {
      routing_decisions: Array<{ decision_id?: string; revision?: number }>;
    };
    expect(migrated.routing_decisions).toHaveLength(1);
    expect(migrated.routing_decisions[0]).toMatchObject({ revision: 1 });
    expect(migrated.routing_decisions[0]?.decision_id).toMatch(/^route_[a-f0-9]{24}$/);
  });

  it("excludes the exact failed Profile when one Provider has multiple Profiles", async () => {
    const sourcePath = path.join(workspace, "providers/kimi.json");
    const failedPath = path.join(workspace, "providers/zz-kimi-failed.json");
    const deepseekPath = path.join(workspace, "providers/deepseek.json");
    const originalDeepseek = await readFile(deepseekPath, "utf8");
    const failedProfile = JSON.parse(await readFile(sourcePath, "utf8")) as {
      id: string;
      display_name: string;
      profile: { id: string; model: string };
      routing: { user_priority: number; cost_tier: number };
    };
    failedProfile.id = "kimi-z-failed";
    failedProfile.display_name = "kimi failed profile";
    failedProfile.profile.id = "kimi-z-failed-profile";
    failedProfile.profile.model = "kimi-failed-fixture";
    failedProfile.routing = { user_priority: 0, cost_tier: 0 };
    const deepseek = JSON.parse(originalDeepseek) as { routing: { user_priority: number; cost_tier: number } };
    deepseek.routing = { user_priority: 100, cost_tier: 100 };
    await writeFile(failedPath, `${JSON.stringify(failedProfile, null, 2)}\n`, "utf8");
    await writeFile(deepseekPath, `${JSON.stringify(deepseek, null, 2)}\n`, "utf8");
    try {
      const runResponse = await fetch(`${baseUrl}/api/v0/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow_id: fallbackWorkflow.id, execution_policy: "auto" })
      });
      const run = await runResponse.json() as { run_id: string; initial_node_runs: string[] };
      const nodeRunId = run.initial_node_runs[0]!;
      const firstResponse = await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${nodeRunId}/execute`, { method: "POST" });
      const first = await firstResponse.json() as { invocation: { operation_id: string } };
      const attemptsPath = path.join(workspace, `runs/${run.run_id}/attempts.json`);
      const attempts = JSON.parse(await readFile(attemptsPath, "utf8")) as NodeAttempt[];
      attempts[0] = {
        ...attempts[0]!,
        provider_receipt: {
          ...attempts[0]!.provider_receipt!,
          provider: "kimi",
          provider_profile_id: "kimi-z-failed-profile",
          model: "kimi-failed-fixture"
        }
      };
      await writeFile(attemptsPath, `${JSON.stringify(attempts, null, 2)}\n`, "utf8");

      const fallback = await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${nodeRunId}/execute`, { method: "POST" });
      expect(fallback.status).toBe(200);
      expect(await fallback.json()).toMatchObject({
        invocation: { operation_id: first.invocation.operation_id, provider_profile_id: "kimi-default" },
        adapter_result: { status: "succeeded", provider_receipt: { provider_profile_id: "kimi-default" } }
      });
      const routing = await (await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/routing-decisions`)).json() as {
        routing_decisions: Array<{ rejected_candidates: Array<{ profile_id: string; reason_code: string }> }>;
      };
      expect(routing.routing_decisions.at(-1)?.rejected_candidates).toContainEqual({
        profile_id: "kimi-z-failed-profile",
        reason_code: "failed_profile_excluded"
      });

      const legacyRunResponse = await fetch(`${baseUrl}/api/v0/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow_id: fallbackWorkflow.id, execution_policy: "auto" })
      });
      const legacyRun = await legacyRunResponse.json() as { run_id: string; initial_node_runs: string[] };
      const legacyNodeRunId = legacyRun.initial_node_runs[0]!;
      const legacyFirst = await (await fetch(`${baseUrl}/api/v0/runs/${legacyRun.run_id}/nodes/${legacyNodeRunId}/execute`, { method: "POST" })).json() as {
        invocation: { operation_id: string };
      };
      const legacyAttemptsPath = path.join(workspace, `runs/${legacyRun.run_id}/attempts.json`);
      const legacyAttempts = JSON.parse(await readFile(legacyAttemptsPath, "utf8")) as NodeAttempt[];
      legacyAttempts[0] = {
        ...legacyAttempts[0]!,
        provider_receipt: {
          ...legacyAttempts[0]!.provider_receipt!,
          provider: "kimi",
          model: "legacy-profile-unknown"
        }
      };
      delete legacyAttempts[0]!.provider_receipt!.provider_profile_id;
      await writeFile(legacyAttemptsPath, `${JSON.stringify(legacyAttempts, null, 2)}\n`, "utf8");

      const legacyFallback = await fetch(`${baseUrl}/api/v0/runs/${legacyRun.run_id}/nodes/${legacyNodeRunId}/execute`, { method: "POST" });
      expect(legacyFallback.status).toBe(200);
      expect(await legacyFallback.json()).toMatchObject({
        invocation: { operation_id: legacyFirst.invocation.operation_id, provider: "deepseek", provider_profile_id: "deepseek-default" }
      });
      const legacyRouting = await (await fetch(`${baseUrl}/api/v0/runs/${legacyRun.run_id}/routing-decisions`)).json() as {
        routing_decisions: Array<{ rejected_candidates: Array<{ profile_id: string; reason_code: string }> }>;
      };
      expect(legacyRouting.routing_decisions.at(-1)?.rejected_candidates).toEqual(expect.arrayContaining([
        { profile_id: "kimi-default", reason_code: "failed_provider_profile_unknown" },
        { profile_id: "kimi-z-failed-profile", reason_code: "failed_provider_profile_unknown" }
      ]));
    } finally {
      await rm(failedPath, { force: true });
      await writeFile(deepseekPath, originalDeepseek, "utf8");
    }
  });

  it("rejects healthy Provider profiles when the Model API Adapter is not executable", async () => {
    const runResponse = await fetch(`${baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_id: fallbackWorkflow.id, execution_policy: "auto" })
    });
    const run = await runResponse.json() as { run_id: string; initial_node_runs: string[] };
    expect(runResponse.status).toBe(201);
    const firstResponse = await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${run.initial_node_runs[0]}/execute`, { method: "POST" });
    expect(firstResponse.status).toBe(200);

    const manifestPath = path.join(workspace, "adapters/model-api.json");
    const originalManifest = await readFile(manifestPath, "utf8");
    const blockedManifest = JSON.parse(originalManifest) as { status: string };
    blockedManifest.status = "blocked";
    await writeFile(manifestPath, `${JSON.stringify(blockedManifest, null, 2)}\n`, "utf8");
    try {
      const secondResponse = await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${run.initial_node_runs[0]}/execute`, { method: "POST" });
      expect(secondResponse.status).toBe(200);
      const routing = await (await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/routing-decisions`)).json() as {
        routing_decisions: Array<{
          selected_provider_profile_id?: string;
          rejected_candidates: Array<{ profile_id: string; reason_code: string }>;
        }>;
      };
      expect(routing.routing_decisions.at(-1)?.selected_provider_profile_id).toBeUndefined();
      expect(routing.routing_decisions.at(-1)?.rejected_candidates).toEqual(expect.arrayContaining([
        { profile_id: "kimi-default", reason_code: "adapter_not_executable" }
      ]));
    } finally {
      await writeFile(manifestPath, originalManifest, "utf8");
    }
  });

  it("projects a Run-owned routing history and rejects stale confirmation without a current decision", async () => {
    const runResponse = await fetch(`${baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "auto" })
    });
    const run = await runResponse.json() as { run_id: string; initial_node_runs: string[] };
    expect(runResponse.status).toBe(201);

    const decisions = await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/routing-decisions`);
    expect(decisions.status).toBe(200);
    expect(await decisions.json()).toMatchObject({ routing_decisions: [] });

    const confirmation = await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${run.initial_node_runs[0]}/fallback-confirmation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision_id: "route_stale",
        operation_id: "op_stale",
        expected_current_adapter_kind: "codex",
        target_provider_profile_id: "deepseek-default",
        actor: "test-operator"
      })
    });
    expect(confirmation.status).toBe(409);
    expect(await confirmation.json()).toMatchObject({ error: { code: "routing_decision_not_current" } });
  });

  it("accepts only a confirmation matching the current operation, adapter kind and target profile", async () => {
    const runResponse = await fetch(`${baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_id: "content-production-v0", execution_policy: "auto" })
    });
    const run = await runResponse.json() as { run_id: string; initial_node_runs: string[] };
    const operationId = "op_confirmation_current";
    const decisionId = "route_confirmation_current";
    await writeFile(path.join(workspace, `runs/${run.run_id}/attempts.json`), `${JSON.stringify([{
      attempt_id: `attempt_${operationId}`,
      node_run_id: run.initial_node_runs[0],
      operation_id: operationId,
      attempt_number: 1,
      attempt_kind: "execute",
      status: "failed",
      provider_receipt: { provider: "codex-local", adapter_kind: "codex", adapter_id: "codex-cli-real", operation_id: operationId },
      error: { code: "adapter_process_error", message: "fixture", recoverable: true },
      created_at: "2026-08-01T00:00:00.000Z"
    }], null, 2)}\n`, "utf8");
    await writeFile(path.join(workspace, `runs/${run.run_id}/routing_decisions.json`), `${JSON.stringify([{
      decision_id: decisionId,
      revision: 1,
      operation_id: operationId,
      node_run_id: run.initial_node_runs[0],
      current_adapter_kind: "codex",
      target_attempt_number: 2,
      selected_adapter_kind: "model-api",
      selected_provider_profile_id: "kimi-default",
      candidate_profile_ids: ["kimi-default"],
      rejected_candidates: [],
      reason_codes: ["cross_kind_fallback_requires_confirmation"],
      requires_confirmation: true,
      decided_at: "2026-08-01T00:00:01.000Z"
    }], null, 2)}\n`, "utf8");
    await writeFile(path.join(workspace, `runs/${run.run_id}/retry_schedule.json`), `${JSON.stringify([{
      operation_id: operationId,
      node_run_id: run.initial_node_runs[0],
      attempt_number: 2,
      reason_code: "retryable_error",
      scheduled_for: "2026-08-01T00:00:00.000Z",
      budget_snapshot: { attempts_used: 1, elapsed_ms: 1_000, cost_used: 0, max_attempts: 2, total_time_budget_ms: 30_000, cost_budget: 5 }
    }], null, 2)}\n`, "utf8");

    const confirm = async (expectedKind: string, target: string) => fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${run.initial_node_runs[0]}/fallback-confirmation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision_id: decisionId, operation_id: operationId, expected_current_adapter_kind: expectedKind, target_provider_profile_id: target, actor: "test-operator" })
    });
    expect((await confirm("model-api", "kimi-default")).status).toBe(409);
    expect((await confirm("codex", "deepseek-default")).status).toBe(409);
    const accepted = await confirm("codex", "kimi-default");
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ confirmation: { operation_id: operationId, actor: "test-operator", status: "confirmed" } });
    const repeated = await confirm("codex", "kimi-default");
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ reused: true, confirmation: { operation_id: operationId } });
    await writeFile(path.join(workspace, `runs/${run.run_id}/retry_schedule.json`), "[]\n", "utf8");
    const staleAfterScheduleRemoval = await confirm("codex", "kimi-default");
    expect(staleAfterScheduleRemoval.status).toBe(409);
    expect(await staleAfterScheduleRemoval.json()).toMatchObject({ error: { code: "routing_decision_not_current" } });
  });

  it("executes a confirmed Codex-to-model-api fallback with the selected Provider", async () => {
    const runResponse = await fetch(`${baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_id: crossKindWorkflow.id, execution_policy: "auto" })
    });
    const run = await runResponse.json() as { run_id: string; initial_node_runs: string[] };
    expect(runResponse.status).toBe(201);
    const nodeRunId = run.initial_node_runs[0]!;
    const operationId = "op_cross_kind_current";
    const attemptedAt = new Date(Date.now() - 1_000).toISOString();
    const runDir = path.join(workspace, `runs/${run.run_id}`);
    const runSpec = JSON.parse(await readFile(path.join(runDir, "run_spec.json"), "utf8")) as { resolved_components: string[] };
    runSpec.resolved_components = [...new Set([...runSpec.resolved_components, "codex-cli-real"])];
    await writeFile(path.join(runDir, "run_spec.json"), `${JSON.stringify(runSpec, null, 2)}\n`, "utf8");
    await writeFile(path.join(runDir, "attempts.json"), `${JSON.stringify([{
      attempt_id: `attempt_${operationId}`,
      node_run_id: nodeRunId,
      operation_id: operationId,
      attempt_number: 1,
      attempt_kind: "execute",
      status: "failed",
      provider_receipt: { provider: "codex-local", adapter_kind: "codex", adapter_id: "codex-cli-real", operation_id: operationId },
      error: { code: "adapter_process_error", message: "fixture", recoverable: true },
      created_at: attemptedAt,
      dispatched_at: attemptedAt,
      received_at: attemptedAt
    }], null, 2)}\n`, "utf8");
    await writeFile(path.join(runDir, "retry_schedule.json"), `${JSON.stringify([{
      operation_id: operationId,
      node_run_id: nodeRunId,
      attempt_number: 2,
      reason_code: "retryable_error",
      scheduled_for: attemptedAt,
      budget_snapshot: {
        attempts_used: 1,
        elapsed_ms: 1_000,
        cost_used: 0,
        max_attempts: 2,
        total_time_budget_ms: 30_000,
        cost_budget: 5
      }
    }], null, 2)}\n`, "utf8");

    const blocked = await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${nodeRunId}/execute`, { method: "POST" });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "fallback_confirmation_required" } });
    const routing = await (await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/routing-decisions`)).json() as {
      routing_decisions: Array<{ decision_id: string; revision: number }>;
    };
    const decision = routing.routing_decisions.at(-1)!;
    expect(decision).toMatchObject({ revision: 1 });

    const confirmed = await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${nodeRunId}/fallback-confirmation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision_id: decision.decision_id,
        operation_id: operationId,
        expected_current_adapter_kind: "codex",
        target_provider_profile_id: "kimi-default",
        actor: "test-operator"
      })
    });
    expect(confirmed.status).toBe(201);

    const executed = await fetch(`${baseUrl}/api/v0/runs/${run.run_id}/nodes/${nodeRunId}/execute`, { method: "POST" });
    expect(executed.status).toBe(200);
    expect(await executed.json()).toMatchObject({
      invocation: { operation_id: operationId, attempt_number: 2, adapter_kind: "model-api", provider: "kimi", provider_profile_id: "kimi-default" },
      adapter_result: { status: "succeeded", provider_receipt: { adapter_kind: "model-api", provider: "kimi", provider_profile_id: "kimi-default" } }
    });
  });

  it("keeps routing Decisions append-only and rejects confirmation for an older revision", async () => {
    const operationId = "op_cross_kind_revision";
    const { runId, nodeRunId } = await prepareCrossKindRetry(operationId);
    const firstBlocked = await fetch(`${baseUrl}/api/v0/runs/${runId}/nodes/${nodeRunId}/execute`, { method: "POST" });
    expect(firstBlocked.status).toBe(409);
    const firstHistory = await (await fetch(`${baseUrl}/api/v0/runs/${runId}/routing-decisions`)).json() as {
      routing_decisions: Array<{ decision_id: string; revision: number; selected_provider_profile_id?: string }>;
    };
    expect(firstHistory.routing_decisions).toHaveLength(1);
    expect(firstHistory.routing_decisions[0]).toMatchObject({ revision: 1, selected_provider_profile_id: "kimi-default" });

    const sourcePath = path.join(workspace, "providers/kimi.json");
    const alternatePath = path.join(workspace, "providers/kimi-revision.json");
    const alternate = JSON.parse(await readFile(sourcePath, "utf8")) as {
      id: string;
      display_name: string;
      profile: { id: string; model: string };
      routing: { user_priority: number; cost_tier: number };
    };
    alternate.id = "kimi-revision";
    alternate.display_name = "kimi revision";
    alternate.profile.id = "kimi-revision-profile";
    alternate.profile.model = "kimi-revision-fixture";
    alternate.routing = { user_priority: 0, cost_tier: 0 };
    await writeFile(alternatePath, `${JSON.stringify(alternate, null, 2)}\n`, "utf8");
    try {
      const revisedBlocked = await fetch(`${baseUrl}/api/v0/runs/${runId}/nodes/${nodeRunId}/execute`, { method: "POST" });
      expect(revisedBlocked.status).toBe(409);
      const revisedHistory = await (await fetch(`${baseUrl}/api/v0/runs/${runId}/routing-decisions`)).json() as {
        routing_decisions: Array<{ decision_id: string; revision: number; selected_provider_profile_id?: string }>;
      };
      expect(revisedHistory.routing_decisions).toEqual([
        expect.objectContaining({ decision_id: firstHistory.routing_decisions[0]!.decision_id, revision: 1, selected_provider_profile_id: "kimi-default" }),
        expect.objectContaining({ revision: 2, selected_provider_profile_id: "kimi-revision-profile" })
      ]);

      const stale = await fetch(`${baseUrl}/api/v0/runs/${runId}/nodes/${nodeRunId}/fallback-confirmation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision_id: firstHistory.routing_decisions[0]!.decision_id,
          operation_id: operationId,
          expected_current_adapter_kind: "codex",
          target_provider_profile_id: "kimi-default",
          actor: "test-operator"
        })
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: { code: "routing_decision_not_current" } });
    } finally {
      await rm(alternatePath, { force: true });
    }
  });
});
