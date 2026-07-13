import { createHash } from "node:crypto";
import type { DryRunPlan, WorkflowSpec } from "./types";
import { createDryRunPlan } from "./validation";

export type RunDraftStatus =
  | "draft"
  | "ready_for_dry_run"
  | "ready_for_confirmation"
  | "confirmed"
  | "launch_pending"
  | "converted"
  | "cancelled"
  | "expired";

export interface RunDraft {
  draft_id: string;
  workflow_id: string;
  workflow_source_hash: string;
  status: RunDraftStatus;
  inputs: Record<string, unknown>;
  enabled_optional_paths: string[];
  execution_policy: "auto" | "manual" | "hybrid";
  latest_plan_id?: string;
  latest_plan_hash?: string;
  confirmation_id?: string;
  converted_run_id?: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface WorkflowSnapshotDraft {
  snapshot_id: string;
  draft_id: string;
  workflow_source_hash: string;
  snapshot_hash: string;
  frozen_at: string;
  workflow: WorkflowSpec;
}

export type CredentialScope = NonNullable<WorkflowSpec["provider_policy"]["credential_scopes"]>[number];

export interface RunDraftDryRunPlan {
  draft_plan_id: string;
  draft_id: string;
  status: "ready_for_confirmation" | "ready_for_dry_run";
  workflow_snapshot_draft_hash: string;
  resolved_at: string;
  core_plan: DryRunPlan;
  credential_checks: Array<CredentialScope & { status: "configured" | "missing" }>;
  gate_plan: Array<{ gate_spec_id: string; required_before: string[]; actions: string[] }>;
  branch_impact: Array<{ branch_id: string; selection: "required" | "optional"; enabled: boolean; readiness: "ready" | "blocked" | "not_selected" }>;
  provider_resolution: Array<{ node_id: string; provider: string }>;
  execution_summary: { node_count: number; enabled_optional_branch_count: number; estimated_duration_minutes: { min: number; max: number } };
  startability: {
    required_path: "ready" | "blocked";
    full_workflow: "ready" | "blocked";
    recommended_action: "start" | "start_without_optional_branches" | "resolve_required_blockers";
  };
  required_acknowledgements: string[];
  plan_hash: string;
}

export interface LaunchConfirmation {
  confirmation_id: string;
  draft_id: string;
  draft_plan_id: string;
  plan_hash: string;
  decision: "confirmed" | "superseded" | "cancelled";
  required_acknowledgements: string[];
  actor: string;
  decided_at: string;
  superseded_by_revision?: number;
}

export class RunDraftError extends Error {
  constructor(
    public readonly code:
      | "draft_not_ready_for_confirmation"
      | "plan_hash_mismatch"
      | "missing_required_acknowledgements"
      | "required_path_blocked"
      | "invalid_draft_transition",
    message: string
  ) {
    super(message);
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function canonicalPlanHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function createRunDraft(input: {
  draft_id: string;
  workflow: WorkflowSpec;
  inputs?: Record<string, unknown>;
  enabled_optional_paths?: string[];
  execution_policy?: RunDraft["execution_policy"];
  now?: string;
}): RunDraft {
  const timestamp = input.now ?? new Date().toISOString();
  return {
    draft_id: input.draft_id,
    workflow_id: input.workflow.id,
    workflow_source_hash: canonicalPlanHash(input.workflow),
    status: "draft",
    inputs: input.inputs ?? {},
    enabled_optional_paths: [...new Set(input.enabled_optional_paths ?? [])].sort(),
    execution_policy: input.execution_policy ?? "hybrid",
    revision: 1,
    created_at: timestamp,
    updated_at: timestamp
  };
}

export function createWorkflowSnapshotDraft(input: { draft: RunDraft; workflow: WorkflowSpec; now?: string }): WorkflowSnapshotDraft {
  const frozenAt = input.now ?? new Date().toISOString();
  const workflowSourceHash = canonicalPlanHash(input.workflow);
  return {
    snapshot_id: `draftsnap_${input.draft.draft_id}`,
    draft_id: input.draft.draft_id,
    workflow_source_hash: workflowSourceHash,
    snapshot_hash: canonicalPlanHash({ workflow_source_hash: workflowSourceHash, workflow: input.workflow }),
    frozen_at: frozenAt,
    workflow: input.workflow
  };
}

function defaultCredentialScopes(workflow: WorkflowSpec): CredentialScope[] {
  const optionalEdges = workflow.edges.filter((edge) => !edge.required);
  const optionalBranchIds = new Set(optionalEdges.map(optionalBranchId));
  const declared = new Map((workflow.provider_policy.credential_scopes ?? []).map((scope) => [scope.credential_ref, scope]));
  return workflow.provider_policy.required_credentials.map((credential_ref) => {
    const scope = declared.get(credential_ref);
    const branchEdges = workflow.edges.filter((edge) => optionalBranchId(edge) === scope?.required_for_branch);
    const provenOptionalOnly = branchEdges.length > 0 && branchEdges.some((edge) => !edge.required);
    if (scope?.blocking_scope === "optional_branch" && optionalBranchIds.has(scope.required_for_branch) && provenOptionalOnly) return scope;
    return { credential_ref, required_for_branch: "required_path", blocking_scope: "required_path" };
  });
}

function optionalBranchId(edge: WorkflowSpec["edges"][number]) {
  return edge.optional_path_id ?? (edge.artifact_selector?.artifact_type === "video" ? "video_package" : `optional_${edge.from}_to_${edge.to}`);
}

export function createRunDraftDryRunPlan(input: {
  draft: RunDraft;
  workflow: WorkflowSpec;
  available_credentials?: string[];
  now?: string;
}): RunDraftDryRunPlan {
  const resolvedAt = input.now ?? new Date().toISOString();
  const availableCredentials = new Set(input.available_credentials ?? []);
  const credentialScopes = defaultCredentialScopes(input.workflow);
  const credentialChecks = credentialScopes.map((scope) => ({ ...scope, status: availableCredentials.has(scope.credential_ref) ? ("configured" as const) : ("missing" as const) }));
  const requiredBlocked = credentialChecks.some((check) => check.blocking_scope === "required_path" && check.status === "missing");
  const enabledOptionalPaths = new Set(input.draft.enabled_optional_paths);
  const optionalBranches = Array.from(new Set(input.workflow.edges.filter((edge) => !edge.required).map(optionalBranchId))).map((branchId) => ({
    branch_id: branchId,
    selection: "optional" as const,
    enabled: enabledOptionalPaths.has(branchId),
    readiness: !enabledOptionalPaths.has(branchId)
      ? ("not_selected" as const)
      : credentialChecks.some((check) => check.blocking_scope === "optional_branch" && check.required_for_branch === branchId && check.status === "missing")
      ? ("blocked" as const)
      : ("ready" as const)
  }));
  const optionalBlocked = optionalBranches.some((branch) => branch.readiness === "blocked");
  const corePlanCredentials = Array.from(new Set([
    ...(input.available_credentials ?? []),
    ...credentialScopes.filter((scope) => scope.blocking_scope === "optional_branch").map((scope) => scope.credential_ref)
  ]));
  const corePlan = createDryRunPlan(input.workflow, corePlanCredentials);
  const snapshot = createWorkflowSnapshotDraft({ draft: input.draft, workflow: input.workflow, now: resolvedAt });
  const requiredAcknowledgements = [
    ...input.workflow.gates.map((gate) => `required_gate:${gate.id}`),
    ...(optionalBlocked ? ["optional_branch_missing_credential"] : [])
  ];
  const planWithoutHash = {
    draft_plan_id: `draftplan_${input.draft.draft_id}_${input.draft.revision}`,
    draft_id: input.draft.draft_id,
    status: requiredBlocked ? ("ready_for_dry_run" as const) : ("ready_for_confirmation" as const),
    workflow_snapshot_draft_hash: snapshot.snapshot_hash,
    resolved_at: resolvedAt,
    core_plan: corePlan,
    credential_checks: credentialChecks,
    gate_plan: input.workflow.gates.map((gate) => ({ gate_spec_id: gate.id, required_before: [...gate.required_before], actions: [...gate.actions] })),
    branch_impact: optionalBranches,
    provider_resolution: input.workflow.nodes.map((node) => ({ node_id: node.id, provider: input.workflow.provider_policy.default_provider })),
    execution_summary: {
      node_count: input.workflow.nodes.length,
      enabled_optional_branch_count: optionalBranches.filter((branch) => branch.enabled).length,
      estimated_duration_minutes: { min: input.workflow.nodes.length * 1, max: input.workflow.nodes.length * 5 }
    },
    startability: {
      required_path: requiredBlocked ? ("blocked" as const) : ("ready" as const),
      full_workflow: requiredBlocked || optionalBlocked ? ("blocked" as const) : ("ready" as const),
      recommended_action: requiredBlocked
        ? ("resolve_required_blockers" as const)
        : optionalBlocked
          ? ("start_without_optional_branches" as const)
          : ("start" as const)
    },
    required_acknowledgements: requiredAcknowledgements
  };
  const planHashInput = {
    draft: {
      draft_id: input.draft.draft_id,
      workflow_id: input.draft.workflow_id,
      workflow_source_hash: input.draft.workflow_source_hash,
      inputs: input.draft.inputs,
      enabled_optional_paths: input.draft.enabled_optional_paths,
      execution_policy: input.draft.execution_policy
    },
    workflow_snapshot_draft_hash: planWithoutHash.workflow_snapshot_draft_hash,
    core_plan: {
      workflow_id: corePlan.workflow_id,
      valid: corePlan.valid,
      estimated_cost: corePlan.estimated_cost,
      risks: corePlan.risks,
      nodes: corePlan.nodes
    },
    credential_checks: credentialChecks,
    gate_plan: planWithoutHash.gate_plan,
    branch_impact: optionalBranches,
    provider_resolution: planWithoutHash.provider_resolution,
    execution_summary: planWithoutHash.execution_summary,
    startability: planWithoutHash.startability,
    required_acknowledgements: requiredAcknowledgements
  };
  return { ...planWithoutHash, plan_hash: canonicalPlanHash(planHashInput) };
}

export function updateRunDraft(input: {
  draft: RunDraft;
  confirmation?: LaunchConfirmation;
  patch: Pick<Partial<RunDraft>, "inputs" | "enabled_optional_paths" | "execution_policy">;
  now?: string;
}): { draft: RunDraft; confirmation?: LaunchConfirmation } {
  assertMutable(input.draft, "update");
  const changed =
    (input.patch.inputs !== undefined && canonicalJson(input.patch.inputs) !== canonicalJson(input.draft.inputs)) ||
    (input.patch.enabled_optional_paths !== undefined && canonicalJson([...new Set(input.patch.enabled_optional_paths)].sort()) !== canonicalJson(input.draft.enabled_optional_paths)) ||
    (input.patch.execution_policy !== undefined && input.patch.execution_policy !== input.draft.execution_policy);
  if (!changed) return { draft: input.draft, confirmation: input.confirmation };

  const revision = input.draft.revision + 1;
  const draft: RunDraft = {
    ...input.draft,
    inputs: input.patch.inputs ?? input.draft.inputs,
    enabled_optional_paths: input.patch.enabled_optional_paths ? [...new Set(input.patch.enabled_optional_paths)].sort() : input.draft.enabled_optional_paths,
    execution_policy: input.patch.execution_policy ?? input.draft.execution_policy,
    status: "ready_for_dry_run",
    latest_plan_id: undefined,
    latest_plan_hash: undefined,
    confirmation_id: undefined,
    revision,
    updated_at: input.now ?? new Date().toISOString()
  };
  const confirmation = input.confirmation?.decision === "confirmed" ? { ...input.confirmation, decision: "superseded" as const, superseded_by_revision: revision } : input.confirmation;
  return { draft, confirmation };
}

export function refreshRunDraftWorkflowSource(input: {
  draft: RunDraft;
  confirmation?: LaunchConfirmation;
  workflow: WorkflowSpec;
  now?: string;
}): { draft: RunDraft; confirmation?: LaunchConfirmation } {
  const workflowSourceHash = canonicalPlanHash(input.workflow);
  if (workflowSourceHash === input.draft.workflow_source_hash) return { draft: input.draft, confirmation: input.confirmation };
  const revision = input.draft.revision + 1;
  const draft: RunDraft = {
    ...input.draft,
    workflow_source_hash: workflowSourceHash,
    status: "ready_for_dry_run",
    latest_plan_id: undefined,
    latest_plan_hash: undefined,
    confirmation_id: undefined,
    revision,
    updated_at: input.now ?? new Date().toISOString()
  };
  const confirmation = input.confirmation?.decision === "confirmed" ? { ...input.confirmation, decision: "superseded" as const, superseded_by_revision: revision } : input.confirmation;
  return { draft, confirmation };
}

export function reviseRunDraft(input: {
  draft: RunDraft;
  confirmation?: LaunchConfirmation;
  now?: string;
}): { draft: RunDraft; confirmation?: LaunchConfirmation } {
  if (input.draft.status !== "confirmed") throw new RunDraftError("invalid_draft_transition", `Cannot revise RunDraft from ${input.draft.status}.`);
  const revision = input.draft.revision + 1;
  const draft: RunDraft = {
    ...input.draft,
    status: "ready_for_dry_run",
    latest_plan_id: undefined,
    latest_plan_hash: undefined,
    confirmation_id: undefined,
    revision,
    updated_at: input.now ?? new Date().toISOString()
  };
  const confirmation = input.confirmation?.decision === "confirmed" ? { ...input.confirmation, decision: "superseded" as const, superseded_by_revision: revision } : input.confirmation;
  return { draft, confirmation };
}

export function cancelRunDraft(input: {
  draft: RunDraft;
  confirmation?: LaunchConfirmation;
  now?: string;
}): { draft: RunDraft; confirmation?: LaunchConfirmation } {
  assertMutable(input.draft, "cancel");
  const cancelledAt = input.now ?? new Date().toISOString();
  const draft: RunDraft = {
    ...input.draft,
    status: "cancelled",
    revision: input.draft.revision + 1,
    updated_at: cancelledAt
  };
  const confirmation = input.confirmation?.decision === "confirmed" ? { ...input.confirmation, decision: "cancelled" as const, superseded_by_revision: draft.revision } : input.confirmation;
  return { draft, confirmation };
}

export function confirmRunDraft(input: {
  draft: RunDraft;
  plan: RunDraftDryRunPlan;
  existing_confirmation?: LaunchConfirmation;
  actor: string;
  acknowledgements: string[];
  now?: string;
}): { draft: RunDraft; confirmation: LaunchConfirmation } {
  if (input.existing_confirmation?.decision === "confirmed" && input.existing_confirmation.plan_hash === input.plan.plan_hash) {
    return { draft: input.draft, confirmation: input.existing_confirmation };
  }
  assertMutable(input.draft, "confirm");
  if (input.plan.draft_id !== input.draft.draft_id || input.draft.latest_plan_hash && input.draft.latest_plan_hash !== input.plan.plan_hash) {
    throw new RunDraftError("plan_hash_mismatch", "The confirmation must reference the latest RunDraft plan hash.");
  }
  if (input.plan.startability.required_path !== "ready") {
    throw new RunDraftError("required_path_blocked", "The required path is blocked and cannot be confirmed.");
  }
  const acknowledgements = new Set(input.acknowledgements);
  const missing = input.plan.required_acknowledgements.filter((acknowledgement) => !acknowledgements.has(acknowledgement));
  if (missing.length > 0) {
    throw new RunDraftError("missing_required_acknowledgements", `Missing required acknowledgements: ${missing.join(", ")}`);
  }
  const decidedAt = input.now ?? new Date().toISOString();
  const confirmation: LaunchConfirmation = {
    confirmation_id: `launch_confirm_${input.draft.draft_id}_${input.draft.revision}`,
    draft_id: input.draft.draft_id,
    draft_plan_id: input.plan.draft_plan_id,
    plan_hash: input.plan.plan_hash,
    decision: "confirmed",
    required_acknowledgements: [...input.plan.required_acknowledgements],
    actor: input.actor,
    decided_at: decidedAt
  };
  return {
    draft: {
      ...input.draft,
      status: "confirmed",
      latest_plan_id: input.plan.draft_plan_id,
      latest_plan_hash: input.plan.plan_hash,
      confirmation_id: confirmation.confirmation_id,
      updated_at: decidedAt
    },
    confirmation
  };
}

function assertMutable(draft: RunDraft, action: string) {
  if (["cancelled", "converted", "expired", "launch_pending"].includes(draft.status)) {
    throw new RunDraftError("invalid_draft_transition", `Cannot ${action} RunDraft from terminal status ${draft.status}.`);
  }
}
