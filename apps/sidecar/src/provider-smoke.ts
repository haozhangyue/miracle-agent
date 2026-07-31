import type { AdapterInvocation, ProviderCatalogEntry } from "@miracle/core";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelApiAdapter } from "./model-api-adapter";
import { readProviderCatalog } from "./provider-catalog";
import { createProviderDriverRegistry, type ProviderDriverRegistry } from "./provider-driver-registry";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function assertProviderSmokeEnabled(input: { enabled?: string; provider?: string; credential?: string }) {
  if (input.enabled !== "1") throw new Error("MIRACLE_ENABLE_MODEL_API=1 is required before running a provider smoke test.");
  if (!input.provider || !/^[a-zA-Z0-9._-]+$/.test(input.provider)) throw new Error("MIRACLE_SMOKE_PROVIDER must identify one configured provider.");
  if (!input.credential) throw new Error("Provider credential is missing; no request was constructed.");
}

function redact(value: string, credential: string) {
  return value.split(credential).join("[REDACTED]");
}

function smokeInvocation(entry: ProviderCatalogEntry): AdapterInvocation {
  const now = new Date().toISOString();
  return {
    operation_id: `smoke_${entry.id}_${Date.now()}`,
    attempt_id: `smoke_attempt_${Date.now()}`,
    attempt_number: 1,
    run_id: "provider-smoke",
    node_run_id: `provider-smoke-${entry.id}`,
    node_id: "provider-smoke",
    adapter_kind: "model-api",
    adapter_id: "model-api-compatible-adapter",
    provider: entry.profile.provider,
    capability_requirements: ["model.call"],
    input_artifacts: [],
    resolved_inputs: [],
    expected_outputs: [],
    runtime_control: {
      timeout_ms: 30_000,
      cancellation_token_id: `smoke_cancel_${Date.now()}`,
      attempt_workspace: `smoke/${entry.id}`,
      sandbox: "read-only"
    },
    prompt_path: "smoke/prompt.txt",
    output_schema_path: "smoke/output.schema.json",
    dispatched_at: now
  };
}

export interface ProviderSmokeResult {
  provider: string;
  artifact_path: string;
  usage?: unknown;
  latency_ms?: unknown;
  receipt: Record<string, unknown>;
}

export async function runProviderSmoke(input: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  catalog?: ProviderCatalogEntry[];
  driverRegistry?: ProviderDriverRegistry;
} = {}): Promise<ProviderSmokeResult> {
  const env = input.env ?? process.env;
  const workspaceDir = input.workspaceDir ?? env.MIRACLE_WORKSPACE_DIR ?? path.join(rootDir, "fixtures/mvp-workspace/.miracle");
  const providerId = env.MIRACLE_SMOKE_PROVIDER;
  if (env.MIRACLE_ENABLE_MODEL_API !== "1") assertProviderSmokeEnabled({ enabled: env.MIRACLE_ENABLE_MODEL_API, provider: providerId });
  const catalog = input.catalog ?? await readProviderCatalog(workspaceDir);
  const entry = catalog.find((candidate) => candidate.id === providerId || candidate.profile.provider === providerId);
  if (!entry) throw new Error("MIRACLE_SMOKE_PROVIDER does not match a configured provider catalog entry.");
  if (entry.credential.source !== "env") throw new Error("Provider smoke only supports an env credential source in this local Sidecar phase.");
  const credential = env[entry.credential.key];
  assertProviderSmokeEnabled({ enabled: env.MIRACLE_ENABLE_MODEL_API, provider: providerId, credential });
  if (!credential) throw new Error("Provider credential is missing; no request was constructed.");
  const registry = input.driverRegistry ?? createProviderDriverRegistry();
  const driver = registry.resolve({ driver_id: entry.driver_id, provider: entry.profile.provider });
  if (!driver) throw new Error("Provider Driver is not registered; no request was constructed.");

  let outputText: string | undefined;
  const result = await new ModelApiAdapter({
    driver,
    onNormalizedResponse: (response) => { outputText = response.output_text; }
  }).execute({
    invocation: smokeInvocation(entry),
    profile: entry.profile,
    credential,
    signal: new AbortController().signal,
    prompt: "Return a short, harmless Miracle Provider smoke acknowledgement."
  });
  if (result.status !== "succeeded") throw new Error(`Provider smoke failed: ${result.error?.code ?? "unknown"}`);

  const artifactDir = path.join(workspaceDir, "smoke-artifacts");
  const artifactPath = path.join(artifactDir, `${entry.id.replace(/[^a-zA-Z0-9._-]/g, "_")}-${Date.now()}.md`);
  const receipt = result.provider_receipt;
  const markdown = [
    "# Miracle Provider Smoke",
    "",
    `- provider: ${entry.profile.provider}`,
    `- model: ${entry.profile.model}`,
    `- latency_ms: ${String(receipt.latency_ms ?? "unknown")}`,
    "",
    "## Normalized Output",
    "",
    redact(outputText ?? "", credential)
  ].join("\n");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, markdown, { encoding: "utf8", mode: 0o600 });
  return {
    provider: entry.profile.provider,
    artifact_path: artifactPath,
    ...(receipt.usage ? { usage: receipt.usage } : {}),
    ...(receipt.latency_ms !== undefined ? { latency_ms: receipt.latency_ms } : {}),
    receipt
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProviderSmoke().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Provider smoke failed."}\n`);
    process.exitCode = 1;
  });
}
