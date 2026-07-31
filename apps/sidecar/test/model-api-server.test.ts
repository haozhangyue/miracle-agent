import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowSpec } from "@miracle/core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureWorkspace = path.join(repoRoot, "fixtures/mvp-workspace/.miracle");
const providerFixture = path.join(repoRoot, "apps/sidecar/test/fixtures/provider-server.mjs");
let tempRoot = "";
let workspace = "";
let baseUrl = "";
let providerBaseUrl = "";
let sidecarOutput = "";
let sidecar: ChildProcessWithoutNullStreams | undefined;
let provider: ChildProcessWithoutNullStreams | undefined;

async function waitFor(url: string) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${url}: ${sidecarOutput}`);
}

async function waitForFixturePort() {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Provider fixture did not start: ${output}`)), 5_000);
    provider?.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/provider-fixture:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]!);
    });
    provider?.stderr.on("data", (chunk) => { output += chunk.toString(); });
  });
}

async function writeModelProfile(mode: string) {
  const manifestPath = path.join(workspace, "adapters", "model-api.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const profiles = manifest.provider_profiles as Array<Record<string, unknown>>;
  profiles[0]!.base_url = providerBaseUrl;
  profiles[0]!.api_path = `/v1/chat/completions?mode=${mode}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function createModelRun() {
  const workflow: WorkflowSpec = {
    id: "model-api-cancel-v0",
    name: "Model API cancellation test",
    version: "0.1.0",
    domain: "test",
    category: "test",
    nodes: [{
      id: "model_call",
      name: "Model call",
      type: "agent",
      capability_requirements: ["model.call"],
      recommended_libraries: [],
      agent_candidates: [],
      inputs: [],
      outputs: [],
      failure_policy: { retry: 0, on_missing_input: "blocked", on_provider_failure: "failed" }
    }],
    edges: [],
    gates: [],
    artifacts: [],
    provider_policy: { default_provider: "fixture-compatible", allowed_providers: ["fixture-compatible"], required_credentials: ["MODEL_API_FIXTURE_CREDENTIAL"], fallback_providers: [] },
    layouts: { dag: { model_call: { x: 0, y: 0 } } },
    registry_meta: { source: "test", status: "experimental" }
  };
  await writeFile(path.join(workspace, "workflows", `${workflow.id}.json`), `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
  const response = await fetch(`${baseUrl}/api/v0/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflow_id: workflow.id, execution_policy: "auto", role_profile: "operator" })
  });
  const body = await response.json() as { run_id: string; initial_node_runs: string[] };
  if (!response.ok) throw new Error(JSON.stringify(body));
  return { runId: body.run_id, nodeRunId: body.initial_node_runs[0]! };
}

async function waitForOperation(runId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const body = await (await fetch(`${baseUrl}/api/v0/operations?run_id=${encodeURIComponent(runId)}`)).json() as { operations: Array<{ operation_id: string }> };
    if (body.operations[0]) return body.operations[0].operation_id;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Model API operation was not registered");
}

describe("Model API Sidecar integration", () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "miracle-model-api-"));
    workspace = path.join(tempRoot, ".miracle");
    await cp(fixtureWorkspace, workspace, { recursive: true });
    provider = spawn(process.execPath, [providerFixture]);
    providerBaseUrl = `http://127.0.0.1:${await waitForFixturePort()}`;
    const port = 5600 + Math.floor(Math.random() * 300);
    baseUrl = `http://127.0.0.1:${port}`;
    sidecar = spawn("npm", ["run", "dev", "-w", "apps/sidecar"], {
      cwd: repoRoot,
      env: { ...process.env, MIRACLE_WORKSPACE_DIR: workspace, MIRACLE_SIDECAR_PORT: String(port), MODEL_API_FIXTURE_CREDENTIAL: "fixture-secret" }
    });
    sidecar.stdout.on("data", (chunk) => { sidecarOutput += chunk.toString(); });
    sidecar.stderr.on("data", (chunk) => { sidecarOutput += chunk.toString(); });
    await waitFor(`${baseUrl}/api/v0/health`);
  });

  afterAll(async () => {
    sidecar?.kill("SIGTERM");
    provider?.kill("SIGTERM");
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it("does not persist or return a credential echoed by the provider", async () => {
    await writeModelProfile("credential-echo");
    const { runId, nodeRunId } = await createModelRun();
    const response = await fetch(`${baseUrl}/api/v0/runs/${runId}/nodes/${nodeRunId}/execute`, { method: "POST" });
    const body = await response.json();
    const persisted = await readFile(path.join(workspace, "runs", runId, "attempts.json"), "utf8");
    const events = await readFile(path.join(workspace, "runs", runId, "events.jsonl"), "utf8");

    expect(response.status).toBe(200);
    expect(JSON.stringify([body, persisted, events, sidecarOutput])).not.toContain("fixture-secret");
  });

  it("cancels a registered Model API operation through the existing operation endpoint", async () => {
    await writeModelProfile("slow");
    const { runId, nodeRunId } = await createModelRun();
    const execution = fetch(`${baseUrl}/api/v0/runs/${runId}/nodes/${nodeRunId}/execute`, { method: "POST" });
    const operationId = await waitForOperation(runId);
    const cancellation = await fetch(`${baseUrl}/api/v0/operations/${operationId}/cancel`, { method: "POST" });
    const cancelBody = await cancellation.json();
    const executionResponse = await execution;
    const executionBody = await executionResponse.json();

    expect(cancelBody).toMatchObject({ operation_id: operationId, status: "cancel_requested" });
    expect(executionResponse.status).toBe(200);
    expect(executionBody).toMatchObject({ adapter_result: { status: "cancelled", error: { code: "operation_cancelled" } } });
  });
});
