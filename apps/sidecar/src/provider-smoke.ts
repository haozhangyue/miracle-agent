import type { AdapterInvocation, ProviderCatalogEntry } from "@miracle/core";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelApiAdapter } from "./model-api-adapter";
import { readProviderCatalog } from "./provider-catalog";
import { createProviderDriverRegistry, type ProviderDriverRegistry } from "./provider-driver-registry";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function isPathInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function canonicalSmokeWorkspace(workspaceDir: string) {
  const lexicalWorkspace = path.resolve(workspaceDir);
  const entry = await lstat(lexicalWorkspace);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Provider smoke workspace is not canonical or is unsafe.");
  const canonicalWorkspace = await realpath(lexicalWorkspace);
  return canonicalWorkspace;
}

async function canonicalSmokeArtifactRoot(workspaceRoot: string) {
  const artifactRoot = path.join(workspaceRoot, "smoke-artifacts");
  try {
    await mkdir(artifactRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const entry = await lstat(artifactRoot);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Provider smoke artifact root is unsafe.");
  const canonicalRoot = await realpath(artifactRoot);
  if (canonicalRoot !== artifactRoot || !isPathInside(workspaceRoot, canonicalRoot) || path.dirname(canonicalRoot) !== workspaceRoot) {
    throw new Error("Provider smoke artifact root is not canonical.");
  }
  const handle = await open(canonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error("Provider smoke artifact root is unsafe.");
    const current = await lstat(canonicalRoot);
    if (current.isSymbolicLink() || !current.isDirectory() || await realpath(canonicalRoot) !== canonicalRoot) {
      throw new Error("Provider smoke artifact root changed during verification.");
    }
  } finally {
    await handle.close();
  }
  return canonicalRoot;
}

async function assertSmokeArtifactTargetAvailable(artifactRoot: string, targetPath: string) {
  if (path.dirname(targetPath) !== artifactRoot || path.basename(targetPath) !== targetPath.slice(artifactRoot.length + 1)) {
    throw new Error("Provider smoke artifact target is unsafe.");
  }
  try {
    await lstat(targetPath);
    throw new Error("Provider smoke artifact target is unsafe or already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

type SmokeArtifactDestination = {
  workspace_root: string;
  artifact_root: string;
  target_path: string;
};

async function prepareSmokeArtifactDestination(workspaceDir: string, providerId: string) : Promise<SmokeArtifactDestination> {
  const workspaceRoot = await canonicalSmokeWorkspace(workspaceDir);
  const artifactRoot = await canonicalSmokeArtifactRoot(workspaceRoot);
  const fileName = `${providerId.replace(/[^a-zA-Z0-9._-]/g, "_")}-${Date.now()}.md`;
  const targetPath = path.join(artifactRoot, fileName);
  await assertSmokeArtifactTargetAvailable(artifactRoot, targetPath);
  return { workspace_root: workspaceRoot, artifact_root: artifactRoot, target_path: targetPath };
}

async function writeSmokeArtifact(destination: SmokeArtifactDestination, content: string) {
  const workspaceRoot = await canonicalSmokeWorkspace(destination.workspace_root);
  const artifactRoot = await canonicalSmokeArtifactRoot(workspaceRoot);
  if (workspaceRoot !== destination.workspace_root || artifactRoot !== destination.artifact_root) {
    throw new Error("Provider smoke artifact root changed during execution.");
  }
  await assertSmokeArtifactTargetAvailable(artifactRoot, destination.target_path);
  const handle = await open(
    destination.target_path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    const target = await handle.stat();
    if (!target.isFile() || target.nlink !== 1) throw new Error("Provider smoke artifact target is unsafe.");
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

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
  const artifactDestination = await prepareSmokeArtifactDestination(workspaceDir, entry.id);

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
  await writeSmokeArtifact(artifactDestination, markdown);
  return {
    provider: entry.profile.provider,
    artifact_path: artifactDestination.target_path,
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
