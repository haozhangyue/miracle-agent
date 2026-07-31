import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterInvocation } from "@miracle/core";

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

  it.each([401, 429, 500])("maps HTTP %s into a stable provider error", async (status) => {
    const adapter = await loadAdapter();
    const result = await adapter.execute({ invocation, profile: profile(String(status)), credential: "fixture-secret", signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "failed", error: { code: expect.any(String) } });
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
});
