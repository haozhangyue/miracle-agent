import {
  RunDraftError,
  canonicalPlanHash,
  confirmRunDraft,
  createRunDraft,
  createRunDraftDryRunPlan,
  createWorkflowSnapshotDraft,
  refreshRunDraftWorkflowSource,
  updateRunDraft,
  type CredentialScope,
  type LaunchConfirmation,
  type RunDraft,
  type RunDraftDryRunPlan,
  type WorkflowSnapshotDraft,
  type WorkflowSpec
} from "@miracle/core";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type PendingPlan = { draft_id: string; status: "not_generated" };
type PendingConfirmation = { draft_id: string; decision: "pending" };

export class RunDraftStoreError extends Error {
  constructor(
    public readonly code: "draft_not_found" | "workflow_not_found" | "revision_conflict" | "adapter_not_ready" | "launch_handoff_required" | "invalid_draft_id",
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
}

function isPlan(value: unknown): value is RunDraftDryRunPlan {
  return Boolean(value && typeof value === "object" && "plan_hash" in value && typeof (value as { plan_hash?: unknown }).plan_hash === "string");
}

function isConfirmation(value: unknown): value is LaunchConfirmation {
  return Boolean(value && typeof value === "object" && "confirmation_id" in value && typeof (value as { confirmation_id?: unknown }).confirmation_id === "string");
}

function assertDraftId(draftId: string) {
  if (!/^rundraft_[a-zA-Z0-9_-]+$/.test(draftId)) {
    throw new RunDraftStoreError("invalid_draft_id", `Invalid RunDraft id: ${draftId}`);
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

  private async readJson<T>(target: string): Promise<T> {
    return JSON.parse(await readFile(target, "utf8")) as T;
  }

  private async writeJson(target: string, value: unknown) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
      return await this.readJson<WorkflowSpec>(path.join(this.options.workflows_dir, `${workflowId}.json`));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new RunDraftStoreError("workflow_not_found", `Workflow not found: ${workflowId}`);
      }
      throw error;
    }
  }

  private async appendAudit(input: {
    draft: RunDraft;
    actor: string;
    type: "run_draft_created" | "run_draft_updated" | "dry_run_generated" | "launch_confirmation_recorded";
    previous_hash?: string;
    next_hash?: string;
    changed_fields: string[];
  }) {
    const record = {
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

  async create(input: {
    draft_id: string;
    workflow_id: string;
    inputs?: Record<string, unknown>;
    enabled_optional_paths?: string[];
    execution_policy?: RunDraft["execution_policy"];
    actor: string;
  }): Promise<RunDraftBundle> {
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
    const files = this.paths(draft.draft_id);
    await this.writeJson(files.draft, draft);
    await this.writeJson(files.snapshot, snapshot);
    await this.writeJson(files.plan, { draft_id: draft.draft_id, status: "not_generated" } satisfies PendingPlan);
    await this.writeJson(files.confirmation, { draft_id: draft.draft_id, decision: "pending" } satisfies PendingConfirmation);
    await this.appendAudit({ draft, actor: input.actor, type: "run_draft_created", next_hash: canonicalPlanHash(draft), changed_fields: ["created"] });
    return { draft, snapshot };
  }

  async read(draftId: string): Promise<RunDraftBundle> {
    const files = this.paths(draftId);
    try {
      const [draft, snapshot, planValue, confirmationValue] = await Promise.all([
        this.readJson<RunDraft>(files.draft),
        this.readJson<WorkflowSnapshotDraft>(files.snapshot),
        this.readJson<unknown>(files.plan),
        this.readJson<unknown>(files.confirmation)
      ]);
      return {
        draft,
        snapshot,
        ...(isPlan(planValue) ? { plan: planValue } : {}),
        ...(isConfirmation(confirmationValue) ? { confirmation: confirmationValue } : {})
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
    const existing = await this.read(input.draft_id);
    this.assertRevision(existing.draft, input.expected_revision);
    const changed = updateRunDraft({ draft: existing.draft, confirmation: existing.confirmation, patch: input.patch, now: this.now() });
    if (changed.draft === existing.draft) return existing;
    const files = this.paths(input.draft_id);
    await this.writeJson(files.draft, changed.draft);
    if (changed.confirmation) await this.writeJson(files.confirmation, changed.confirmation);
    await this.appendAudit({
      draft: changed.draft,
      actor: input.actor,
      type: "run_draft_updated",
      previous_hash: canonicalPlanHash(existing.draft),
      next_hash: canonicalPlanHash(changed.draft),
      changed_fields: Object.keys(input.patch)
    });
    return { ...existing, draft: changed.draft, confirmation: changed.confirmation };
  }

  async dryRun(input: {
    draft_id: string;
    expected_revision: number;
    actor: string;
    available_credentials?: string[];
    credential_scopes?: CredentialScope[];
  }): Promise<RunDraftBundle & { plan: RunDraftDryRunPlan }> {
    const existing = await this.read(input.draft_id);
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
    await this.appendAudit({ draft, actor: input.actor, type: "dry_run_generated", previous_hash: canonicalPlanHash(existing.draft), next_hash: plan.plan_hash, changed_fields: ["latest_plan_hash", "status"] });
    return { ...existing, draft, snapshot, confirmation: refreshed.confirmation, plan };
  }

  async confirm(input: {
    draft_id: string;
    expected_revision: number;
    plan_hash: string;
    actor: string;
    acknowledgements: string[];
  }): Promise<RunDraftBundle & { confirmation: LaunchConfirmation }> {
    const existing = await this.read(input.draft_id);
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
  }

  async requestLaunch(input: { draft_id: string; adapter_ready: boolean }) {
    const { draft } = await this.read(input.draft_id);
    if (!input.adapter_ready) {
      throw new RunDraftStoreError("adapter_not_ready", "Adapter is not ready; the confirmed RunDraft remains unchanged.");
    }
    if (draft.status !== "confirmed") {
      throw new RunDraftStoreError("launch_handoff_required", "Only a confirmed RunDraft may be handed to the Run launch service.");
    }
    throw new RunDraftStoreError("launch_handoff_required", "Run launch wiring belongs to the unified POST /runs service.");
  }
}
