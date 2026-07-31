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
    choices: [{ message: { content: "provider completion", reasoning_content: "provider reasoning" } }],
    ...(withUsage ? {
      usage: {
        prompt_tokens: 3,
        completion_tokens: 5,
        total_tokens: 8,
        cached_tokens: 2,
        total_characters: 99,
        completion_tokens_details: { reasoning_tokens: 4 }
      }
    } : {}),
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
    if (mode.startsWith("status-")) return writeJson(response, Number(mode.slice("status-".length)), { error: { message: secret } });
    if (mode === "slow") return void setTimeout(() => writeJson(response, 200, successBody(provider)), 250);
    if (mode === "invalid-json") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end("{not-json");
      return;
    }
    if (mode === "oversized") return writeJson(response, 200, { ...successBody(provider), choices: [{ message: { content: "x".repeat(2_000) } }] });
    if (mode === "partial-usage") {
      return writeJson(response, 200, {
        ...successBody(provider),
        usage: { prompt_tokens: 3, completion_tokens: -1, total_tokens: 3, cached_tokens: 2, total_characters: 99 }
      });
    }
    if (mode === "invalid-usage") {
      return writeJson(response, 200, {
        ...successBody(provider),
        usage: { prompt_tokens: -1, completion_tokens: "5", total_tokens: 8.5, cached_tokens: 2, total_characters: 99 }
      });
    }
    if (mode === "missing-choices") return writeJson(response, 200, { ...successBody(provider), choices: undefined });
    if (mode === "missing-message") return writeJson(response, 200, { ...successBody(provider), choices: [{}] });
    if (mode === "non-string-content") return writeJson(response, 200, { ...successBody(provider), choices: [{ message: { content: 42 } }] });
    if (mode.startsWith("base-resp-")) {
      const value = mode.slice("base-resp-".length);
      const statusCode = value === "missing"
        ? undefined
        : value === "string"
          ? "0"
          : value === "float"
            ? 0.5
            : Number(value);
      return writeJson(response, 200, {
        ...successBody("minimax"),
        base_resp: {
          ...(statusCode !== undefined ? { status_code: statusCode } : {}),
          status_msg: secret
        }
      });
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

    expect(result).toMatchObject({ status: "succeeded", provider_receipt: { model: `fixture-${provider}-model`, raw_receipt_id: "provider-receipt-001" } });
    expect(result.provider_receipt.usage).toEqual({ input_tokens: 3, output_tokens: 5, total_tokens: 8 });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ url: expect.objectContaining({ hostname: "127.0.0.1", pathname: apiPath }), headers: expect.objectContaining({ authorization: `Bearer ${secret}` }), body: expect.objectContaining({ model: `fixture-${provider}-model` }) });
  });

  it.each(providerCases)("allows a %s success without usage", async (provider, driver, apiPath, credentialRef) => {
    const result = await new ModelApiAdapter({ driver }).execute({ invocation: invocation(provider), profile: profile(provider, apiPath, credentialRef, "missing-usage"), credential: secret, signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "succeeded" });
    expect(result.provider_receipt).not.toHaveProperty("usage");
  });

  it.each(providerCases)("keeps only valid canonical %s usage fields", async (provider, driver, apiPath, credentialRef) => {
    const adapter = new ModelApiAdapter({ driver });
    const partial = await adapter.execute({ invocation: invocation(provider), profile: profile(provider, apiPath, credentialRef, "partial-usage"), credential: secret, signal: new AbortController().signal });
    const invalid = await adapter.execute({ invocation: invocation(provider), profile: profile(provider, apiPath, credentialRef, "invalid-usage"), credential: secret, signal: new AbortController().signal });
    expect(partial.provider_receipt.usage).toEqual({ input_tokens: 3, total_tokens: 3 });
    expect(invalid.provider_receipt).not.toHaveProperty("usage");
  });

  it.each(providerCases.flatMap(([provider, driver, apiPath, credentialRef]) => [
    ["missing-choices", provider, driver, apiPath, credentialRef],
    ["missing-message", provider, driver, apiPath, credentialRef],
    ["non-string-content", provider, driver, apiPath, credentialRef]
  ] as const))("rejects %s content from %s", async (mode, provider, driver, apiPath, credentialRef) => {
    const result = await new ModelApiAdapter({ driver }).execute({
      invocation: invocation(provider),
      profile: profile(provider, apiPath, credentialRef, mode),
      credential: secret,
      signal: new AbortController().signal
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "provider_response_invalid", recoverable: false } });
  });

  it.each(providerCases.flatMap(([provider, driver, apiPath, credentialRef]) => [
    [provider, driver, apiPath, credentialRef, 400, "provider_http_error", false],
    [provider, driver, apiPath, credentialRef, 401, "authentication_failed", false],
    [provider, driver, apiPath, credentialRef, 402, "provider_http_error", false],
    [provider, driver, apiPath, credentialRef, 403, "permission_denied", false],
    [provider, driver, apiPath, credentialRef, 404, "provider_endpoint_not_found", false],
    [provider, driver, apiPath, credentialRef, 408, "provider_timeout", true],
    [provider, driver, apiPath, credentialRef, 413, "provider_request_too_large", false],
    [provider, driver, apiPath, credentialRef, 418, "provider_http_error", false],
    [provider, driver, apiPath, credentialRef, 422, "provider_http_error", false],
    [provider, driver, apiPath, credentialRef, 429, "provider_rate_limited", true],
    [provider, driver, apiPath, credentialRef, 500, "provider_unavailable", true],
    [provider, driver, apiPath, credentialRef, 503, "provider_unavailable", true],
    [provider, driver, apiPath, credentialRef, 504, "provider_unavailable", true],
    [provider, driver, apiPath, credentialRef, 599, "provider_unavailable", true]
  ] as const))("maps %s HTTP status through the stable contract", async (provider, driver, apiPath, credentialRef, status, code, recoverable) => {
    const result = await new ModelApiAdapter({ driver }).execute({ invocation: invocation(provider), profile: profile(provider, apiPath, credentialRef, `status-${status}`), credential: secret, signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "failed", error: { code, recoverable } });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each(providerCases)("maps a loopback %s transport failure without leaking credentials", async (provider, driver, apiPath, credentialRef) => {
    const result = await new ModelApiAdapter({ driver }).execute({
      invocation: invocation(provider),
      profile: { ...profile(provider, apiPath, credentialRef), base_url: "http://127.0.0.1:1", api_path: apiPath },
      credential: secret,
      signal: new AbortController().signal
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "provider_network_error", recoverable: true } });
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

  it.each(["1004", "1002", "1039", "1026", "2013", "string", "float", "missing"])("rejects MiniMax HTTP 200 base_resp status_code %s", async (statusCode) => {
    const result = await new ModelApiAdapter({ driver: minimaxDriver }).execute({
      invocation: invocation("minimax"),
      profile: profile("minimax", "/v1/chat/completions", "MINIMAX_API_KEY", `base-resp-${statusCode}`),
      credential: secret,
      signal: new AbortController().signal
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "provider_response_invalid", recoverable: false } });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    ["deepseek", deepseekDriver, "/v1/chat/completions", "http://127.0.0.1", "DEEPSEEK_API_KEY"],
    ["kimi", kimiDriver, "https://example.invalid/v1/chat/completions", "http://127.0.0.1", "MOONSHOT_API_KEY"],
    ["minimax", minimaxDriver, "/v1/chat/completions", "http://user:password@127.0.0.1", "MINIMAX_API_KEY"]
  ])("maps invalid local %s request configuration without fetch", async (provider, driver, apiPath, configuredBaseUrl, credentialRef) => {
    const requestCountBefore = received.length;
    const result = await new ModelApiAdapter({ driver }).execute({
      invocation: invocation(provider),
      profile: {
        ...profile(provider, "/v1/chat/completions", credentialRef),
        base_url: configuredBaseUrl,
        api_path: apiPath
      },
      credential: secret,
      signal: new AbortController().signal
    });
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "provider_request_invalid", recoverable: false }
    });
    expect(received).toHaveLength(requestCountBefore);
  });
});

describe("provider catalog fixtures", () => {
  it.each([
    ["deepseek", "DeepSeek", "deepseek", "deepseek-v4-flash", "https://api.deepseek.com", "/chat/completions", "DEEPSEEK_API_KEY", "https://api-docs.deepseek.com/api/create-chat-completion"],
    ["kimi", "Kimi", "kimi", "kimi-k2.6", "https://api.moonshot.cn", "/v1/chat/completions", "MOONSHOT_API_KEY", "https://platform.kimi.com/docs/api/overview"],
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
