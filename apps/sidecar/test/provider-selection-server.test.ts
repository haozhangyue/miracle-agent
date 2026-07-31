import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowSpec } from "@miracle/core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureWorkspace = path.join(repoRoot, "fixtures/mvp-workspace/.miracle");
const providerCases = [
  ["deepseek", "DEEPSEEK_API_KEY", "/chat/completions"],
  ["kimi", "MOONSHOT_API_KEY", "/v1/chat/completions"],
  ["minimax", "MINIMAX_API_KEY", "/v1/chat/completions"]
] as const;

let fakeProvider: Server;
let fakeProviderBaseUrl = "";
const receivedRequests: Array<{ path: string; authorization?: string; model?: string; stream?: unknown }> = [];

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Port probe did not bind.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitFor(url: string, output: () => string) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Sidecar is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${url}: ${output()}`);
}

async function stopProcess(process: ChildProcessWithoutNullStreams | undefined) {
  if (!process || process.exitCode !== null) return;
  process.kill("SIGTERM");
  await new Promise<void>((resolve) => process.once("exit", () => resolve()));
}

async function executeProvider(
  provider: string,
  credentialKey: string,
  apiPath: string,
  configured: boolean,
  options: { catalog?: "present" | "missing"; catalogDriverId?: string } = {}
) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), `miracle-provider-${provider}-`));
  const workspace = path.join(tempRoot, ".miracle");
  await cp(fixtureWorkspace, workspace, { recursive: true });
  const catalogPath = path.join(workspace, "providers", `${provider}.json`);
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as { profile: Record<string, unknown> };
  catalog.profile.base_url = fakeProviderBaseUrl;
  catalog.profile.api_path = apiPath;
  catalog.profile.verification_status = "healthy";
  if (options.catalogDriverId) (catalog as { driver_id?: string }).driver_id = options.catalogDriverId;
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  if (options.catalog === "missing") {
    await rm(catalogPath);
    const manifestPath = path.join(workspace, "adapters", "model-api.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { provider_profiles: Array<Record<string, unknown>> };
    const profile = manifest.provider_profiles.find((candidate) => candidate.provider === provider);
    if (!profile) throw new Error(`Missing manifest profile for ${provider}`);
    profile.base_url = fakeProviderBaseUrl;
    profile.api_path = apiPath;
    profile.verification_status = "healthy";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  const workflow: WorkflowSpec = {
    id: `provider-selection-${provider}`,
    name: `${provider} provider selection`,
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
    provider_policy: {
      default_provider: provider,
      allowed_providers: [provider],
      required_credentials: [credentialKey],
      fallback_providers: []
    },
    layouts: { dag: { model_call: { x: 0, y: 0 } } },
    registry_meta: { source: "test", status: "experimental" }
  };
  await writeFile(path.join(workspace, "workflows", `${workflow.id}.json`), `${JSON.stringify(workflow, null, 2)}\n`, "utf8");

  const port = await unusedLoopbackPort();
  const sidecarBaseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  const env = {
    ...process.env,
    MIRACLE_WORKSPACE_DIR: workspace,
    MIRACLE_SIDECAR_PORT: String(port),
    MODEL_API_FIXTURE_CREDENTIAL: "",
    DEEPSEEK_API_KEY: "",
    MOONSHOT_API_KEY: "",
    MINIMAX_API_KEY: "",
    ...(configured ? { [credentialKey]: "provider-test-secret" } : {})
  };
  const sidecar = spawn("npm", ["run", "dev", "-w", "apps/sidecar"], { cwd: repoRoot, env });
  sidecar.stdout.on("data", (chunk) => { output += chunk.toString(); });
  sidecar.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const requestCountBefore = receivedRequests.length;
  try {
    await waitFor(`${sidecarBaseUrl}/api/v0/health`, () => output);
    const runResponse = await fetch(`${sidecarBaseUrl}/api/v0/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_id: workflow.id, execution_policy: "auto", role_profile: "operator" })
    });
    const run = await runResponse.json() as { run_id: string; initial_node_runs: string[] };
    if (!runResponse.ok) throw new Error(JSON.stringify(run));
    const executeResponse = await fetch(`${sidecarBaseUrl}/api/v0/runs/${run.run_id}/nodes/${run.initial_node_runs[0]!}/execute`, { method: "POST" });
    return {
      status: executeResponse.status,
      body: await executeResponse.json(),
      requestCount: receivedRequests.length - requestCountBefore,
      output
    };
  } finally {
    await stopProcess(sidecar);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  fakeProvider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string; stream?: unknown };
    receivedRequests.push({
      path: new URL(request.url ?? "/", "http://127.0.0.1").pathname,
      authorization: request.headers.authorization,
      model: body.model,
      stream: body.stream
    });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      id: "provider-selection-receipt",
      choices: [{ message: { content: "provider selection completion" } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      ...(body.model?.startsWith("MiniMax-") ? { base_resp: { status_code: 0, status_msg: "" } } : {})
    }));
  });
  await new Promise<void>((resolve) => fakeProvider.listen(0, "127.0.0.1", resolve));
  const address = fakeProvider.address();
  if (!address || typeof address === "string") throw new Error("Fake provider did not bind.");
  fakeProviderBaseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((resolve, reject) => fakeProvider.close((error) => error ? reject(error) : resolve())));

describe("provider-scoped Model API execution", () => {
  it.each(providerCases)("selects and executes %s with only its own credential", async (provider, credentialKey, apiPath) => {
    const result = await executeProvider(provider, credentialKey, apiPath, true);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      adapter_result: {
        status: "succeeded",
        provider_receipt: { provider, raw_receipt_id: "provider-selection-receipt" }
      }
    });
    expect(result.requestCount).toBe(1);
    expect(result.output).not.toContain("provider-test-secret");
  });

  it.each(providerCases)("returns credential_missing for %s without calling fetch", async (provider, credentialKey, apiPath) => {
    const result = await executeProvider(provider, credentialKey, apiPath, false);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      adapter_result: {
        status: "failed",
        error: { code: "credential_missing", recoverable: false }
      }
    });
    expect(result.requestCount).toBe(0);
  });

  it("uses the DeepSeek-specific Driver when the DeepSeek Catalog entry is missing", async () => {
    const result = await executeProvider("deepseek", "DEEPSEEK_API_KEY", "/chat/completions", true, { catalog: "missing" });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ adapter_result: { status: "succeeded" } });
    expect(result.requestCount).toBe(1);
    expect(receivedRequests.at(-1)).toMatchObject({ stream: false });
  });

  it("fails closed without calling fetch when a Catalog Driver is bound to another provider", async () => {
    const result = await executeProvider("deepseek", "DEEPSEEK_API_KEY", "/chat/completions", true, { catalogDriverId: "minimax" });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      adapter_result: { status: "failed", error: { code: "provider_driver_unregistered", recoverable: false } }
    });
    expect(result.requestCount).toBe(0);
  });
});
