import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
let providerOutput = "";
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
    const timer = setTimeout(() => reject(new Error(`Provider fixture did not start: ${providerOutput}`)), 5_000);
    provider?.stdout.on("data", (chunk) => {
      providerOutput += chunk.toString();
      const match = providerOutput.match(/provider-fixture:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]!);
    });
    provider?.stderr.on("data", (chunk) => { providerOutput += chunk.toString(); });
  });
}

async function writeModelProfile(mode: string) {
  const manifestPath = path.join(workspace, "adapters", "model-api.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const profiles = manifest.provider_profiles as Array<Record<string, unknown>>;
  manifest.supported_providers = ["fixture-compatible"];
  manifest.default_provider = "fixture-compatible";
  manifest.required_credentials = [{ key: "MODEL_API_FIXTURE_CREDENTIAL", label: "Model API fixture credential", source: "env", required: true }];
  profiles[0]!.provider = "fixture-compatible";
  profiles[0]!.base_url = providerBaseUrl;
  profiles[0]!.api_path = `/v1/chat/completions?mode=${mode}`;
  profiles[0]!.credential_ref = "MODEL_API_FIXTURE_CREDENTIAL";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function writeProviderScopeMismatchModelProfile() {
  const manifestPath = path.join(workspace, "adapters", "model-api.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const profiles = manifest.provider_profiles as Array<Record<string, unknown>>;
  manifest.supported_providers = ["provider-b"];
  manifest.default_provider = "provider-b";
  manifest.required_credentials = [{ key: "MODEL_API_FIXTURE_CREDENTIAL", label: "Model API fixture credential", source: "env", required: true, providers: ["provider-a"] }];
  profiles[0]!.base_url = providerBaseUrl;
  profiles[0]!.api_path = "/v1/chat/completions?mode=record-authorization";
  profiles[0]!.provider = "provider-b";
  profiles[0]!.credential_ref = "MODEL_API_FIXTURE_CREDENTIAL";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function writeProviderCatalog(entry: Record<string, unknown>) {
  const directory = path.join(workspace, "providers");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "fixture-compatible.json"), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}

async function createModelRun(provider = "fixture-compatible") {
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
    provider_policy: { default_provider: provider, allowed_providers: [provider], required_credentials: ["MODEL_API_FIXTURE_CREDENTIAL"], fallback_providers: [] },
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
    const body = await (await fetch(`${baseUrl}/api/v0/operations?run_id=${encodeURIComponent(runId)}`)).json() as { operations: Array<{ operation_id: string; attempt_id?: string }> };
    if (body.operations[0]) return body.operations[0];
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

  it("refuses a declared credential outside its provider scope without sending it", async () => {
    await writeProviderScopeMismatchModelProfile();
    const { runId, nodeRunId } = await createModelRun("provider-b");
    const response = await fetch(`${baseUrl}/api/v0/runs/${runId}/nodes/${nodeRunId}/execute`, { method: "POST" });
    const body = await response.json();
    const persisted = await readFile(path.join(workspace, "runs", runId, "attempts.json"), "utf8");
    const events = await readFile(path.join(workspace, "runs", runId, "events.jsonl"), "utf8");

    expect(JSON.stringify([body, persisted, events, sidecarOutput, providerOutput])).not.toContain("fixture-secret");
    expect(providerOutput).not.toContain("provider-authorization:");
    expect(body).toMatchObject({ error: { code: "credential_not_authorized" } });
  });

  it("cancels a registered Model API operation through the existing operation endpoint", async () => {
    await writeModelProfile("slow");
    const { runId, nodeRunId } = await createModelRun();
    const execution = fetch(`${baseUrl}/api/v0/runs/${runId}/nodes/${nodeRunId}/execute`, { method: "POST" });
    const operation = await waitForOperation(runId);
    const cancellation = await fetch(`${baseUrl}/api/v0/operations/${operation.operation_id}/cancel`, { method: "POST" });
    const cancelBody = await cancellation.json();
    const executionResponse = await execution;
    const executionBody = await executionResponse.json();

    expect(operation).toMatchObject({ attempt_id: expect.any(String) });
    expect(cancelBody).toMatchObject({ operation_id: operation.operation_id, status: "cancelled" });
    expect(executionResponse.status).toBe(200);
    expect(executionBody).toMatchObject({ adapter_result: { status: "cancelled", error: { code: "operation_cancelled" } } });

    const repeatedCancellation = await fetch(`${baseUrl}/api/v0/operations/${operation.operation_id}/cancel`, { method: "POST" });
    expect(await repeatedCancellation.json()).toMatchObject({ operation_id: operation.operation_id, status: "already_finished" });
  });

  it("returns already_finished from a durable receipt after Sidecar restart", async () => {
    await writeModelProfile("success");
    const { runId, nodeRunId } = await createModelRun();
    const execution = await fetch(`${baseUrl}/api/v0/runs/${runId}/nodes/${nodeRunId}/execute`, { method: "POST" });
    const body = await execution.json() as { invocation: { operation_id: string } };

    const receipt = await readFile(path.join(workspace, "model-api-operations", `${body.invocation.operation_id}.json`), "utf8");
    expect(receipt).not.toContain("fixture-secret");

    sidecar?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 200));
    sidecar = spawn("npm", ["run", "dev", "-w", "apps/sidecar"], {
      cwd: repoRoot,
      env: { ...process.env, MIRACLE_WORKSPACE_DIR: workspace, MIRACLE_SIDECAR_PORT: baseUrl.split(":").at(-1)!, MODEL_API_FIXTURE_CREDENTIAL: "fixture-secret" }
    });
    sidecar.stdout.on("data", (chunk) => { sidecarOutput += chunk.toString(); });
    sidecar.stderr.on("data", (chunk) => { sidecarOutput += chunk.toString(); });
    await waitFor(`${baseUrl}/api/v0/health`);

    const cancellation = await fetch(`${baseUrl}/api/v0/operations/${body.invocation.operation_id}/cancel`, { method: "POST" });
    expect(await cancellation.json()).toMatchObject({ operation_id: body.invocation.operation_id, status: "already_finished" });
  });

  it("treats a completed Model API operation as terminal before its delayed receipt write", async () => {
    sidecar?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 200));
    sidecar = spawn("npm", ["run", "dev", "-w", "apps/sidecar"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MIRACLE_WORKSPACE_DIR: workspace,
        MIRACLE_SIDECAR_PORT: baseUrl.split(":").at(-1)!,
        MODEL_API_FIXTURE_CREDENTIAL: "fixture-secret",
        MIRACLE_MODEL_API_RECEIPT_WRITE_DELAY_MS: "800"
      }
    });
    sidecar.stdout.on("data", (chunk) => { sidecarOutput += chunk.toString(); });
    sidecar.stderr.on("data", (chunk) => { sidecarOutput += chunk.toString(); });
    await waitFor(`${baseUrl}/api/v0/health`);

    await writeModelProfile("slow");
    const { runId, nodeRunId } = await createModelRun();
    let executionSettled = false;
    const execution = fetch(`${baseUrl}/api/v0/runs/${runId}/nodes/${nodeRunId}/execute`, { method: "POST" }).finally(() => { executionSettled = true; });
    const operation = await waitForOperation(runId);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const operations = await (await fetch(`${baseUrl}/api/v0/operations?run_id=${encodeURIComponent(runId)}`)).json() as { operations: unknown[] };
      if (operations.operations.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(executionSettled).toBe(false);
    const cancellation = await fetch(`${baseUrl}/api/v0/operations/${operation.operation_id}/cancel`, { method: "POST" });
    expect(await cancellation.json()).toMatchObject({ operation_id: operation.operation_id, status: "already_finished" });
    expect((await execution).status).toBe(200);
  });

  it("does not write through a receipt root replaced during the delayed write window", async () => {
    await writeModelProfile("slow");
    const { runId, nodeRunId } = await createModelRun();
    let executionSettled = false;
    const execution = fetch(`${baseUrl}/api/v0/runs/${runId}/nodes/${nodeRunId}/execute`, { method: "POST" }).finally(() => { executionSettled = true; });
    await waitForOperation(runId);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const operations = await (await fetch(`${baseUrl}/api/v0/operations?run_id=${encodeURIComponent(runId)}`)).json() as { operations: unknown[] };
      if (operations.operations.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(executionSettled).toBe(false);

    const receiptRoot = path.join(workspace, "model-api-operations");
    const outside = path.join(tempRoot, "outside-switched-receipts");
    await mkdir(outside);
    await rm(receiptRoot, { recursive: true, force: true });
    await symlink(outside, receiptRoot, "dir");

    const response = await execution;
    expect(response.status).toBe(500);
    expect(await readdir(outside)).toEqual([]);
  });

  it("never writes a Model API receipt through a pre-existing root symlink", async () => {
    await writeModelProfile("record-authorization");
    const receiptRoot = path.join(workspace, "model-api-operations");
    const outside = path.join(tempRoot, "outside-receipts");
    await mkdir(outside);
    await rm(receiptRoot, { recursive: true, force: true });
    await symlink(outside, receiptRoot, "dir");
    const outputBefore = providerOutput;
    const { runId, nodeRunId } = await createModelRun();
    const response = await fetch(`${baseUrl}/api/v0/runs/${runId}/nodes/${nodeRunId}/execute`, { method: "POST" });
    const body = await response.json();

    expect(body).toMatchObject({ adapter_result: { error: { code: "operation_receipt_unavailable" } } });
    expect(providerOutput).toBe(outputBefore);
    expect(await readdir(outside)).toEqual([]);
  });

  it("projects provider verification, credential, and driver registration through the provider endpoint", async () => {
    await writeProviderCatalog({
      id: "fixture-compatible",
      display_name: "Fixture Compatible",
      driver_id: "not-registered",
      profile: {
        id: "fixture-compatible-default",
        provider: "fixture-compatible",
        model: "fixture-chat",
        base_url: providerBaseUrl,
        credential_ref: "MODEL_API_FIXTURE_CREDENTIAL",
        verification_status: "configured_unverified"
      },
      credential: { key: "MODEL_API_FIXTURE_CREDENTIAL", source: "env" },
      documentation: { official_url: "https://example.invalid/provider-docs", verified_at: "2026-07-31T00:00:00.000Z" },
      capabilities: ["model.call"],
      cancellation: "http_abort"
    });

    const response = await fetch(`${baseUrl}/api/v0/providers`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      providers: [expect.objectContaining({
        id: "fixture-compatible",
        profile: expect.objectContaining({ provider: "fixture-compatible" }),
        driver_registered: false,
        credential: expect.objectContaining({ configured: true }),
        verification_status: "configured_unverified",
        health_status: "driver_unregistered"
      })]
    });
    expect(JSON.stringify(body)).not.toContain("fixture-secret");
  });

  it("rejects an unregistered catalog Driver before sending a network request", async () => {
    await writeModelProfile("record-authorization");
    const before = providerOutput;
    const { runId, nodeRunId } = await createModelRun();

    const response = await fetch(`${baseUrl}/api/v0/runs/${runId}/nodes/${nodeRunId}/execute`, { method: "POST" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ adapter_result: { error: { code: "provider_driver_unregistered", recoverable: false } } });
    expect(providerOutput).toBe(before);
    expect(JSON.stringify(body)).not.toContain("fixture-secret");
  });

  it("rejects a suspicious env credential reference without returning it from the Provider endpoint", async () => {
    await writeProviderCatalog({
      id: "fixture-compatible",
      display_name: "Fixture Compatible",
      driver_id: "openai-compatible",
      profile: {
        id: "fixture-compatible-default",
        provider: "fixture-compatible",
        model: "fixture-chat",
        base_url: providerBaseUrl,
        credential_ref: "sk-live-actual-secret",
        verification_status: "configured_unverified"
      },
      credential: { key: "sk-live-actual-secret", source: "env" },
      documentation: { official_url: "https://example.invalid/provider-docs", verified_at: "2026-07-31T00:00:00.000Z" },
      capabilities: ["model.call"],
      cancellation: "http_abort"
    });

    const response = await fetch(`${baseUrl}/api/v0/providers`);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("sk-live-actual-secret");
  });
});
