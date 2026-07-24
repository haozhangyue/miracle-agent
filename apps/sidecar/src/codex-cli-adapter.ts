import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterInvocation, AdapterResult } from "@miracle/core";

const adapterId = "codex-cli-real" as const;
const maxHealthOutputBytes = 8 * 1024;
const defaultHealthTimeoutMs = 5_000;

export interface CodexCliHealth {
  adapter_id: typeof adapterId;
  status: "healthy" | "blocked" | "degraded";
  executable_path?: string;
  version?: string;
  authenticated: boolean;
  reasons: string[];
  checked_at: string;
}

export interface AttemptWorkspace {
  attempt_id: string;
  root_dir: string;
  input_dir: string;
  work_dir: string;
  output_dir: string;
  meta_dir: string;
  frozen_input_hashes?: Array<{ target_path: string; expected_hash: string }>;
}

export interface CodexProcessHandle {
  operation_id: string;
  pid: number;
  cancel(): Promise<"cancelled" | "already_finished">;
  result: Promise<AdapterResult>;
}

export interface CodexCliAdapterOptions {
  workspace_dir: string;
  repository_root?: string;
  executable_path?: string;
  command_prefix_args?: string[];
  execution_environment?: Record<string, string | undefined>;
  max_output_bytes?: number;
  terminate_grace_ms?: number;
  health_timeout_ms?: number;
  now?: () => string;
}

export class CodexCliAdapterError extends Error {
  constructor(
    public readonly code:
      | "input_path_not_allowed"
      | "input_hash_mismatch"
      | "attempt_workspace_conflict"
      | "workspace_escape_detected"
      | "runtime_workspace_required"
      | "invalid_attempt_id"
      | "invalid_operation_id"
      | "operation_conflict"
      | "operation_not_found",
    message: string
  ) {
    super(message);
  }
}

type OperationReceipt = {
  operation_id: string;
  attempt_id: string;
  node_run_id: string;
  pid: number;
  status: "running" | "cancel_requested" | "succeeded" | "failed" | "timed_out" | "cancelled" | "aborted" | "unknown";
  started_at: string;
  completed_at?: string;
  error?: { code: string; recoverable: boolean };
};

type ActiveOperation = {
  child: ChildProcessWithoutNullStreams;
  invocation: AdapterInvocation;
  attempt: AttemptWorkspace;
  startedAt: string;
  settled: boolean;
  intent?: "cancelled" | "timed_out" | "aborted";
  stdout: string;
  stdoutBytes: number;
  stderrBytes: number;
  events: Array<Record<string, unknown>>;
  resolve: (result: AdapterResult) => void;
  result: Promise<AdapterResult>;
  timeout?: NodeJS.Timeout;
  terminate?: NodeJS.Timeout;
  startup_pending: boolean;
  pending_error?: Error;
  pending_close?: number | null;
};

function isSafeId(value: string) {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function isSafeOperationId(value: string) {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeBasename(value: string) {
  return path.basename(value).replace(/[^A-Za-z0-9._-]/g, "_");
}

function hashIdentifier(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function outputForError(error: unknown) {
  return error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 240) : "Codex CLI process failed";
}

export class CodexCliAdapter {
  private readonly executablePath: string;
  private readonly maxOutputBytes: number;
  private readonly terminateGraceMs: number;
  private readonly healthTimeoutMs: number;
  private readonly now: () => string;
  private readonly operations = new Map<string, ActiveOperation>();
  private readonly operationReservations = new Set<string>();
  private health?: CodexCliHealth;

  constructor(private readonly options: CodexCliAdapterOptions) {
    this.executablePath = options.executable_path ?? "codex";
    this.maxOutputBytes = options.max_output_bytes ?? 256 * 1024;
    this.terminateGraceMs = options.terminate_grace_ms ?? 1_000;
    this.healthTimeoutMs = options.health_timeout_ms ?? defaultHealthTimeoutMs;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async getHealth() {
    return this.health ?? this.refreshHealth();
  }

  async refreshHealth(): Promise<CodexCliHealth> {
    const checkedAt = this.now();
    let versionRun: CommandResult;
    try {
      versionRun = await this.runCommand(["--version"]);
    } catch (error) {
      this.health = {
        adapter_id: adapterId,
        status: "blocked",
        authenticated: false,
        reasons: ["runtime_not_found"],
        checked_at: checkedAt
      };
      return this.health;
    }
    if (versionRun.exit_code !== 0 || versionRun.output_limited || versionRun.timed_out) {
      this.health = {
        adapter_id: adapterId,
        status: "degraded",
        executable_path: safeBasename(this.executablePath),
        authenticated: false,
        reasons: [versionRun.timed_out ? "version_check_timeout" : "version_check_failed"],
        checked_at: checkedAt
      };
      return this.health;
    }
    const version = versionRun.stdout.match(/\d+(?:\.\d+){1,3}/)?.[0];
    const login = await this.runCommand(["login", "status"]).catch(() => undefined);
    if (login?.timed_out) {
      this.health = {
        adapter_id: adapterId,
        status: "degraded",
        executable_path: safeBasename(this.executablePath),
        ...(version ? { version } : {}),
        authenticated: false,
        reasons: ["login_status_check_timeout"],
        checked_at: checkedAt
      };
      return this.health;
    }
    const authenticated = Boolean(login && !login.output_limited && login.exit_code === 0);
    this.health = {
      adapter_id: adapterId,
      status: authenticated ? "healthy" : "blocked",
      executable_path: safeBasename(this.executablePath),
      ...(version ? { version } : {}),
      authenticated,
      reasons: authenticated ? [] : [login?.output_limited ? "login_status_check_failed" : "credential_missing"],
      checked_at: checkedAt
    };
    return this.health;
  }

  async createAttemptWorkspace(input: {
    attempt_id: string;
    input_files: Array<{ source_path: string; target_path: string; expected_hash?: string }>;
    allowed_input_roots: string[];
    output_schema?: unknown;
  }): Promise<AttemptWorkspace> {
    if (!isSafeId(input.attempt_id)) throw new CodexCliAdapterError("invalid_attempt_id", "attempt_id may only contain letters, numbers, underscore and hyphen");
    const attemptsRoot = await this.ensureRuntimeRoot();
    const rootDir = path.join(attemptsRoot, input.attempt_id);
    try {
      await mkdir(rootDir, { recursive: false, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const entry = await lstat(rootDir);
        if (entry.isSymbolicLink() || !entry.isDirectory()) throw new CodexCliAdapterError("runtime_workspace_required", "Canonical attempt workspace must be a real directory");
        throw new CodexCliAdapterError("attempt_workspace_conflict", `Attempt workspace already exists: ${input.attempt_id}`);
      }
      throw error;
    }
    const [attemptEntry, attemptRoot] = await Promise.all([lstat(rootDir), realpath(rootDir)]);
    const attemptsReal = await realpath(attemptsRoot);
    if (attemptEntry.isSymbolicLink() || !attemptEntry.isDirectory() || !isWithin(attemptsReal, attemptRoot)) {
      await rm(rootDir, { recursive: true, force: true });
      throw new CodexCliAdapterError("runtime_workspace_required", "Canonical attempt workspace escapes the verified runtime root");
    }
    const attempt: AttemptWorkspace = {
      attempt_id: input.attempt_id,
      root_dir: rootDir,
      input_dir: path.join(rootDir, "input"),
      work_dir: path.join(rootDir, "work"),
      output_dir: path.join(rootDir, "output"),
      meta_dir: path.join(rootDir, "meta")
    };
    try {
      await Promise.all([mkdir(attempt.input_dir, { mode: 0o700 }), mkdir(attempt.work_dir, { mode: 0o700 }), mkdir(attempt.output_dir, { mode: 0o700 }), mkdir(attempt.meta_dir, { mode: 0o700 })]);
      const allowedRoots = await Promise.all(input.allowed_input_roots.map(async (root) => realpath(root)));
      const frozenInputHashes: Array<{ target_path: string; expected_hash: string }> = [];
      for (const file of input.input_files) {
        const frozen = await this.stageInput(attempt, file, allowedRoots);
        if (frozen) frozenInputHashes.push(frozen);
      }
      attempt.frozen_input_hashes = frozenInputHashes;
      if (input.output_schema !== undefined) await writeFile(path.join(attempt.meta_dir, "output.schema.json"), `${JSON.stringify(input.output_schema, null, 2)}\n`, { mode: 0o600 });
      await this.writeAttemptMetadata(attempt, "prepared");
      return attempt;
    } catch (error) {
      await rm(rootDir, { recursive: true, force: true });
      throw error;
    }
  }

  async resolveOutputPath(attempt: AttemptWorkspace, outputPath: string) {
    const root = path.resolve(attempt.output_dir);
    const resolved = path.resolve(root, outputPath);
    if (!isWithin(root, resolved)) throw new CodexCliAdapterError("workspace_escape_detected", "Output path escapes the attempt output directory");
    return resolved;
  }

  async validateOutputFile(attempt: AttemptWorkspace, outputPath: string) {
    const outputRoot = await realpath(attempt.output_dir);
    const outputRootStat = await lstat(attempt.output_dir);
    if (outputRootStat.isSymbolicLink()) throw new CodexCliAdapterError("workspace_escape_detected", "Attempt output directory may not be a symbolic link");
    const target = await this.resolveOutputPath(attempt, outputPath);
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.nlink !== 1) {
      throw new CodexCliAdapterError("workspace_escape_detected", "Output must be a single-link regular file inside the attempt output directory");
    }
    const resolvedTarget = await realpath(target);
    if (!isWithin(outputRoot, resolvedTarget)) throw new CodexCliAdapterError("workspace_escape_detected", "Output file escapes the attempt output directory");
    return target;
  }

  async cleanupAttemptWorkspace(attempt: AttemptWorkspace) {
    if (Array.from(this.operations.values()).some((operation) => operation.attempt.attempt_id === attempt.attempt_id && !operation.settled)) {
      throw new CodexCliAdapterError("operation_conflict", "Cannot clean an active attempt workspace");
    }
    if (!isSafeId(attempt.attempt_id)) return;
    try {
      const canonicalAttempt = await this.canonicalAttemptWorkspace(attempt.attempt_id, attempt.frozen_input_hashes);
      if (path.resolve(attempt.root_dir) !== canonicalAttempt.root_dir) return;
      await this.writeAttemptMetadata(canonicalAttempt, "retained");
    } catch {
      // A rejected attempt may no longer have a safe metadata directory to retain.
    }
  }

  async startOperation(input: { invocation: AdapterInvocation; attempt_workspace: AttemptWorkspace; timeout_ms?: number; prompt?: string }): Promise<CodexProcessHandle> {
    const { invocation, attempt_workspace: attempt } = input;
    if (!isSafeId(invocation.attempt_id)) throw new CodexCliAdapterError("invalid_attempt_id", "attempt_id may only contain letters, numbers, underscore and hyphen");
    if (!isSafeOperationId(invocation.operation_id)) throw new CodexCliAdapterError("invalid_operation_id", "operation_id may only contain letters, numbers, underscore and hyphen");
    if (this.operations.has(invocation.operation_id) || this.operationReservations.has(invocation.operation_id)) throw new CodexCliAdapterError("operation_conflict", `Operation already exists: ${invocation.operation_id}`);
    this.operationReservations.add(invocation.operation_id);
    try {
      let canonicalAttempt = await this.verifyCanonicalAttemptWorkspace(invocation, attempt);
      await this.verifyFrozenInputHashes(canonicalAttempt);
      canonicalAttempt = await this.verifyCanonicalAttemptWorkspace(invocation, canonicalAttempt);
      await this.verifyFrozenInputHashes(canonicalAttempt);

      const child = spawn(this.executablePath, [
        ...(this.options.command_prefix_args ?? []),
        "exec",
        "--json",
        "--ephemeral",
        "--sandbox",
        invocation.runtime_control.sandbox,
        "--cd",
        canonicalAttempt.work_dir,
        "--skip-git-repo-check",
        "--output-schema",
        path.join(canonicalAttempt.meta_dir, "output.schema.json"),
        "--output-last-message",
        path.join(canonicalAttempt.output_dir, "final.json"),
        "-"
      ], {
        cwd: canonicalAttempt.work_dir,
        env: this.childEnvironment(),
        detached: process.platform !== "win32",
        shell: false,
        stdio: "pipe"
      });
      let resolve!: (result: AdapterResult) => void;
      const result = new Promise<AdapterResult>((done) => {
        resolve = done;
      });
      const operation: ActiveOperation = {
        child,
        invocation,
        attempt: canonicalAttempt,
        startedAt: this.now(),
        settled: false,
        stdout: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        events: [],
        resolve,
        result,
        startup_pending: true
      };
      child.stdout.on("data", (chunk: Buffer) => this.consumeStdio(operation, chunk, "stdout"));
      child.stderr.on("data", (chunk: Buffer) => this.consumeStdio(operation, chunk, "stderr"));
      child.on("error", (error) => this.handleProcessError(operation, error));
      child.on("close", (code) => void this.handleClose(operation, code));
      try {
        await this.writeOperationReceipt({
          operation_id: invocation.operation_id,
          attempt_id: invocation.attempt_id,
          node_run_id: invocation.node_run_id,
          pid: child.pid ?? -1,
          status: "running",
          started_at: operation.startedAt
        });
      } catch (error) {
        operation.startup_pending = false;
        this.signalProcessGroup(child, "SIGTERM");
        operation.terminate = setTimeout(() => this.signalProcessGroup(child, "SIGKILL"), this.terminateGraceMs);
        this.operations.delete(invocation.operation_id);
        this.flushPendingProcessEvents(operation);
        throw error;
      }
      operation.startup_pending = false;
      this.operations.set(invocation.operation_id, operation);
      this.operationReservations.delete(invocation.operation_id);
      const handle: CodexProcessHandle = {
        operation_id: invocation.operation_id,
        pid: child.pid ?? -1,
        cancel: () => this.cancelOperation(invocation.operation_id),
        result
      };
      if (this.flushPendingProcessEvents(operation)) return handle;
      child.stdin.end(input.prompt ?? "P6-06 fake lifecycle probe only. Do not execute a content task.\n");
      const timeoutMs = input.timeout_ms ?? invocation.runtime_control.timeout_ms;
      operation.timeout = setTimeout(() => void this.requestTermination(operation, "timed_out"), timeoutMs);

      return handle;
    } catch (error) {
      this.operationReservations.delete(invocation.operation_id);
      throw error;
    }
  }

  async cancelOperation(operationId: string): Promise<"cancelled" | "already_finished"> {
    const operation = this.operations.get(operationId);
    if (!operation) {
      const receipt = await this.readOperationReceipt(operationId);
      if (receipt) return "already_finished";
      throw new CodexCliAdapterError("operation_not_found", `Operation not found: ${operationId}`);
    }
    if (operation.settled || operation.intent) return "already_finished";
    await this.requestTermination(operation, "cancelled");
    return "cancelled";
  }

  listActiveOperations(runId?: string) {
    return Array.from(this.operations.values())
      .filter((operation) => !operation.settled && (!runId || operation.invocation.run_id === runId))
      .map((operation) => ({
        operation_id: operation.invocation.operation_id,
        attempt_id: operation.invocation.attempt_id,
        run_id: operation.invocation.run_id,
        node_run_id: operation.invocation.node_run_id,
        adapter_id: operation.invocation.adapter_id,
        provider: operation.invocation.provider,
        status: operation.intent === "cancelled" ? "cancel_requested" : "running",
        started_at: operation.startedAt
      }));
  }

  async recoverOrphanedOperations() {
    const root = await this.ensureOperationsRoot();
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return [];
    }
    const recovered: string[] = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      let receipt: OperationReceipt;
      try {
        receipt = JSON.parse(await readFile(path.join(root, name), "utf8")) as OperationReceipt;
      } catch {
        continue;
      }
      if (!isSafeOperationId(receipt.operation_id) || name !== `${receipt.operation_id}.json`) continue;
      if (receipt.status !== "running" && receipt.status !== "cancel_requested") continue;
      if (this.operations.has(receipt.operation_id)) continue;
      receipt.status = "unknown";
      receipt.completed_at = this.now();
      receipt.error = { code: "orphaned_operation", recoverable: true };
      await this.safeWriteOperationReceipt(receipt);
      recovered.push(receipt.operation_id);
    }
    return recovered;
  }

  private async stageInput(attempt: AttemptWorkspace, file: { source_path: string; target_path: string; expected_hash?: string }, allowedRoots: string[]) {
    const sourceEntry = await lstat(file.source_path);
    if (sourceEntry.isSymbolicLink() || !sourceEntry.isFile()) {
      throw new CodexCliAdapterError("input_path_not_allowed", "Only regular non-symbolic input files may be staged");
    }
    const source = await realpath(file.source_path);
    if (!allowedRoots.some((root) => isWithin(root, source))) {
      throw new CodexCliAdapterError("input_path_not_allowed", "Input path is outside the allowed roots");
    }
    const target = path.resolve(attempt.input_dir, file.target_path);
    if (!isWithin(path.resolve(attempt.input_dir), target)) throw new CodexCliAdapterError("workspace_escape_detected", "Input staging target escapes attempt input directory");
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) throw new CodexCliAdapterError("input_path_not_allowed", "Only regular input files may be staged");
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target);
    const stagedEntry = await lstat(target);
    if (stagedEntry.isSymbolicLink() || !stagedEntry.isFile()) {
      throw new CodexCliAdapterError("workspace_escape_detected", "Staged input must be a regular non-symbolic file");
    }
    if (file.expected_hash) {
      const stagedHash = `sha256:${createHash("sha256").update(await readFile(target)).digest("hex")}`;
      if (stagedHash !== file.expected_hash) {
        throw new CodexCliAdapterError("input_hash_mismatch", "Staged input bytes do not match the frozen artifact hash");
      }
    }
    await chmod(target, 0o444);
    return file.expected_hash ? { target_path: file.target_path, expected_hash: file.expected_hash } : undefined;
  }

  private childEnvironment() {
    const environment: Record<string, string> = {};
    if (process.env.PATH) environment.PATH = process.env.PATH;
    if (process.env.HOME) environment.HOME = process.env.HOME;
    if (process.env.LANG) environment.LANG = process.env.LANG;
    for (const [key, value] of Object.entries(this.options.execution_environment ?? {})) {
      if (value !== undefined) environment[key] = value;
    }
    return environment;
  }

  private consumeStdio(operation: ActiveOperation, chunk: Buffer, stream: "stdout" | "stderr") {
    if (operation.settled) return;
    if (stream === "stdout") operation.stdoutBytes += chunk.length;
    else operation.stderrBytes += chunk.length;
    if (operation.stdoutBytes > this.maxOutputBytes || operation.stderrBytes > this.maxOutputBytes) {
      void this.requestTermination(operation, "aborted", "adapter_output_too_large", false);
      return;
    }
    if (stream === "stdout") operation.stdout += chunk.toString("utf8");
  }

  private async handleClose(operation: ActiveOperation, code: number | null) {
    if (operation.startup_pending) {
      operation.pending_close = code;
      return;
    }
    if (operation.settled) return;
    if (operation.intent === "cancelled") return this.settleOperation(operation, "cancelled", "operation_cancelled", false, "Operation cancelled by user");
    if (operation.intent === "timed_out") return this.settleOperation(operation, "timed_out", "process_timeout", true, "Codex CLI operation timed out");
    if (operation.intent === "aborted") return this.settleOperation(operation, "aborted", "adapter_output_too_large", false, "Codex CLI output exceeded the configured limit");
    if (code !== 0) return this.settleOperation(operation, "failed", "process_exit_nonzero", true, `Codex CLI exited with code ${String(code)}`);
    const parsed = this.parseJsonl(operation.stdout);
    if (!parsed.ok) return this.settleOperation(operation, "failed", "invalid_adapter_output", true, "Codex CLI emitted invalid JSONL");
    operation.events = parsed.events;
    return this.settleOperation(operation, "succeeded");
  }

  private handleProcessError(operation: ActiveOperation, error: Error) {
    if (operation.startup_pending) {
      operation.pending_error = error;
      return;
    }
    void this.settleOperation(operation, "failed", "process_spawn_failed", true, outputForError(error));
  }

  private flushPendingProcessEvents(operation: ActiveOperation) {
    if (operation.pending_error) {
      const error = operation.pending_error;
      operation.pending_error = undefined;
      this.handleProcessError(operation, error);
      return true;
    }
    if (operation.pending_close !== undefined) {
      const code = operation.pending_close;
      operation.pending_close = undefined;
      void this.handleClose(operation, code);
      return true;
    }
    return false;
  }

  private parseJsonl(stdout: string): { ok: true; events: Array<Record<string, unknown>> } | { ok: false } {
    const events: Array<Record<string, unknown>> = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
        events.push(value as Record<string, unknown>);
      } catch {
        return { ok: false };
      }
    }
    return { ok: true, events };
  }

  private async requestTermination(operation: ActiveOperation, intent: "cancelled" | "timed_out" | "aborted", code?: string, recoverable?: boolean) {
    if (operation.settled || operation.intent) return;
    operation.intent = intent;
    try {
      await this.safeWriteOperationReceipt({
        operation_id: operation.invocation.operation_id,
        attempt_id: operation.invocation.attempt_id,
        node_run_id: operation.invocation.node_run_id,
        pid: operation.child.pid ?? -1,
        status: intent === "cancelled" ? "cancel_requested" : intent,
        started_at: operation.startedAt,
        ...(code ? { error: { code, recoverable: Boolean(recoverable) } } : {})
      });
    } finally {
      this.signalProcessGroup(operation.child, "SIGTERM");
      operation.terminate = setTimeout(() => this.signalProcessGroup(operation.child, "SIGKILL"), this.terminateGraceMs);
    }
  }

  private signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
    if (!child.pid) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Fall back to the direct child when process group signalling is unavailable.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // The process has already exited; close handling will settle the operation.
    }
  }

  private async settleOperation(
    operation: ActiveOperation,
    status: AdapterResult["status"],
    errorCode?: string,
    recoverable = false,
    errorMessage?: string
  ) {
    if (operation.settled) return;
    operation.settled = true;
    if (operation.timeout) clearTimeout(operation.timeout);
    if (operation.terminate) clearTimeout(operation.terminate);
    const completedAt = this.now();
    const thread = operation.events.find((event) => event.type === "thread.started" && typeof event.thread_id === "string");
    const result: AdapterResult = {
      operation_id: operation.invocation.operation_id,
      attempt_id: operation.invocation.attempt_id,
      node_run_id: operation.invocation.node_run_id,
      status,
      provider_receipt: {
        provider: operation.invocation.provider,
        adapter_kind: "codex",
        adapter_id: adapterId,
        operation_id: operation.invocation.operation_id,
        raw_receipt_id: `receipt_${operation.invocation.operation_id}`,
        latency_ms: Math.max(0, Date.parse(completedAt) - Date.parse(operation.startedAt)),
        event_count: operation.events.length,
        ...(thread ? { external_session_id: hashIdentifier(String(thread.thread_id)) } : {})
      },
      artifact_descriptors: [],
      ...(errorCode ? { error: { code: errorCode, message: errorMessage ?? errorCode, recoverable } } : {}),
      received_at: completedAt
    };
    await this.safeWriteOperationReceipt({
      operation_id: operation.invocation.operation_id,
      attempt_id: operation.invocation.attempt_id,
      node_run_id: operation.invocation.node_run_id,
      pid: operation.child.pid ?? -1,
      status,
      started_at: operation.startedAt,
      completed_at: completedAt,
      ...(errorCode ? { error: { code: errorCode, recoverable } } : {})
    });
    await this.safeWriteAttemptMetadata(operation.attempt, status);
    this.operations.delete(operation.invocation.operation_id);
    operation.resolve(result);
  }

  private async runCommand(args: string[]): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(this.executablePath, [...(this.options.command_prefix_args ?? []), ...args], { env: this.childEnvironment(), shell: false, stdio: "pipe" });
      let stdout = "";
      let stderrBytes = 0;
      let outputLimited = false;
      let timedOut = false;
      let forceKill: NodeJS.Timeout | undefined;
      const terminate = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // The health-check child already exited.
        }
        forceKill = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // The health-check child already exited.
          }
        }, this.terminateGraceMs);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, this.healthTimeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        const remaining = maxHealthOutputBytes - Buffer.byteLength(stdout);
        if (remaining <= 0) {
          outputLimited = true;
          terminate();
          return;
        }
        if (chunk.length > remaining) outputLimited = true;
        stdout += chunk.toString("utf8").slice(0, remaining);
        if (outputLimited) terminate();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > maxHealthOutputBytes) {
          outputLimited = true;
          terminate();
        }
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        reject(error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        resolve({ exit_code: exitCode ?? 1, stdout, output_limited: outputLimited, timed_out: timedOut });
      });
    });
  }

  private async ensureRuntimeRoot(): Promise<string> {
    return (await this.ensureRuntimePaths()).attempts_root;
  }

  private async ensureOperationsRoot(): Promise<string> {
    const runtime = await this.ensureRuntimePaths();
    return this.ensureVerifiedChildDirectory(runtime.runtime_root, "operations", runtime.workspace_root);
  }

  private async ensureRuntimePaths(): Promise<{ workspace_root: string; runtime_root: string; attempts_root: string }> {
    if (!this.options.repository_root) throw new CodexCliAdapterError("runtime_workspace_required", "A repository root is required before creating an attempt workspace");
    await mkdir(this.options.workspace_dir, { recursive: true, mode: 0o700 });
    const [workspaceEntry, workspaceRoot, repositoryRoot] = await Promise.all([
      lstat(this.options.workspace_dir),
      realpath(this.options.workspace_dir),
      realpath(this.options.repository_root)
    ]);
    if (workspaceEntry.isSymbolicLink() || isWithin(repositoryRoot, workspaceRoot)) {
      throw new CodexCliAdapterError("runtime_workspace_required", "Attempt runtime workspace must be outside the repository and may not be a symbolic link");
    }
    const runtimeRoot = await this.ensureVerifiedChildDirectory(workspaceRoot, "runtime", workspaceRoot);
    const attemptsRoot = await this.ensureVerifiedChildDirectory(runtimeRoot, "attempts", workspaceRoot);
    return { workspace_root: workspaceRoot, runtime_root: runtimeRoot, attempts_root: attemptsRoot };
  }

  private async ensureVerifiedChildDirectory(parent: string, name: string, workspaceRoot: string) {
    const candidate = path.join(parent, name);
    try {
      await mkdir(candidate, { recursive: false, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const [entry, resolved] = await Promise.all([lstat(candidate), realpath(candidate)]);
    if (entry.isSymbolicLink() || !entry.isDirectory() || !isWithin(workspaceRoot, resolved)) {
      throw new CodexCliAdapterError("runtime_workspace_required", `Runtime path segment is not a verified directory: ${name}`);
    }
    return resolved;
  }

  private async verifyCanonicalAttemptWorkspace(invocation: AdapterInvocation, attempt: AttemptWorkspace): Promise<AttemptWorkspace> {
    if (
      attempt.attempt_id !== invocation.attempt_id ||
      path.resolve(attempt.root_dir) !== path.resolve(invocation.runtime_control.attempt_workspace)
    ) {
      throw new CodexCliAdapterError("workspace_escape_detected", "Invocation does not declare the canonical attempt workspace");
    }
    const canonicalAttempt = await this.canonicalAttemptWorkspace(invocation.attempt_id, attempt.frozen_input_hashes);
    if (path.resolve(attempt.root_dir) !== canonicalAttempt.root_dir) {
      throw new CodexCliAdapterError("workspace_escape_detected", "Invocation does not declare the canonical attempt workspace");
    }
    return canonicalAttempt;
  }

  private async canonicalAttemptWorkspace(attemptId: string, frozenInputHashes?: AttemptWorkspace["frozen_input_hashes"]): Promise<AttemptWorkspace> {
    const attemptsRootPath = await this.ensureRuntimeRoot();
    const [attemptsEntry, attemptsRoot] = await Promise.all([lstat(attemptsRootPath), realpath(attemptsRootPath)]);
    if (attemptsEntry.isSymbolicLink() || !attemptsEntry.isDirectory()) {
      throw new CodexCliAdapterError("workspace_escape_detected", "Verified attempts root is no longer a real directory");
    }
    const rootDir = path.resolve(attemptsRoot, attemptId);
    try {
      const [attemptEntry, attemptRoot] = await Promise.all([
        lstat(rootDir),
        realpath(rootDir)
      ]);
      if (
        attemptEntry.isSymbolicLink() ||
        !attemptEntry.isDirectory() ||
        !isWithin(attemptsRoot, attemptRoot)
      ) {
        throw new CodexCliAdapterError("workspace_escape_detected", "Canonical attempt workspace is no longer anchored to the verified attempts root");
      }
      const children = await Promise.all(([
        ["input_dir", "input"],
        ["work_dir", "work"],
        ["meta_dir", "meta"],
        ["output_dir", "output"]
      ] as const).map(async ([key, name]) => {
        const candidate = path.join(rootDir, name);
        const [entry, resolved] = await Promise.all([lstat(candidate), realpath(candidate)]);
        if (entry.isSymbolicLink() || !entry.isDirectory() || !isWithin(attemptRoot, resolved)) {
          throw new CodexCliAdapterError("workspace_escape_detected", `Canonical attempt ${name} directory is invalid`);
        }
        return [key, resolved] as const;
      }));
      return {
        attempt_id: attemptId,
        root_dir: attemptRoot,
        input_dir: children.find(([key]) => key === "input_dir")![1],
        work_dir: children.find(([key]) => key === "work_dir")![1],
        meta_dir: children.find(([key]) => key === "meta_dir")![1],
        output_dir: children.find(([key]) => key === "output_dir")![1],
        frozen_input_hashes: frozenInputHashes
      };
    } catch (error) {
      if (error instanceof CodexCliAdapterError) throw error;
      throw new CodexCliAdapterError("workspace_escape_detected", "Canonical attempt workspace is unavailable or invalid");
    }
  }

  private async verifyFrozenInputHashes(attempt: AttemptWorkspace) {
    for (const frozen of attempt.frozen_input_hashes ?? []) {
      const [inputEntry, inputRoot] = await Promise.all([lstat(attempt.input_dir), realpath(attempt.input_dir)]);
      if (inputEntry.isSymbolicLink() || !inputEntry.isDirectory() || inputRoot !== attempt.input_dir) {
        throw new CodexCliAdapterError("workspace_escape_detected", "Canonical attempt input directory is invalid");
      }
      const stagedPath = path.resolve(inputRoot, frozen.target_path);
      if (!isWithin(inputRoot, stagedPath)) throw new CodexCliAdapterError("workspace_escape_detected", "Input path escapes the attempt input directory");
      const entry = await lstat(stagedPath);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new CodexCliAdapterError("workspace_escape_detected", "Staged frozen input must remain a regular non-symbolic file");
      }
      const canonicalFile = await realpath(stagedPath);
      if (!isWithin(inputRoot, canonicalFile)) {
        throw new CodexCliAdapterError("workspace_escape_detected", "Staged frozen input escapes the canonical attempt input directory");
      }
      const canonicalEntry = await lstat(canonicalFile);
      if (canonicalEntry.isSymbolicLink() || !canonicalEntry.isFile()) {
        throw new CodexCliAdapterError("workspace_escape_detected", "Canonical staged frozen input must remain a regular non-symbolic file");
      }
      const stagedHash = `sha256:${createHash("sha256").update(await readFile(canonicalFile)).digest("hex")}`;
      if (stagedHash !== frozen.expected_hash) {
        throw new CodexCliAdapterError("input_hash_mismatch", "Staged input bytes changed after verification");
      }
    }
  }

  private async writeAttemptMetadata(attempt: AttemptWorkspace, status: string) {
    await writeFile(path.join(attempt.meta_dir, "attempt.json"), `${JSON.stringify({ attempt_id: attempt.attempt_id, status, updated_at: this.now() }, null, 2)}\n`, { mode: 0o600 });
  }

  private async safeWriteAttemptMetadata(attempt: AttemptWorkspace, status: string) {
    try {
      await this.writeAttemptMetadata(attempt, status);
    } catch {
      // Process lifecycle must resolve even when the local receipt store is unavailable.
    }
  }

  private async writeOperationReceipt(receipt: OperationReceipt) {
    const dir = await this.ensureOperationsRoot();
    const target = this.operationReceiptPath(dir, receipt.operation_id);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  private async safeWriteOperationReceipt(receipt: OperationReceipt) {
    try {
      await this.writeOperationReceipt(receipt);
    } catch {
      // Receipt persistence is audit best-effort and cannot block termination or result delivery.
    }
  }

  private operationReceiptPath(operationsRoot: string, operationId: string) {
    if (!isSafeOperationId(operationId)) throw new CodexCliAdapterError("invalid_operation_id", "operation_id may only contain letters, numbers, underscore and hyphen");
    const target = path.resolve(operationsRoot, `${operationId}.json`);
    if (!isWithin(operationsRoot, target)) throw new CodexCliAdapterError("workspace_escape_detected", "Operation receipt path escapes the verified operations root");
    return target;
  }

  private async readOperationReceipt(operationId: string) {
    if (!isSafeOperationId(operationId)) throw new CodexCliAdapterError("invalid_operation_id", "operation_id may only contain letters, numbers, underscore and hyphen");
    const operationsRoot = await this.ensureOperationsRoot();
    try {
      return JSON.parse(await readFile(this.operationReceiptPath(operationsRoot, operationId), "utf8")) as OperationReceipt;
    } catch {
      return undefined;
    }
  }
}

type CommandResult = { exit_code: number; stdout: string; output_limited: boolean; timed_out: boolean };
