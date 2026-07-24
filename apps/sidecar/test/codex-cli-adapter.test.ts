import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterInvocation } from "@miracle/core";
import {
  CodexCliAdapter,
  CodexCliAdapterError,
  type AttemptWorkspace
} from "../src/codex-cli-adapter";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fakeCodex = path.join(repoRoot, "apps/sidecar/test/fixtures/bin/fake-codex.mjs");

let tempRoot = "";
let workspaceDir = "";
let sourceDir = "";

function createAdapter(environment: Record<string, string> = {}) {
  return new CodexCliAdapter({
    workspace_dir: workspaceDir,
    repository_root: repoRoot,
    executable_path: process.execPath,
    command_prefix_args: [fakeCodex],
    execution_environment: environment,
    now: () => "2026-07-13T08:00:00.000Z",
    terminate_grace_ms: 25,
    max_output_bytes: 512
  });
}

function sha256(content: string) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function createWorkspace(adapter = createAdapter(), attemptId = "attempt_001"): Promise<AttemptWorkspace> {
  return adapter.createAttemptWorkspace({
    attempt_id: attemptId,
    input_files: [{ source_path: path.join(sourceDir, "brief.md"), target_path: "brief.md" }],
    allowed_input_roots: [sourceDir],
    output_schema: { type: "object", properties: {} }
  });
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function invocation(attempt: AttemptWorkspace, operationId = "op_001"): AdapterInvocation {
  return {
    operation_id: operationId,
    attempt_id: attempt.attempt_id,
    node_run_id: "nr_001",
    node_id: "C_md_master",
    run_id: "run_001",
    adapter_kind: "codex" as const,
    adapter_id: "codex-cli-real",
    provider: "codex-local",
    capability_requirements: ["content.longform_draft"],
    input_artifacts: [],
    resolved_inputs: [],
    expected_outputs: [],
    runtime_control: {
      timeout_ms: 100,
      cancellation_token_id: "cancel_op_001",
      attempt_workspace: attempt.root_dir,
      sandbox: "workspace-write" as const
    },
    prompt_path: path.join(attempt.input_dir, "brief.md"),
    output_schema_path: path.join(attempt.meta_dir, "output.schema.json"),
    dispatched_at: "2026-07-13T08:00:00.000Z"
  };
}

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "miracle-codex-cli-"));
  workspaceDir = path.join(tempRoot, ".miracle");
  sourceDir = path.join(tempRoot, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, "brief.md"), "approved input\n", "utf8");
});

afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

describe("CodexCliAdapter health", () => {
  it("reports a missing CLI without exposing environment values", async () => {
    const adapter = new CodexCliAdapter({
      workspace_dir: workspaceDir,
      executable_path: path.join(tempRoot, "missing-codex"),
      execution_environment: { SECRET_SENTINEL: "do-not-return" },
      now: () => "2026-07-13T08:00:00.000Z"
    });

    const health = await adapter.refreshHealth();

    expect(health).toMatchObject({ status: "blocked", authenticated: false, reasons: ["runtime_not_found"] });
    expect(JSON.stringify(health)).not.toContain("do-not-return");
  });

  it("reads version and login status through argument arrays only", async () => {
    const health = await createAdapter().refreshHealth();

    expect(health).toMatchObject({ adapter_id: "codex-cli-real", status: "healthy", version: "0.142.1", authenticated: true, reasons: [] });
    expect(health.executable_path).toBe(path.basename(process.execPath));
  });

  it("reports an installed but unauthenticated CLI as blocked", async () => {
    const health = await createAdapter({ FAKE_CODEX_LOGIN: "missing" }).refreshHealth();

    expect(health).toMatchObject({ status: "blocked", authenticated: false, reasons: ["credential_missing"] });
  });

  it("bounds health-check stderr without returning its contents", async () => {
    const health = await createAdapter({ FAKE_CODEX_HEALTH_STDERR: "huge" }).refreshHealth();

    expect(health).toMatchObject({ status: "degraded", authenticated: false, reasons: ["version_check_failed"] });
    expect(JSON.stringify(health)).not.toContain("x".repeat(32));
  });
});

describe("CodexCliAdapter attempt workspace", () => {
  it("requires a repo-external, non-symlink runtime root", async () => {
    const repositoryRoot = path.join(tempRoot, "repository");
    const repositoryWorkspace = path.join(repositoryRoot, ".miracle");
    const externalRoot = path.join(tempRoot, "external-runtime");
    const linkedRoot = path.join(tempRoot, "linked-runtime");
    await mkdir(repositoryRoot, { recursive: true });
    await mkdir(externalRoot, { recursive: true });
    await symlink(externalRoot, linkedRoot);

    for (const [index, candidate] of [repositoryWorkspace, linkedRoot].entries()) {
      const adapter = new CodexCliAdapter({ repository_root: repositoryRoot, workspace_dir: candidate, executable_path: process.execPath, command_prefix_args: [fakeCodex] });
      await expect(adapter.createAttemptWorkspace({ attempt_id: `attempt_runtime_${index}`, input_files: [], allowed_input_roots: [] })).rejects.toMatchObject({ code: "runtime_workspace_required" });
    }
  });

  it("rejects symlinked runtime and attempts segments before creating a canonical attempt", async () => {
    for (const segment of ["runtime", "runtime/attempts"]) {
      const workspace = path.join(tempRoot, `workspace_${segment.replaceAll("/", "_")}`);
      const external = path.join(tempRoot, `external_${segment.replaceAll("/", "_")}`);
      const linkTarget = path.join(workspace, segment);
      await mkdir(path.dirname(linkTarget), { recursive: true });
      await mkdir(external, { recursive: true });
      await symlink(external, linkTarget);
      const adapter = new CodexCliAdapter({ repository_root: repoRoot, workspace_dir: workspace, executable_path: process.execPath, command_prefix_args: [fakeCodex] });

      await expect(adapter.createAttemptWorkspace({ attempt_id: `attempt_${segment.replaceAll("/", "_")}`, input_files: [], allowed_input_roots: [] })).rejects.toMatchObject({ code: "runtime_workspace_required" });
    }
  });

  it("rejects input paths outside the explicit allowlist", async () => {
    const adapter = createAdapter();
    const outside = path.join(tempRoot, "outside.md");
    await writeFile(outside, "outside", "utf8");

    await expect(adapter.createAttemptWorkspace({
      attempt_id: "attempt_escape",
      input_files: [{ source_path: outside, target_path: "outside.md" }],
      allowed_input_roots: [sourceDir]
    })).rejects.toMatchObject({ code: "input_path_not_allowed" });
  });

  it("rejects a staged copy when its bytes do not match the frozen artifact hash", async () => {
    const adapter = createAdapter();

    await writeFile(path.join(sourceDir, "brief.md"), "replacement bytes\n", "utf8");

    await expect(adapter.createAttemptWorkspace({
      attempt_id: "attempt_hash_mismatch",
      input_files: [{ source_path: path.join(sourceDir, "brief.md"), target_path: "artifacts/brief.md", expected_hash: sha256("approved input\n") }],
      allowed_input_roots: [sourceDir]
    })).rejects.toMatchObject({ code: "input_hash_mismatch" });
  });

  it("rejects a source swapped to a symbolic link before staging", async () => {
    const adapter = createAdapter();
    const replacement = path.join(sourceDir, "replacement.md");
    await writeFile(replacement, "approved input\n", "utf8");
    await rm(path.join(sourceDir, "brief.md"));
    await symlink("replacement.md", path.join(sourceDir, "brief.md"));

    await expect(adapter.createAttemptWorkspace({
      attempt_id: "attempt_symlink_swap",
      input_files: [{ source_path: path.join(sourceDir, "brief.md"), target_path: "artifacts/brief.md", expected_hash: sha256("approved input\n") }],
      allowed_input_roots: [sourceDir]
    })).rejects.toMatchObject({ code: "input_path_not_allowed" });
  });

  it("stages inputs as read-only snapshots and accepts only regular output files under output", async () => {
    const adapter = createAdapter();
    const attempt = await createWorkspace(adapter);
    const staged = path.join(attempt.input_dir, "brief.md");
    const regularOutput = path.join(attempt.output_dir, "draft.md");
    const linkedOutput = path.join(attempt.output_dir, "linked.md");
    const hardlinkedOutput = path.join(attempt.output_dir, "hardlinked.md");
    await writeFile(regularOutput, "draft\n", "utf8");
    await symlink(staged, linkedOutput);

    expect(await readFile(staged, "utf8")).toBe("approved input\n");
    expect((await stat(staged)).mode & 0o222).toBe(0);
    expect(await adapter.validateOutputFile(attempt, "draft.md")).toBe(regularOutput);
    await expect(adapter.validateOutputFile(attempt, "../input/brief.md")).rejects.toMatchObject({ code: "workspace_escape_detected" });
    await expect(adapter.validateOutputFile(attempt, "linked.md")).rejects.toMatchObject({ code: "workspace_escape_detected" });
    await link(regularOutput, hardlinkedOutput);
    await expect(adapter.validateOutputFile(attempt, "hardlinked.md")).rejects.toMatchObject({ code: "workspace_escape_detected" });
  });

  it("rejects concurrent reuse of the same attempt and retains terminal workspace metadata", async () => {
    const adapter = createAdapter();
    const attempt = await createWorkspace(adapter, "attempt_conflict");

    await expect(createWorkspace(adapter, "attempt_conflict")).rejects.toMatchObject({ code: "attempt_workspace_conflict" });
    await adapter.cleanupAttemptWorkspace(attempt);
    expect(JSON.parse(await readFile(path.join(attempt.meta_dir, "attempt.json"), "utf8"))).toMatchObject({ status: "retained" });
    expect(await readFile(path.join(attempt.input_dir, "brief.md"), "utf8")).toBe("approved input\n");
  });
});

describe("CodexCliAdapter process lifecycle", () => {
  it("rejects unsafe operation ids before any receipt path is constructed", async () => {
    const adapter = createAdapter();
    const attempt = await createWorkspace(adapter, "attempt_operation_id");

    const started = await Promise.allSettled([adapter.startOperation({ invocation: invocation(attempt, "../outside"), attempt_workspace: attempt })]);
    if (started[0]?.status === "fulfilled") await started[0].value.result;
    expect(started[0]).toMatchObject({ status: "rejected", reason: { code: "invalid_operation_id" } });
    expect(await readFile(path.join(attempt.meta_dir, "attempt.json"), "utf8")).toContain("prepared");
  });

  it("skips invalid persisted operation ids instead of traversing receipt paths during recovery", async () => {
    const adapter = createAdapter();
    const operationDir = path.join(workspaceDir, "runtime", "operations");
    await mkdir(operationDir, { recursive: true });
    await writeFile(path.join(operationDir, "invalid.json"), JSON.stringify({
      operation_id: "../../escaped",
      attempt_id: "attempt_orphan",
      node_run_id: "nr_orphan",
      pid: 999_999_999,
      status: "running",
      started_at: "2026-07-13T08:00:00.000Z"
    }), "utf8");

    await expect(adapter.recoverOrphanedOperations()).resolves.toEqual([]);
    await expect(readFile(path.join(workspaceDir, "runtime", "escaped.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("registers spawn error handling before receipt persistence and settles ENOENT", async () => {
    const adapter = new CodexCliAdapter({ repository_root: repoRoot, workspace_dir: workspaceDir, executable_path: path.join(tempRoot, "missing-codex") });
    const attempt = await createWorkspace(adapter, "attempt_spawn_missing");
    const handle = await adapter.startOperation({ invocation: invocation(attempt, "op_spawn_missing"), attempt_workspace: attempt });

    await expect(handle.result).resolves.toMatchObject({ status: "failed", error: { code: "process_spawn_failed" } });
  });

  it("uses the invocation sandbox argument rather than a hard-coded sandbox", async () => {
    const probe = path.join(tempRoot, "sandbox-probe.mjs");
    await writeFile(probe, `
      const args = process.argv.slice(2);
      const index = args.indexOf("--sandbox");
      if (args[index + 1] !== "read-only") process.exit(7);
      process.stdout.write('{"type":"turn.completed"}\\n');
    `, "utf8");
    const adapter = new CodexCliAdapter({ repository_root: repoRoot, workspace_dir: workspaceDir, executable_path: process.execPath, command_prefix_args: [probe] });
    const attempt = await createWorkspace(adapter, "attempt_read_only");
    const input = invocation(attempt, "op_read_only");
    input.runtime_control.sandbox = "read-only";

    const handle = await adapter.startOperation({ invocation: input, attempt_workspace: attempt });
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
  });

  it("rejects an invocation whose declared workspace is not the canonical attempt path", async () => {
    const adapter = createAdapter();
    const attempt = await createWorkspace(adapter, "attempt_canonical");
    const invalidInvocation = invocation(attempt, "op_canonical");
    invalidInvocation.runtime_control.attempt_workspace = path.join(attempt.root_dir, "work");

    await expect(adapter.startOperation({ invocation: invalidInvocation, attempt_workspace: attempt })).rejects.toMatchObject({ code: "workspace_escape_detected" });
  });

  it("validates invocation attempt ids and anchors a replaced attempt directory to the verified attempts root", async () => {
    const adapter = createAdapter();
    const attempt = await createWorkspace(adapter, "attempt_revalidated");
    const traversal = invocation(attempt, "op_attempt_traversal");
    traversal.attempt_id = "../../../outside";

    await expect(adapter.startOperation({ invocation: traversal, attempt_workspace: attempt })).rejects.toMatchObject({ code: "invalid_attempt_id" });

    const replacement = path.join(tempRoot, "replacement-attempt");
    await mkdir(path.join(replacement, "work"), { recursive: true });
    await rm(attempt.root_dir, { recursive: true, force: true });
    await symlink(replacement, attempt.root_dir);

    await expect(adapter.startOperation({ invocation: invocation(attempt, "op_attempt_replaced"), attempt_workspace: attempt })).rejects.toMatchObject({ code: "workspace_escape_detected" });
  });

  it.each(["input", "meta", "output"] as const)("rejects a symlink swap of attempt %s immediately before spawn without launching Codex", async (segment) => {
    const marker = path.join(tempRoot, `spawned-after-${segment}-swap`);
    const adapter = createAdapter({ FAKE_CODEX_EXEC_MARKER: marker });
    const attempt = await createWorkspace(adapter, `attempt_${segment}_swap`);
    const external = path.join(tempRoot, `external_${segment}`);
    await mkdir(external, { recursive: true });
    await rm(attempt[`${segment}_dir`], { recursive: true, force: true });
    await symlink(external, attempt[`${segment}_dir`]);

    await expect(adapter.startOperation({ invocation: invocation(attempt, `op_${segment}_swap`), attempt_workspace: attempt })).rejects.toMatchObject({ code: "workspace_escape_detected" });
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked operations root for receipt writes and orphan recovery", async () => {
    const adapter = createAdapter();
    const attempt = await createWorkspace(adapter, "attempt_operations_root");
    const operations = path.join(workspaceDir, "runtime", "operations");
    const external = path.join(tempRoot, "external-operations");
    await mkdir(external, { recursive: true });
    await symlink(external, operations);

    await expect(adapter.startOperation({ invocation: invocation(attempt, "op_operations_root"), attempt_workspace: attempt })).rejects.toMatchObject({ code: "runtime_workspace_required" });
    await expect(adapter.recoverOrphanedOperations()).rejects.toMatchObject({ code: "runtime_workspace_required" });
    await expect(readFile(path.join(external, "op_operations_root.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects startup and clears its reservation when the initial running receipt cannot be persisted", async () => {
    const adapter = createAdapter({ FAKE_CODEX_MODE: "ignore-term" });
    const attempt = await createWorkspace(adapter, "attempt_initial_receipt");
    const operations = path.join(workspaceDir, "runtime", "operations");
    await mkdir(path.join(operations, "op_initial_receipt.json"), { recursive: true });

    const started = await Promise.allSettled([adapter.startOperation({ invocation: invocation(attempt, "op_initial_receipt"), attempt_workspace: attempt, timeout_ms: 1_000 })]);
    if (started[0]?.status === "fulfilled") {
      await started[0].value.cancel();
      await started[0].value.result;
    }

    expect(started[0]?.status).toBe("rejected");
    await expect(adapter.cancelOperation("op_initial_receipt")).rejects.toMatchObject({ code: "operation_not_found" });
  });

  it("returns a succeeded AdapterResult for valid fake JSONL without committing formal run facts", async () => {
    const adapter = createAdapter();
    const attempt = await createWorkspace(adapter);
    const handle = await adapter.startOperation({ invocation: invocation(attempt), attempt_workspace: attempt });

    await expect(handle.result).resolves.toMatchObject({ status: "succeeded", operation_id: "op_001", attempt_id: attempt.attempt_id, artifact_descriptors: [] });
    await expect(readFile(path.join(workspaceDir, "runs", "run_001", "attempts.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps non-zero exits, invalid JSONL, and bounded stdout/stderr violations to terminal results", async () => {
    for (const [mode, status, code] of [["nonzero", "failed", "process_exit_nonzero"], ["invalid-jsonl", "failed", "invalid_adapter_output"], ["huge-output", "aborted", "adapter_output_too_large"], ["huge-stderr", "aborted", "adapter_output_too_large"]] as const) {
      const adapter = createAdapter({ FAKE_CODEX_MODE: mode });
      const attempt = await createWorkspace(adapter, `attempt_${mode}`);
      const handle = await adapter.startOperation({ invocation: invocation(attempt, `op_${mode}`), attempt_workspace: attempt });
      await expect(handle.result).resolves.toMatchObject({ status, error: { code } });
    }
  });

  it("reserves an operation id before asynchronous startup so concurrent dispatch has one owner", async () => {
    const adapter = createAdapter({ FAKE_CODEX_MODE: "ignore-term" });
    const attempt = await createWorkspace(adapter, "attempt_operation_conflict");
    const input = { invocation: invocation(attempt, "op_conflict"), attempt_workspace: attempt, timeout_ms: 1_000 };
    const attempts = await Promise.allSettled([adapter.startOperation(input), adapter.startOperation(input)]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected" && result.reason instanceof CodexCliAdapterError && result.reason.code === "operation_conflict")).toHaveLength(1);
    const handle = attempts.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof adapter.startOperation>>> => result.status === "fulfilled")?.value;
    await handle?.cancel();
    await handle?.result;
  });

  it("terminates timed out work after SIGTERM/SIGKILL grace and reports timed_out", async () => {
    const adapter = createAdapter({ FAKE_CODEX_MODE: "ignore-term" });
    const attempt = await createWorkspace(adapter, "attempt_timeout");
    const handle = await adapter.startOperation({ invocation: invocation(attempt, "op_timeout"), attempt_workspace: attempt, timeout_ms: 20 });

    await expect(handle.result).resolves.toMatchObject({ status: "timed_out", error: { code: "process_timeout", recoverable: true } });
  });

  it("cancels an active operation idempotently", async () => {
    const adapter = createAdapter({ FAKE_CODEX_MODE: "ignore-term" });
    const attempt = await createWorkspace(adapter, "attempt_cancel");
    const handle = await adapter.startOperation({ invocation: invocation(attempt, "op_cancel"), attempt_workspace: attempt, timeout_ms: 1_000 });

    expect(adapter.listActiveOperations("run_001")).toEqual([
      expect.objectContaining({ operation_id: "op_cancel", node_run_id: "nr_001", adapter_id: "codex-cli-real", status: "running" })
    ]);
    await expect(handle.cancel()).resolves.toBe("cancelled");
    await expect(adapter.cancelOperation("op_cancel")).resolves.toBe("already_finished");
    await expect(handle.result).resolves.toMatchObject({ status: "cancelled", error: { code: "operation_cancelled", recoverable: false } });
    expect(adapter.listActiveOperations("run_001")).toEqual([]);
  });

  it("continues cancellation and timeout signalling when operation receipt writes fail", async () => {
    for (const mode of ["cancel", "timeout"] as const) {
      const adapter = createAdapter({ FAKE_CODEX_MODE: "ignore-term" });
      const attempt = await createWorkspace(adapter, `attempt_receipt_${mode}`);
      const handle = await adapter.startOperation({ invocation: invocation(attempt, `op_receipt_${mode}`), attempt_workspace: attempt, timeout_ms: mode === "timeout" ? 20 : 1_000 });
      const operationDir = path.join(workspaceDir, "runtime", "operations");
      await rm(operationDir, { recursive: true, force: true });
      await writeFile(operationDir, "receipt writes blocked", "utf8");

      try {
        if (mode === "cancel") await expect(handle.cancel()).resolves.toBe("cancelled");
        await expect(Promise.race([handle.result, wait(250).then(() => "timed_out_wait")])).resolves.toMatchObject({ status: mode === "cancel" ? "cancelled" : "timed_out" });
      } finally {
        if (handle.pid > 0) {
          try {
            process.kill(-handle.pid, "SIGKILL");
          } catch {
            // The adapter already terminated this test process group.
          }
        }
        await rm(operationDir, { recursive: true, force: true });
      }
    }
  });

  it("marks an orphaned persisted operation unknown without inferring success from output files", async () => {
    const adapter = createAdapter();
    const operationDir = path.join(workspaceDir, "runtime", "operations");
    await mkdir(operationDir, { recursive: true });
    await writeFile(path.join(operationDir, "op_orphan.json"), JSON.stringify({
      operation_id: "op_orphan",
      attempt_id: "attempt_orphan",
      node_run_id: "nr_orphan",
      pid: 999_999_999,
      status: "running",
      started_at: "2026-07-13T08:00:00.000Z"
    }), "utf8");

    await expect(adapter.recoverOrphanedOperations()).resolves.toEqual(["op_orphan"]);
    expect(JSON.parse(await readFile(path.join(operationDir, "op_orphan.json"), "utf8"))).toMatchObject({ status: "unknown", error: { code: "orphaned_operation" } });
  });
});

describe("CodexCliAdapter health timeouts", () => {
  it("terminates a slow health command at the configured fixed timeout", async () => {
    const slowHealth = path.join(tempRoot, "slow-health.mjs");
    await writeFile(slowHealth, `
      const args = process.argv.slice(2);
      if (args[0] === "--version") {
        setTimeout(() => process.stdout.write("codex-cli 0.142.1\\n"), 80);
      } else {
        process.stdout.write("Authenticated\\n");
      }
    `, "utf8");
    const adapter = new CodexCliAdapter({ repository_root: repoRoot, workspace_dir: workspaceDir, executable_path: process.execPath, command_prefix_args: [slowHealth], health_timeout_ms: 10 });

    await expect(adapter.refreshHealth()).resolves.toMatchObject({ status: "degraded", authenticated: false, reasons: ["version_check_timeout"] });
  });
});
