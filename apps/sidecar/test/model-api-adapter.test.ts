import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterInvocation, ProviderDriver } from "@miracle/core";

const fixtureServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/provider-server.mjs");
let providerServer: ChildProcessWithoutNullStreams | undefined;
let baseUrl = "";

const invocation = {
  operation_id: "op_model_api_adapter",
  attempt_id: "attempt_model_api_adapter",
  attempt_number: 1,
  run_id: "run_model_api_adapter",
  node_run_id: "nr_model_api_adapter",
  node_id: "node_model_api_adapter",
  adapter_kind: "model-api",
  adapter_id: "model-api-compatible-adapter",
  provider: "fixture-compatible",
  capability_requirements: ["model.call"],
  input_artifacts: [],
  resolved_inputs: [],
  expected_outputs: [],
  runtime_control: {
    timeout_ms: 150,
    cancellation_token_id: "cancel_model_api_adapter",
    attempt_workspace: "runtime/run_model_api_adapter/nr_model_api_adapter/attempt_model_api_adapter",
    sandbox: "workspace-write"
  },
  prompt_path: "input/prompt.txt",
  output_schema_path: "meta/output.schema.json",
  dispatched_at: "2026-07-31T00:00:00.000Z"
} as unknown as AdapterInvocation;

async function loadAdapter() {
  const [{ ModelApiAdapter }, { openAiCompatibleDriver }] = await Promise.all([
    import("../src/model-api-adapter"),
    import("../src/provider-drivers/openai-compatible")
  ]);
  return new ModelApiAdapter({ driver: openAiCompatibleDriver, max_response_bytes: 128_000 });
}

function profile(mode = "success") {
  return {
    id: "fixture-compatible-default",
    provider: "fixture-compatible",
    model: "fixture-chat",
    base_url: baseUrl,
    api_path: `/v1/chat/completions?mode=${mode}`,
    credential_ref: "MODEL_API_FIXTURE_CREDENTIAL",
    verification_status: "configured_unverified" as const
  };
}

beforeAll(async () => {
  providerServer = spawn(process.execPath, [fixtureServer]);
  const port = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Provider fixture did not start: ${output}`)), 5_000);
    providerServer?.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/provider-fixture:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]!);
    });
    providerServer?.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
  });
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => providerServer?.kill("SIGTERM"));

describe("ModelApiAdapter", () => {
  it("normalizes a compatible chat response without exposing the credential", async () => {
    const adapter = await loadAdapter();
    const result = await adapter.execute({ invocation, profile: profile(), credential: "fixture-secret", signal: new AbortController().signal });

    expect(result).toMatchObject({
      status: "succeeded",
      provider_receipt: {
        provider: "fixture-compatible",
        model: "fixture-chat",
        operation_id: invocation.operation_id,
        usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 }
      }
    });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });

  it.each([
    ["401-oversized", "authentication_failed", false],
    ["429-invalid", "provider_rate_limited", true],
    ["500-hang", "provider_unavailable", true]
  ] as const)("maps HTTP %s after headers without reading an unsafe body", async (mode, code, recoverable) => {
    const adapter = await loadAdapter();
    const result = await adapter.execute({ invocation, profile: profile(mode), credential: "fixture-secret", signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "failed", error: { code, recoverable } });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });

  it("maps timeout, invalid JSON, and oversized responses without leaking the credential", async () => {
    const adapter = await loadAdapter();
    const timeout = await adapter.execute({ invocation, profile: profile("slow"), credential: "fixture-secret", signal: new AbortController().signal });
    const invalidJson = await adapter.execute({ invocation, profile: profile("invalid-json"), credential: "fixture-secret", signal: new AbortController().signal });
    const oversized = await adapter.execute({ invocation, profile: profile("oversized"), credential: "fixture-secret", signal: new AbortController().signal });

    expect(timeout).toMatchObject({ status: "timed_out", error: { code: "process_timeout" } });
    expect(invalidJson).toMatchObject({ status: "failed", error: { code: "provider_response_invalid" } });
    expect(oversized).toMatchObject({ status: "failed", error: { code: "provider_response_too_large" } });
    expect(JSON.stringify([timeout, invalidJson, oversized])).not.toContain("fixture-secret");
  });

  it("allows a successful response without usage", async () => {
    const adapter = await loadAdapter();
    const result = await adapter.execute({ invocation, profile: profile("missing-usage"), credential: "fixture-secret", signal: new AbortController().signal });
    expect(result.status).toBe("succeeded");
    expect(result.provider_receipt).not.toHaveProperty("usage");
  });

  it("redacts credential echoes from provider receipts and driver errors", async () => {
    const adapter = await loadAdapter();
    const echoedReceipt = await adapter.execute({ invocation, profile: profile("credential-echo"), credential: "fixture-secret", signal: new AbortController().signal });
    const { openAiCompatibleDriver } = await import("../src/provider-drivers/openai-compatible");
    const echoingDriver: ProviderDriver = {
      ...openAiCompatibleDriver,
      mapError: () => ({ code: "fixture-secret", message: "fixture-secret", recoverable: true })
    };
    const echoedError = await new (await import("../src/model-api-adapter")).ModelApiAdapter({ driver: echoingDriver })
      .execute({ invocation, profile: profile("401"), credential: "fixture-secret", signal: new AbortController().signal });
    const echoedThrownError = await new (await import("../src/model-api-adapter")).ModelApiAdapter({
      driver: {
        ...echoingDriver,
        buildRequest: () => {
          throw new Error("fixture transport failure");
        }
      }
    }).execute({ invocation, profile: profile(), credential: "fixture-secret", signal: new AbortController().signal });

    expect(echoedReceipt.provider_receipt).not.toHaveProperty("raw_receipt_id");
    expect(echoedError).toMatchObject({ error: { code: "provider_response_redacted", recoverable: false } });
    expect(echoedThrownError).toMatchObject({ error: { code: "provider_response_redacted", recoverable: false } });
    expect(JSON.stringify([echoedReceipt, echoedError, echoedThrownError])).not.toContain("fixture-secret");
  });

  it("maps malformed UTF-8 to provider_response_invalid", async () => {
    const adapter = await loadAdapter();
    const result = await adapter.execute({ invocation, profile: profile("invalid-utf8"), credential: "fixture-secret", signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "failed", error: { code: "provider_response_invalid", recoverable: false } });
  });

  it("honors a direct external AbortSignal", async () => {
    const adapter = await loadAdapter();
    const controller = new AbortController();
    const pending = adapter.execute({ invocation, profile: profile("slow"), credential: "fixture-secret", signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).resolves.toMatchObject({ status: "cancelled", error: { code: "operation_cancelled" } });
  });

  it.each(["//provider.example/v1/chat", "//user@provider.example/v1/chat", "https://provider.example/v1/chat"])("rejects unsafe api_path in the driver: %s", async (apiPath) => {
    const { openAiCompatibleDriver } = await import("../src/provider-drivers/openai-compatible");
    expect(() => openAiCompatibleDriver.buildRequest({ invocation, profile: { ...profile(), api_path: apiPath }, credential: "fixture-secret" })).toThrow(/api_path/i);
  });
});
