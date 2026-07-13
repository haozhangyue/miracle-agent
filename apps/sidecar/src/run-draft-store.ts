import {
  RunDraftError,
  cancelRunDraft,
  canonicalPlanHash,
  confirmRunDraft,
  createRunDraft,
  createRunDraftDryRunPlan,
  createWorkflowSnapshotDraft,
  refreshRunDraftWorkflowSource,
  reviseRunDraft,
  updateRunDraft,
  type CredentialScope,
  type LaunchConfirmation,
  type RunDraft,
  type RunDraftDryRunPlan,
  type WorkflowSnapshotDraft,
  type WorkflowSpec
} from "@miracle/core";
import { access, appendFile, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type PendingPlan = { draft_id: string; status: "not_generated" };
type PendingConfirmation = { draft_id: string; decision: "pending" };

export class RunDraftStoreError extends Error {
  constructor(
    public readonly code:
      | "draft_not_found"
      | "workflow_not_found"
      | "revision_conflict"
      | "adapter_not_ready"
      | "launch_handoff_required"
      | "invalid_draft_id"
      | "invalid_workflow_id"
      | "draft_already_exists"
      | "draft_state_invalid"
      | "draft_lock_timeout",
    message: string
  ) {
    super(message);
  }
}

export interface RunDraftStoreOptions {
  workspace_dir: string;
  workflows_dir: string;
  now?: () => string;
}

export interface RunDraftBundle {
  draft: RunDraft;
  snapshot: WorkflowSnapshotDraft;
  plan?: RunDraftDryRunPlan;
  confirmation?: LaunchConfirmation;
  audit: RunDraftAuditRecord[];
}

export interface RunDraftAuditRecord {
  type: "run_draft_created" | "run_draft_updated" | "dry_run_generated" | "launch_confirmation_recorded" | "run_draft_cancelled";
  draft_id: string;
  actor: string;
  timestamp: string;
  previous_hash?: string;
  next_hash?: string;
  changed_fields: string[];
  correlation_id: string;
}

function isPlan(value: unknown): value is RunDraftDryRunPlan {
  return Boolean(value && typeof value === "object" && "plan_hash" in value && typeof (value as { plan_hash?: unknown }).plan_hash === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function invalidState(message: string): never {
  throw new RunDraftStoreError("draft_state_invalid", message);
}

function isConfirmation(value: unknown): value is LaunchConfirmation {
  return Boolean(value && typeof value === "object" && "confirmation_id" in value && typeof (value as { confirmation_id?: unknown }).confirmation_id === "string");
}

function assertDraftId(draftId: string) {
  if (!/^rundraft_[a-zA-Z0-9_-]+$/.test(draftId)) {
    throw new RunDraftStoreError("invalid_draft_id", `Invalid RunDraft id: ${draftId}`);
  }
}

function assertWorkflowId(workflowId: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(workflowId)) {
    throw new RunDraftStoreError("invalid_workflow_id", `Invalid workflow id: ${workflowId}`);
  }
}

export class RunDraftStore {
  constructor(private readonly options: RunDraftStoreOptions) {}

  private now() {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private draftDir(draftId: string) {
    assertDraftId(draftId);
    return path.join(this.options.workspace_dir, "run-drafts", draftId);
  }

  private lockDir(draftId: string) {
    assertDraftId(draftId);
    return path.join(this.options.workspace_dir, "run-drafts", `.${draftId}.lock`);
  }

  private async readJson<T>(target: string): Promise<T> {
    try {
      return JSON.parse(await readFile(target, "utf8")) as T;
    } catch (error) {
      if (error instanceof SyntaxError) invalidState(`Invalid JSON in ${path.basename(target)}: ${error.message}`);
      throw error;
    }
  }

  private async writeJson(target: string, value: unknown) {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  private async withDraftLock<T>(draftId: string, operation: () => Promise<T>): Promise<T> {
    const lockDir = this.lockDir(draftId);
    const deadline = Date.now() + 5_000;
    await mkdir(path.dirname(lockDir), { recursive: true });
    while (true) {
      try {
        await mkdir(lockDir);
        break;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new RunDraftStoreError("draft_lock_timeout", `RunDraft lock timed out: ${draftId}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  }

  private paths(draftId: string) {
    const directory = this.draftDir(draftId);
    return {
      directory,
      draft: path.join(directory, "run_draft.json"),
      snapshot: path.join(directory, "workflow_snapshot_draft.json"),
      plan: path.join(directory, "run_draft_dry_run_plan.json"),
      confirmation: path.join(directory, "launch_confirmation.json"),
      audit: path.join(directory, "draft_audit.jsonl")
    };
  }

  private async readWorkflow(workflowId: string): Promise<WorkflowSpec> {
    try {
      assertWorkflowId(workflowId);
      const workflowRoot = await realpath(this.options.workflows_dir);
      const candidate = path.resolve(workflowRoot, `${workflowId}.json`);
      if (!candidate.startsWith(`${workflowRoot}${path.sep}`)) {
        throw new RunDraftStoreError("invalid_workflow_id", `Workflow path escapes registry: ${workflowId}`);
      }
      const resolved = await realpath(candidate);
      if (!resolved.startsWith(`${workflowRoot}${path.sep}`)) {
        throw new RunDraftStoreError("invalid_workflow_id", `Workflow path resolves outside registry: ${workflowId}`);
      }
      return await this.readJson<WorkflowSpec>(resolved);
    } catch (error) {
      if (error instanceof RunDraftStoreError) throw error;
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new RunDraftStoreError("workflow_not_found", `Workflow not found: ${workflowId}`);
      }
      throw error;
    }
  }

  private async appendAudit(input: {
    draft: RunDraft;
    actor: string;
    type: "run_draft_created" | "run_draft_updated" | "dry_run_generated" | "launch_confirmation_recorded" | "run_draft_cancelled";
    previous_hash?: string;
    next_hash?: string;
    changed_fields: string[];
  }) {
    const record: RunDraftAuditRecord = {
      type: input.type,
      draft_id: input.draft.draft_id,
      actor: input.actor,
      timestamp: this.now(),
      previous_hash: input.previous_hash,
      next_hash: input.next_hash,
      changed_fields: input.changed_fields,
      correlation_id: `${input.draft.draft_id}:${input.draft.revision}:${input.type}`
    };
    await appendFile(this.paths(input.draft.draft_id).audit, `${JSON.stringify(record)}\n`, "utf8");
  }

  private assertRevision(draft: RunDraft, expectedRevision: number) {
    if (draft.revision !== expectedRevision) {
      throw new RunDraftStoreError("revision_conflict", `Expected revision ${expectedRevision}, found ${draft.revision}.`);
    }
  }

  private validateDraft(value: unknown): RunDraft {
    if (!isRecord(value)) invalidState("run_draft.json must be an object");
    const draft = value as Partial<RunDraft>;
    if (typeof draft.draft_id !== "string" || typeof draft.workflow_id !== "string" || typeof draft.workflow_source_hash !== "string" || !Number.isInteger(draft.revision) || (draft.revision ?? 0) < 1 || !isRecord(draft.inputs)) {
      invalidState("run_draft.json is missing required fields");
    }
    assertDraftId(draft.draft_id);
    assertWorkflowId(draft.workflow_id);
    if (!/^sha256:[a-f0-9]{64}$/.test(draft.workflow_source_hash) || !["draft", "ready_for_dry_run", "ready_for_confirmation", "confirmed", "launch_pending", "converted", "cancelled", "expired"].includes(String(draft.status))) {
      invalidState("run_draft.json contains invalid status or workflow hash");
    }
    return value as unknown as RunDraft;
  }

  private validateSnapshot(value: unknown, draft: RunDraft): WorkflowSnapshotDraft {
    if (!isRecord(value) || value.draft_id !== draft.draft_id || value.workflow_source_hash !== draft.workflow_source_hash || !isRecord(value.workflow) || value.workflow.id !== draft.workflow_id || typeof value.snapshot_hash !== "string") {
      invalidState("workflow_snapshot_draft.json does not match run_draft.json");
    }
    return value as unknown as WorkflowSnapshotDraft;
  }

  private validatePlan(value: unknown, draft: RunDraft): RunDraftDryRunPlan | undefined {
    if (!isRecord(value) || value.draft_id !== draft.draft_id) invalidState("run_draft_dry_run_plan.json does not belong to this draft");
    if (value.status === "not_generated") {
      if (Object.keys(value).length !== 2) invalidState("not_generated plan contains unexpected fields");
      return undefined;
    }
    if ((value.status !== "ready_for_confirmation" && value.status !== "ready_for_dry_run") || typeof value.plan_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.plan_hash) || typeof value.draft_plan_id !== "string" || !Array.isArray(value.gate_plan) || !isRecord(value.startability)) {
      invalidState("run_draft_dry_run_plan.json is incomplete");
    }
    return value as unknown as RunDraftDryRunPlan;
  }

  private validateConfirmation(value: unknown, draft: RunDraft): LaunchConfirmation | undefined {
    if (!isRecord(value) || value.draft_id !== draft.draft_id) invalidState("launch_confirmation.json does not belong to this draft");
    if (value.decision === "pending") {
      if (Object.keys(value).length !== 2) invalidState("pending confirmation contains unexpected fields");
      return undefined;
    }
    if ((value.decision !== "confirmed" && value.decision !== "superseded" && value.decision !== "cancelled") || typeof value.confirmation_id !== "string" || typeof value.plan_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.plan_hash) || typeof value.draft_plan_id !== "string") {
      invalidState("launch_confirmation.json is incomplete");
    }
    return value as unknown as LaunchConfirmation;
  }

  private validateAudit(raw: string, draftId: string): RunDraftAuditRecord[] {
    try {
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown)
        .map((value) => {
          if (!isRecord(value) || value.draft_id !== draftId || typeof value.type !== "string" || typeof value.actor !== "string" || typeof value.timestamp !== "string" || !Array.isArray(value.changed_fields) || typeof value.correlation_id !== "string") {
            invalidState("draft_audit.jsonl contains an invalid record");
          }
          return value as unknown as RunDraftAuditRecord;
        });
    } catch (error) {
      if (error instanceof RunDraftStoreError) throw error;
      invalidState(`draft_audit.jsonl contains invalid JSON: ${String(error)}`);
    }
  }

  async create(input: {
    draft_id: string;
    workflow_id: string;
    inputs?: Record<string, unknown>;
    enabled_optional_paths?: string[];
    execution_policy?: RunDraft["execution_policy"];
    actor: string;
  }): Promise<RunDraftBundle> {
    return this.withDraftLock(input.draft_id, async () => {
      const files = this.paths(input.draft_id);
      try {
        await access(files.draft);
        throw new RunDraftStoreError("draft_already_exists", `RunDraft already exists: ${input.draft_id}`);
      } catch (error) {
        if (error instanceof RunDraftStoreError) throw error;
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code !== "ENOENT") throw error;
      }
      const workflow = await this.readWorkflow(input.workflow_id);
      const draft = createRunDraft({
      draft_id: input.draft_id,
      workflow,
      inputs: input.inputs,
      enabled_optional_paths: input.enabled_optional_paths,
      execution_policy: input.execution_policy,
      now: this.now()
    });
      const snapshot = createWorkflowSnapshotDraft({ draft, workflow, now: draft.created_at });
      await this.writeJson(files.draft, draft);
      await this.writeJson(files.snapshot, snapshot);
      await this.writeJson(files.plan, { draft_id: draft.draft_id, status: "not_generated" } satisfies PendingPlan);
      await this.writeJson(files.confirmation, { draft_id: draft.draft_id, decision: "pending" } satisfies PendingConfirmation);
      await this.appendAudit({ draft, actor: input.actor, type: "run_draft_created", next_hash: canonicalPlanHash(draft), changed_fields: ["created"] });
      return { draft, snapshot, audit: [] };
    });
  }

  async read(draftId: string): Promise<RunDraftBundle> {
    return this.readUnlocked(draftId);
  }

  private async readUnlocked(draftId: string): Promise<RunDraftBundle> {
    const files = this.paths(draftId);
    try {
      const [draftValue, snapshotValue, planValue, confirmationValue, auditRaw] = await Promise.all([
        this.readJson<RunDraft>(files.draft),
        this.readJson<WorkflowSnapshotDraft>(files.snapshot),
        this.readJson<unknown>(files.plan),
        this.readJson<unknown>(files.confirmation),
        readFile(files.audit, "utf8")
      ]);
      const draft = this.validateDraft(draftValue);
      const snapshot = this.validateSnapshot(snapshotValue, draft);
      const plan = this.validatePlan(planValue, draft);
      const confirmation = this.validateConfirmation(confirmationValue, draft);
      return {
        draft,
        snapshot,
        ...(plan ? { plan } : {}),
        ...(confirmation ? { confirmation } : {}),
        audit: this.validateAudit(auditRaw, draft.draft_id)
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new RunDraftStoreError("draft_not_found", `RunDraft not found: ${draftId}`);
      }
      throw error;
    }
  }

  async update(input: {
    draft_id: string;
    expected_revision: number;
    patch: Pick<Partial<RunDraft>, "inputs" | "enabled_optional_paths" | "execution_policy">;
    actor: string;
  }): Promise<RunDraftBundle> {
    return this.withDraftLock(input.draft_id, async () => {
    const existing = await this.readUnlocked(input.draft_id);
    this.assertRevision(existing.draft, input.expected_revision);
    const changed = updateRunDraft({ draft: existing.draft, confirmation: existing.confirmation, patch: input.patch, now: this.now() });
    if (changed.draft === existing.draft) return existing;
    const files = this.paths(input.draft_id);
    await this.writeJson(files.draft, changed.draft);
    await this.writeJson(files.plan, { draft_id: changed.draft.draft_id, status: "not_generated" } satisfies PendingPlan);
    if (changed.confirmation) await this.writeJson(files.confirmation, changed.confirmation);
    await this.appendAudit({
      draft: changed.draft,
      actor: input.actor,
      type: "run_draft_updated",
      previous_hash: canonicalPlanHash(existing.draft),
      next_hash: canonicalPlanHash(changed.draft),
      changed_fields: Object.keys(input.patch)
    });
    return { ...existing, draft: changed.draft, plan: undefined, confirmation: changed.confirmation };
    });
  }

  async dryRun(input: {
    draft_id: string;
    expected_revision: number;
    actor: string;
    available_credentials?: string[];
    credential_scopes?: CredentialScope[];
  }): Promise<RunDraftBundle & { plan: RunDraftDryRunPlan }> {
    return this.withDraftLock(input.draft_id, async () => {
    const existing = await this.readUnlocked(input.draft_id);
    this.assertRevision(existing.draft, input.expected_revision);
    const workflow = await this.readWorkflow(existing.draft.workflow_id);
    const refreshed = refreshRunDraftWorkflowSource({ draft: existing.draft, confirmation: existing.confirmation, workflow, now: this.now() });
    const plan = createRunDraftDryRunPlan({
      draft: refreshed.draft,
      workflow,
      available_credentials: input.available_credentials,
      credential_scopes: input.credential_scopes,
      now: this.now()
    });
    const draft: RunDraft = {
      ...refreshed.draft,
      status: plan.status,
      latest_plan_id: plan.draft_plan_id,
      latest_plan_hash: plan.plan_hash,
      revision: refreshed.draft.revision + 1,
      updated_at: this.now()
    };
    const files = this.paths(input.draft_id);
    await this.writeJson(files.draft, draft);
    const snapshot = createWorkflowSnapshotDraft({ draft, workflow, now: draft.updated_at });
    await this.writeJson(files.snapshot, snapshot);
    await this.writeJson(files.plan, plan);
    if (refreshed.confirmation) await this.writeJson(files.confirmation, refreshed.confirmation);
    await this.appendAudit({ draft, actor: input.actor, type: "dry_run_generated", previous_hash: canonicalPlanHash(existing.draft), next_hash: plan.plan_hash, changed_fields: ["latest_plan_hash", "status"] });
    return { ...existing, draft, snapshot, confirmation: refreshed.confirmation, plan };
    });
  }

  async revise(input: { draft_id: string; expected_revision: number; actor: string }): Promise<RunDraftBundle> {
    return this.withDraftLock(input.draft_id, async () => {
      const existing = await this.readUnlocked(input.draft_id);
      this.assertRevision(existing.draft, input.expected_revision);
      const revised = reviseRunDraft({ draft: existing.draft, confirmation: existing.confirmation, now: this.now() });
      const files = this.paths(input.draft_id);
      await this.writeJson(files.draft, revised.draft);
      await this.writeJson(files.plan, { draft_id: revised.draft.draft_id, status: "not_generated" } satisfies PendingPlan);
      if (revised.confirmation) await this.writeJson(files.confirmation, revised.confirmation);
      await this.appendAudit({
        draft: revised.draft,
        actor: input.actor,
        type: "run_draft_updated",
        previous_hash: canonicalPlanHash(existing.draft),
        next_hash: canonicalPlanHash(revised.draft),
        changed_fields: ["status", "latest_plan_hash", "confirmation_id"]
      });
      return { ...existing, draft: revised.draft, plan: undefined, confirmation: revised.confirmation };
    });
  }

  async cancel(input: { draft_id: string; expected_revision: number; actor: string }): Promise<RunDraftBundle> {
    return this.withDraftLock(input.draft_id, async () => {
      const existing = await this.readUnlocked(input.draft_id);
      this.assertRevision(existing.draft, input.expected_revision);
      const cancelled = cancelRunDraft({ draft: existing.draft, confirmation: existing.confirmation, now: this.now() });
      const files = this.paths(input.draft_id);
      await this.writeJson(files.draft, cancelled.draft);
      if (cancelled.confirmation) await this.writeJson(files.confirmation, cancelled.confirmation);
      await this.appendAudit({
        draft: cancelled.draft,
        actor: input.actor,
        type: "run_draft_cancelled",
        previous_hash: canonicalPlanHash(existing.draft),
        next_hash: canonicalPlanHash(cancelled.draft),
        changed_fields: ["status"]
      });
      return { ...existing, draft: cancelled.draft, confirmation: cancelled.confirmation };
    });
  }

  async confirm(input: {
    draft_id: string;
    expected_revision: number;
    plan_hash: string;
    actor: string;
    acknowledgements: string[];
  }): Promise<RunDraftBundle & { confirmation: LaunchConfirmation }> {
    return this.withDraftLock(input.draft_id, async () => {
    const existing = await this.readUnlocked(input.draft_id);
    if (existing.confirmation?.decision === "confirmed" && existing.confirmation.plan_hash === input.plan_hash && existing.plan?.plan_hash === input.plan_hash) {
      return { ...existing, confirmation: existing.confirmation };
    }
    this.assertRevision(existing.draft, input.expected_revision);
    if (!existing.plan || existing.plan.plan_hash !== input.plan_hash) {
      throw new RunDraftError("plan_hash_mismatch", "The confirmation must reference the stored latest RunDraft plan hash.");
    }
    const confirmed = confirmRunDraft({
      draft: existing.draft,
      plan: existing.plan,
      existing_confirmation: existing.confirmation,
      actor: input.actor,
      acknowledgements: input.acknowledgements,
      now: this.now()
    });
    if (confirmed.confirmation === existing.confirmation) return { ...existing, confirmation: confirmed.confirmation };
    const draft: RunDraft = { ...confirmed.draft, revision: existing.draft.revision + 1, updated_at: this.now() };
    const files = this.paths(input.draft_id);
    await this.writeJson(files.draft, draft);
    await this.writeJson(files.confirmation, confirmed.confirmation);
    await this.appendAudit({ draft, actor: input.actor, type: "launch_confirmation_recorded", previous_hash: existing.draft.latest_plan_hash, next_hash: confirmed.confirmation.plan_hash, changed_fields: ["status", "confirmation_id"] });
    return { ...existing, draft, confirmation: confirmed.confirmation };
    });
  }

  async requestLaunch(input: { draft_id: string; adapter_ready: boolean }) {
    return this.withDraftLock(input.draft_id, async () => {
    const { draft } = await this.readUnlocked(input.draft_id);
    if (!input.adapter_ready) {
      throw new RunDraftStoreError("adapter_not_ready", "Adapter is not ready; the confirmed RunDraft remains unchanged.");
    }
    if (draft.status !== "confirmed") {
      throw new RunDraftStoreError("launch_handoff_required", "Only a confirmed RunDraft may be handed to the Run launch service.");
    }
    throw new RunDraftStoreError("launch_handoff_required", "Run launch wiring belongs to the unified POST /runs service.");
    });
  }
}
