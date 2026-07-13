import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

async function createWorkspace(adapter = createAdapter(), attemptId = "attempt_001"): Promise<AttemptWorkspace> {
  return adapter.createAttemptWorkspace({
    attempt_id: attemptId,
    input_files: [{ source_path: path.join(sourceDir, "brief.md"), target_path: "brief.md" }],
    allowed_input_roots: [sourceDir],
    output_schema: { type: "object", properties: {} }
  });
}

function invocation(attempt: AttemptWorkspace, operationId = "op_001") {
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
  it("rejects an invocation whose declared workspace is not the canonical attempt path", async () => {
    const adapter = createAdapter();
    const attempt = await createWorkspace(adapter, "attempt_canonical");
    const invalidInvocation = invocation(attempt, "op_canonical");
    invalidInvocation.runtime_control.attempt_workspace = path.join(attempt.root_dir, "work");

    await expect(adapter.startOperation({ invocation: invalidInvocation, attempt_workspace: attempt })).rejects.toMatchObject({ code: "workspace_escape_detected" });
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

    await expect(handle.cancel()).resolves.toBe("cancelled");
    await expect(adapter.cancelOperation("op_cancel")).resolves.toBe("already_finished");
    await expect(handle.result).resolves.toMatchObject({ status: "cancelled", error: { code: "operation_cancelled", recoverable: false } });
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
