import { adapterManifestSchema, type AdapterInvocation, type AdapterManifest, type ProviderCatalogEntry } from "@miracle/core";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelApiAdapter } from "./model-api-adapter";
import { authorizeProviderCredential } from "./model-api-authorization";
import { readProviderCatalog } from "./provider-catalog";
import { createProviderDriverRegistry, type ProviderDriverRegistry } from "./provider-driver-registry";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function readModelApiManifest(workspaceDir: string) {
  let entries;
  try {
    entries = await readdir(path.join(workspaceDir, "adapters"), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Provider smoke Model API manifest is missing.");
    }
    throw error;
  }
  const manifests = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => adapterManifestSchema.parse(JSON.parse(await readFile(path.join(workspaceDir, "adapters", entry.name), "utf8")) as unknown)));
  const modelApiManifests = manifests.filter((manifest) => manifest.kind === "model-api");
  if (modelApiManifests.length !== 1) throw new Error("Provider smoke requires exactly one Model API manifest.");
  return modelApiManifests[0]!;
}

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

type VerifiedArtifactRoot = {
  path: string;
  device: string;
  inode: string;
};

function isSafeSmokeArtifactBasename(fileName: string) {
  return /^[a-zA-Z0-9._-]+\.md$/.test(fileName) && path.basename(fileName) === fileName;
}

async function canonicalSmokeArtifactRoot(workspaceRoot: string): Promise<VerifiedArtifactRoot> {
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
    const directory = await handle.stat();
    if (!directory.isDirectory()) throw new Error("Provider smoke artifact root is unsafe.");
    const current = await lstat(canonicalRoot);
    if (current.isSymbolicLink() || !current.isDirectory() || await realpath(canonicalRoot) !== canonicalRoot) {
      throw new Error("Provider smoke artifact root changed during verification.");
    }
    return { path: canonicalRoot, device: String(directory.dev), inode: String(directory.ino) };
  } finally {
    await handle.close();
  }
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
  artifact_device: string;
  artifact_inode: string;
  file_name: string;
  target_path: string;
};

async function prepareSmokeArtifactDestination(workspaceDir: string, providerId: string) : Promise<SmokeArtifactDestination> {
  const workspaceRoot = await canonicalSmokeWorkspace(workspaceDir);
  const artifactRoot = await canonicalSmokeArtifactRoot(workspaceRoot);
  const fileName = `${providerId.replace(/[^a-zA-Z0-9._-]/g, "_")}-${Date.now()}.md`;
  if (!isSafeSmokeArtifactBasename(fileName)) throw new Error("Provider smoke artifact target is unsafe.");
  const targetPath = path.join(artifactRoot.path, fileName);
  await assertSmokeArtifactTargetAvailable(artifactRoot.path, targetPath);
  return {
    workspace_root: workspaceRoot,
    artifact_root: artifactRoot.path,
    artifact_device: artifactRoot.device,
    artifact_inode: artifactRoot.inode,
    file_name: fileName,
    target_path: targetPath
  };
}

async function assertCurrentArtifactRoot(destination: SmokeArtifactDestination) {
  const root = await lstat(destination.artifact_root);
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("Provider smoke artifact root changed during execution.");
  const canonicalRoot = await realpath(destination.artifact_root);
  if (canonicalRoot !== destination.artifact_root || !isPathInside(destination.workspace_root, canonicalRoot)) {
    throw new Error("Provider smoke artifact root changed during execution.");
  }
  const current = await stat(canonicalRoot);
  if (String(current.dev) !== destination.artifact_device || String(current.ino) !== destination.artifact_inode) {
    throw new Error("Provider smoke artifact root changed during execution.");
  }
}

const smokeArtifactWriterProgram = String.raw`
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const readline = require("node:readline");
const fileName = process.env.MIRACLE_SMOKE_WRITER_BASENAME;
const safeName = typeof fileName === "string" && /^[a-zA-Z0-9._-]+\.md$/.test(fileName) && !fileName.includes("/") && !fileName.includes(String.fromCharCode(92));
const send = (message) => new Promise((resolve) => process.stdout.write(JSON.stringify(message) + "\n", resolve));

async function exitWithError(code) {
  await send({ type: "error", code });
  process.exitCode = 1;
}

(async () => {
  if (!safeName) return exitWithError("unsafe_name");
  let directory;
  try {
    directory = await fs.stat(".");
  } catch {
    return exitWithError("cwd_unavailable");
  }
  await send({ type: "ready", device: String(directory.dev), inode: String(directory.ino) });

  let written = false;
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return exitWithError("invalid_command");
    }
    if (message.type === "write" && !written && typeof message.content === "string") {
      try {
        const handle = await fs.open(fileName, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          const target = await handle.stat();
          if (!target.isFile() || target.nlink !== 1) throw new Error("unsafe_target");
          await handle.writeFile(message.content, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        written = true;
        await send({ type: "written" });
      } catch {
        return exitWithError("write_failed");
      }
      continue;
    }
    if (message.type === "commit" && written) {
      await send({ type: "committed" });
      return;
    }
    if (message.type === "discard" && written) {
      try {
        await fs.unlink(fileName);
      } catch {
        return exitWithError("discard_failed");
      }
      await send({ type: "discarded" });
      return;
    }
    return exitWithError("invalid_command");
  }
})().catch(() => { process.exitCode = 1; });
`;

type SmokeWriterMessage =
  | { type: "ready"; device: string; inode: string }
  | { type: "written" }
  | { type: "committed" }
  | { type: "discarded" }
  | { type: "error"; code: string };

function isSmokeWriterMessage(value: unknown): value is SmokeWriterMessage {
  if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "ready") return typeof message.device === "string" && typeof message.inode === "string";
  return message.type === "written" || message.type === "committed" || message.type === "discarded"
    || (message.type === "error" && typeof message.code === "string");
}

async function writeSmokeArtifact(
  destination: SmokeArtifactDestination,
  content: string,
  beforeArtifactWrite?: () => Promise<void> | void
) {
  if (!isSafeSmokeArtifactBasename(destination.file_name)) throw new Error("Provider smoke artifact target is unsafe.");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", smokeArtifactWriterProgram], {
      cwd: destination.artifact_root,
      env: { MIRACLE_SMOKE_WRITER_BASENAME: destination.file_name },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let settled = false;
    let buffer = "";
    let discardError: Error | undefined;
    let messageQueue = Promise.resolve();

    const rejectWriter = (error: Error) => {
      if (settled) return;
      settled = true;
      child.stdin.end();
      child.kill();
      reject(error);
    };
    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const handleMessage = async (message: SmokeWriterMessage) => {
      if (settled) return;
      if (message.type === "error") return rejectWriter(new Error("Provider smoke artifact write failed."));
      if (message.type === "ready") {
        if (message.device !== destination.artifact_device || message.inode !== destination.artifact_inode) {
          return rejectWriter(new Error("Provider smoke artifact root changed during execution."));
        }
        try {
          await beforeArtifactWrite?.();
          send({ type: "write", content });
        } catch {
          rejectWriter(new Error("Provider smoke artifact write preparation failed."));
        }
        return;
      }
      if (message.type === "written") {
        try {
          await assertCurrentArtifactRoot(destination);
          send({ type: "commit" });
        } catch (error) {
          discardError = error instanceof Error ? error : new Error("Provider smoke artifact root changed during execution.");
          send({ type: "discard" });
        }
        return;
      }
      if (message.type === "discarded") return rejectWriter(discardError ?? new Error("Provider smoke artifact write failed."));
      if (message.type === "committed") {
        settled = true;
        child.stdin.end();
        resolve();
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message: unknown = JSON.parse(line);
          if (!isSmokeWriterMessage(message)) throw new Error("invalid message");
          messageQueue = messageQueue.then(() => handleMessage(message)).catch(() => {
            rejectWriter(new Error("Provider smoke artifact writer protocol failed."));
          });
        } catch {
          rejectWriter(new Error("Provider smoke artifact writer protocol failed."));
        }
      }
    });
    child.stderr.on("data", () => undefined);
    child.once("error", () => rejectWriter(new Error("Provider smoke artifact writer failed to start.")));
    child.once("exit", () => {
      if (!settled) rejectWriter(new Error("Provider smoke artifact writer exited before committing."));
    });
  });
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
  manifest?: AdapterManifest;
  driverRegistry?: ProviderDriverRegistry;
  beforeArtifactWrite?: () => Promise<void> | void;
} = {}): Promise<ProviderSmokeResult> {
  const env = input.env ?? process.env;
  const configuredWorkspaceDir = input.workspaceDir ?? env.MIRACLE_WORKSPACE_DIR;
  const configurationWorkspaceDir = configuredWorkspaceDir ?? path.join(rootDir, "fixtures/mvp-workspace/.miracle");
  const providerId = env.MIRACLE_SMOKE_PROVIDER;
  if (env.MIRACLE_ENABLE_MODEL_API !== "1") assertProviderSmokeEnabled({ enabled: env.MIRACLE_ENABLE_MODEL_API, provider: providerId });
  const catalog = input.catalog ?? await readProviderCatalog(configurationWorkspaceDir);
  const entry = catalog.find((candidate) => candidate.id === providerId || candidate.profile.provider === providerId);
  if (!entry) throw new Error("MIRACLE_SMOKE_PROVIDER does not match a configured provider catalog entry.");
  if (entry.credential.source !== "env") throw new Error("Provider smoke only supports an env credential source in this local Sidecar phase.");
  const manifest = input.manifest ?? await readModelApiManifest(configurationWorkspaceDir);
  if (!authorizeProviderCredential(manifest, entry.profile).authorized) {
    throw new Error("Provider credential_ref is not authorized for this Model API Adapter.");
  }
  const credential = env[entry.credential.key];
  assertProviderSmokeEnabled({ enabled: env.MIRACLE_ENABLE_MODEL_API, provider: providerId, credential });
  if (!credential) throw new Error("Provider credential is missing; no request was constructed.");
  const registry = input.driverRegistry ?? createProviderDriverRegistry();
  const driver = registry.resolve({ driver_id: entry.driver_id, provider: entry.profile.provider });
  if (!driver) throw new Error("Provider Driver is not registered; no request was constructed.");
  const artifactWorkspaceDir = configuredWorkspaceDir
    ?? await mkdtemp(path.join(tmpdir(), "miracle-provider-smoke-"));
  const artifactDestination = await prepareSmokeArtifactDestination(artifactWorkspaceDir, entry.id);

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
  await writeSmokeArtifact(artifactDestination, markdown, input.beforeArtifactWrite);
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
