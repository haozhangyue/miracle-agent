import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { providerCatalogEntrySchema, type AdapterInvocation, type ProviderDriver, type ProviderProfile } from "@miracle/core";
import { ModelApiAdapter } from "../src/model-api-adapter";
import { deepseekDriver } from "../src/provider-drivers/deepseek";
import { kimiDriver } from "../src/provider-drivers/kimi";
import { minimaxDriver } from "../src/provider-drivers/minimax";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const secret = "test-secret";
let server: Server;
let baseUrl = "";
const received: Array<{ url: URL; headers: Record<string, string | string[] | undefined>; body: unknown }> = [];

const providerCases = [
  ["deepseek", deepseekDriver, "/chat/completions", "DEEPSEEK_API_KEY"],
  ["kimi", kimiDriver, "/v1/chat/completions", "MOONSHOT_API_KEY"],
  ["minimax", minimaxDriver, "/v1/chat/completions", "MINIMAX_API_KEY"]
] as const;

const invocation = (provider: string): AdapterInvocation => ({
  operation_id: "op_provider_driver",
  attempt_id: "attempt_provider_driver",
  run_id: "run_provider_driver",
  node_run_id: "node_run_provider_driver",
  node_id: "node_provider_driver",
  adapter_kind: "model-api",
  adapter_id: "model-api-compatible-adapter",
  provider,
  capability_requirements: ["model.call"],
  input_artifacts: [],
  resolved_inputs: [],
  expected_outputs: [],
  runtime_control: {
    timeout_ms: 80,
    cancellation_token_id: "cancel_provider_driver",
    attempt_workspace: "runtime/provider-driver",
    sandbox: "workspace-write"
  },
  prompt_path: "input/prompt.txt",
  output_schema_path: "meta/output.schema.json",
  dispatched_at: "2026-07-31T00:00:00.000Z"
});

function profile(provider: string, apiPath: string, credentialRef: string, mode = "success"): ProviderProfile {
  return {
    id: `${provider}-contract`,
    provider,
    model: `fixture-${provider}-model`,
    base_url: baseUrl,
    api_path: `${apiPath}?mode=${mode}`,
    credential_ref: credentialRef,
    verification_status: "configured_unverified"
  };
}

function writeJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function successBody(provider: string, withUsage = true) {
  return {
    id: "provider-receipt-001",
    choices: [{ message: { content: "provider completion" } }],
    ...(withUsage ? { usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8, cached_tokens: 2, total_characters: 99 } } : {}),
    ...(provider === "minimax" ? { base_resp: { status_code: 0, status_msg: "" } } : {})
  };
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push({ url, headers: request.headers, body });
    const mode = url.searchParams.get("mode") ?? "success";
    const provider = String(body.model).replace(/^fixture-/, "").replace(/-model$/, "");
    if (mode === "401") return writeJson(response, 401, { error: { message: secret } });
    if (mode === "429") return writeJson(response, 429, { error: { message: secret } });
    if (mode === "500") return writeJson(response, 500, { error: { message: secret } });
    if (mode === "slow") return void setTimeout(() => writeJson(response, 200, successBody(provider)), 250);
    if (mode === "invalid-json") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end("{not-json");
      return;
    }
    if (mode === "oversized") return writeJson(response, 200, { ...successBody(provider), choices: [{ message: { content: "x".repeat(2_000) } }] });
    if (mode.startsWith("base-resp-")) {
      return writeJson(response, 200, { ...successBody("minimax"), base_resp: { status_code: mode.slice("base-resp-".length) === "missing" ? undefined : Number(mode.slice("base-resp-".length)), status_msg: secret } });
    }
    return writeJson(response, 200, successBody(provider, mode !== "missing-usage"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback provider fixture did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

describe("provider driver request contracts", () => {
  it.each(providerCases)("builds a profile-driven, credential-safe %s request", (provider, driver, apiPath, credentialRef) => {
    const request = driver.buildRequest({ invocation: invocation(provider), profile: {
      ...profile(provider, apiPath, credentialRef),
      base_url: provider === "deepseek" ? "https://api.deepseek.com" : provider === "kimi" ? "https://api.moonshot.cn" : "https://api.minimaxi.com",
      api_path: apiPath
    }, credential: secret, prompt: "contract prompt" });
    const body = JSON.parse(String(request.init.body));

    expect(request.url).toBe(`${provider === "deepseek" ? "https://api.deepseek.com" : provider === "kimi" ? "https://api.moonshot.cn" : "https://api.minimaxi.com"}${apiPath}`);
    expect(request.init).toMatchObject({ method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` } });
    expect(body).toMatchObject({ model: `fixture-${provider}-model`, messages: [{ role: "user", content: "contract prompt" }] });
    expect(body).toEqual(provider === "deepseek"
      ? { model: `fixture-${provider}-model`, messages: [{ role: "user", content: "contract prompt" }], stream: false }
      : { model: `fixture-${provider}-model`, messages: [{ role: "user", content: "contract prompt" }] });
    expect(JSON.stringify(request)).toContain(secret);
    expect(JSON.stringify(profile(provider, apiPath, credentialRef))).not.toContain(secret);
  });

  it("requires DeepSeek's documented chat-completions path", () => {
    expect(() => deepseekDriver.buildRequest({ invocation: invocation("deepseek"), profile: profile("deepseek", "/v1/chat/completions", "DEEPSEEK_API_KEY"), credential: secret })).toThrow();
  });
});

describe("provider driver loopback contracts", () => {
  it.each(providerCases)("sends the %s contract only to the loopback fake server and normalizes success", async (provider, driver, apiPath, credentialRef) => {
    received.length = 0;
    const result = await new ModelApiAdapter({ driver, max_response_bytes: 10_000 }).execute({ invocation: invocation(provider), profile: profile(provider, apiPath, credentialRef), credential: secret, prompt: "fake-server prompt", signal: new AbortController().signal });

    expect(result).toMatchObject({ status: "succeeded", provider_receipt: { model: `fixture-${provider}-model`, raw_receipt_id: "provider-receipt-001", usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ url: expect.objectContaining({ hostname: "127.0.0.1", pathname: apiPath }), headers: expect.objectContaining({ authorization: `Bearer ${secret}` }), body: expect.objectContaining({ model: `fixture-${provider}-model` }) });
  });

  it.each(providerCases)("allows a %s success without usage", async (provider, driver, apiPath, credentialRef) => {
    const result = await new ModelApiAdapter({ driver }).execute({ invocation: invocation(provider), profile: profile(provider, apiPath, credentialRef, "missing-usage"), credential: secret, signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "succeeded" });
    expect(result.provider_receipt).not.toHaveProperty("usage");
  });

  it.each(providerCases.flatMap(([provider, driver, apiPath, credentialRef]) => ([
    [provider, driver, apiPath, credentialRef, "401", "authentication_failed", false],
    [provider, driver, apiPath, credentialRef, "429", "provider_rate_limited", true],
    [provider, driver, apiPath, credentialRef, "500", "provider_unavailable", true]
  ] as const)))("maps %s HTTP %s without exposing the response body", async (provider, driver, apiPath, credentialRef, mode, code, recoverable) => {
    const result = await new ModelApiAdapter({ driver }).execute({ invocation: invocation(provider), profile: profile(provider, apiPath, credentialRef, mode), credential: secret, signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "failed", error: { code, recoverable } });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each(providerCases)("maps %s timeout, cancellation, invalid JSON, and oversized response", async (provider, driver, apiPath, credentialRef) => {
    const adapter = new ModelApiAdapter({ driver, max_response_bytes: 256 });
    const timeout = await adapter.execute({ invocation: invocation(provider), profile: profile(provider, apiPath, credentialRef, "slow"), credential: secret, signal: new AbortController().signal });
    const cancellationController = new AbortController();
    cancellationController.abort();
    const cancelled = await adapter.execute({ invocation: invocation(provider), profile: profile(provider, apiPath, credentialRef, "slow"), credential: secret, signal: cancellationController.signal });
    const invalidJson = await adapter.execute({ invocation: invocation(provider), profile: profile(provider, apiPath, credentialRef, "invalid-json"), credential: secret, signal: new AbortController().signal });
    const oversized = await adapter.execute({ invocation: invocation(provider), profile: profile(provider, apiPath, credentialRef, "oversized"), credential: secret, signal: new AbortController().signal });
    expect([timeout, cancelled, invalidJson, oversized]).toMatchObject([
      { status: "timed_out", error: { code: "process_timeout" } },
      { status: "cancelled", error: { code: "operation_cancelled" } },
      { status: "failed", error: { code: "provider_response_invalid" } },
      { status: "failed", error: { code: "provider_response_too_large" } }
    ]);
  });

  it.each(["1004", "1002", "1039", "1026", "2013", "missing", "not-an-integer"])("rejects MiniMax HTTP 200 base_resp status_code %s", async (statusCode) => {
    const result = await new ModelApiAdapter({ driver: minimaxDriver }).execute({
      invocation: invocation("minimax"),
      profile: profile("minimax", "/v1/chat/completions", "MINIMAX_API_KEY", `base-resp-${statusCode}`),
      credential: secret,
      signal: new AbortController().signal
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "provider_response_invalid", recoverable: false } });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("provider catalog fixtures", () => {
  it.each([
    ["deepseek", "DeepSeek", "deepseek", "deepseek-v4-flash", "https://api.deepseek.com", "/chat/completions", "DEEPSEEK_API_KEY", "https://api-docs.deepseek.com/api/create-chat-completion"],
    ["kimi", "Kimi", "kimi", "kimi-k2.6", "https://api.moonshot.cn", "/v1/chat/completions", "MOONSHOT_API_KEY", "https://platform.kimi.com/docs/api/chat"],
    ["minimax", "MiniMax", "minimax", "MiniMax-M2.7", "https://api.minimaxi.com", "/v1/chat/completions", "MINIMAX_API_KEY", "https://platform.minimaxi.com/docs/api-reference/text-chat-openai"]
  ])("loads the %s catalog profile without a secret", async (file, displayName, driverId, model, baseUrl, apiPath, credentialRef, docsUrl) => {
    const filePath = path.join(repoRoot, "fixtures/mvp-workspace/.miracle/providers", `${file}.json`);
    expect(existsSync(filePath)).toBe(true);
    if (!existsSync(filePath)) return;
    const entry = providerCatalogEntrySchema.parse(JSON.parse(await readFile(filePath, "utf8")));
    expect(entry).toMatchObject({ display_name: displayName, driver_id: driverId, profile: { provider: file, model, base_url: baseUrl, api_path: apiPath, credential_ref: credentialRef, verification_status: "configured_unverified", verified_at: "2026-07-31T00:00:00.000Z", docs_url: docsUrl }, credential: { key: credentialRef, source: "env" }, documentation: { official_url: docsUrl, verified_at: "2026-07-31T00:00:00.000Z" } });
    expect(JSON.stringify(entry)).not.toContain(secret);
  });

  it("keeps manifest Profile projections and scoped credential requirements aligned with the catalog", async () => {
    const manifest = JSON.parse(await readFile(path.join(repoRoot, "fixtures/mvp-workspace/.miracle/adapters/model-api.json"), "utf8")) as {
      supported_providers: string[];
      required_credentials: Array<{ key: string; providers?: string[] }>;
      provider_profiles: ProviderProfile[];
    };

    for (const [provider, , , credentialRef] of providerCases) {
      const catalog = providerCatalogEntrySchema.parse(JSON.parse(await readFile(path.join(repoRoot, "fixtures/mvp-workspace/.miracle/providers", `${provider}.json`), "utf8")));
      expect(manifest.supported_providers).toContain(provider);
      expect(manifest.provider_profiles.find((profile) => profile.provider === provider)).toEqual(catalog.profile);
      expect(manifest.required_credentials.find((credential) => credential.key === credentialRef)).toEqual(expect.objectContaining({ providers: [provider] }));
    }
  });
});
