import { describe, expect, it } from "vitest";
import {
  RunDraftError,
  canonicalPlanHash,
  confirmRunDraft,
  cancelRunDraft,
  createRunDraft,
  createRunDraftDryRunPlan,
  refreshRunDraftWorkflowSource,
  reviseRunDraft,
  updateRunDraft,
  type WorkflowSpec
} from "../src";

const workflow: WorkflowSpec = {
  id: "content-production-real-v0",
  name: "RunDraft test workflow",
  version: "0.1.0",
  domain: "content-production",
  category: "media",
  nodes: [
    {
      id: "A_fact_intelligence",
      name: "Facts",
      type: "source",
      capability_requirements: ["source.collect"],
      recommended_libraries: [],
      agent_candidates: ["facts-agent"],
      inputs: [],
      outputs: [{ id: "facts", kind: "artifact", artifact_type: "markdown", required: true, artifact_spec_ref: "facts" }],
      failure_policy: { retry: 0, on_missing_input: "blocked", on_provider_failure: "failed" }
    },
    {
      id: "B_md_master",
      name: "Markdown",
      type: "transform",
      capability_requirements: ["content.longform_draft"],
      recommended_libraries: [],
      agent_candidates: ["content-agent"],
      inputs: [{ id: "facts", kind: "artifact", artifact_type: "markdown", required: true }],
      outputs: [{ id: "master", kind: "artifact", artifact_type: "markdown", required: true, artifact_spec_ref: "master" }],
      review_gate_ref: "final_human_review",
      failure_policy: { retry: 0, on_missing_input: "blocked", on_provider_failure: "failed" }
    },
    {
      id: "F_final_render",
      name: "Video",
      type: "tool",
      capability_requirements: ["video.render"],
      recommended_libraries: [],
      agent_candidates: ["video-agent"],
      inputs: [],
      outputs: [{ id: "video", kind: "artifact", artifact_type: "video", required: true, artifact_spec_ref: "video" }],
      failure_policy: { retry: 0, on_missing_input: "blocked", on_provider_failure: "failed" }
    },
    {
      id: "G_distribution_retro",
      name: "Distribution",
      type: "artifact",
      capability_requirements: ["publish.package"],
      recommended_libraries: [],
      agent_candidates: ["distribution-agent"],
      inputs: [{ id: "master", kind: "artifact", artifact_type: "markdown", required: true }],
      outputs: [],
      failure_policy: { retry: 0, on_missing_input: "blocked", on_provider_failure: "failed" }
    }
  ],
  edges: [
    { from: "A_fact_intelligence", to: "B_md_master", required: true, join_policy: { wait_if_active: false, on_timeout: "blocked", on_no_qualified_artifact: "block_downstream" } },
    { from: "B_md_master", to: "G_distribution_retro", required: true, join_policy: { wait_if_active: false, on_timeout: "blocked", on_no_qualified_artifact: "block_downstream" } },
    { from: "F_final_render", to: "G_distribution_retro", required: false, artifact_selector: { artifact_type: "video" }, join_policy: { wait_if_active: true, on_timeout: "continue_if_required_inputs_ready", on_no_qualified_artifact: "ignore_optional" } }
  ],
  gates: [{ id: "final_human_review", name: "Final human review", target_artifact_ref: "master", required_before: ["G_distribution_retro"], actions: ["approve", "reject"] }],
  artifacts: [
    { id: "facts", type: "markdown", produced_by: "A_fact_intelligence", review_policy: { mode: "none" }, required_for: ["B_md_master"], versioning: { immutable: true, compare_by: "hash" } },
    { id: "master", type: "markdown", produced_by: "B_md_master", review_policy: { mode: "manual", gate_spec_id: "final_human_review" }, required_for: ["G_distribution_retro"], versioning: { immutable: true, compare_by: "hash" } },
    { id: "video", type: "video", produced_by: "F_final_render", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } }
  ],
  provider_policy: { default_provider: "codex-local", allowed_providers: ["codex-local"], required_credentials: ["VOLC_TTS_API_KEY"], fallback_providers: [] },
  layouts: { dag: {} },
  registry_meta: { source: "test", status: "stable" }
};

function draft() {
  return createRunDraft({
    draft_id: "rundraft_test_001",
    workflow,
    inputs: { topic_brief: "RunDraft 轨道" },
    enabled_optional_paths: ["video_package"],
    execution_policy: "hybrid",
    now: "2026-07-13T01:00:00.000Z"
  });
}

function dryRun() {
  return createRunDraftDryRunPlan({
    draft: draft(),
    workflow,
    available_credentials: [],
    credential_scopes: [{ credential_ref: "VOLC_TTS_API_KEY", required_for_branch: "video_package", blocking_scope: "optional_branch" }],
    now: "2026-07-13T01:01:00.000Z"
  });
}

describe("RunDraft core", () => {
  it("hashes equivalent plans from canonical JSON", () => {
    expect(canonicalPlanHash({ inputs: { topic: "P6-04" }, branches: ["video_package"] })).toBe(
      canonicalPlanHash({ branches: ["video_package"], inputs: { topic: "P6-04" } })
    );
  });

  it("changes the plan hash for a changed draft input while keeping an unchanged plan stable", () => {
    const first = dryRun();
    const same = dryRun();
    const changedDraft = updateRunDraft({ draft: draft(), patch: { inputs: { topic_brief: "A different topic" } }, now: "2026-07-13T01:01:00.000Z" }).draft;
    const changed = createRunDraftDryRunPlan({
      draft: changedDraft,
      workflow,
      available_credentials: [],
      credential_scopes: [{ credential_ref: "VOLC_TTS_API_KEY", required_for_branch: "video_package", blocking_scope: "optional_branch" }],
      now: "2026-07-13T01:01:00.000Z"
    });

    expect(same.plan_hash).toBe(first.plan_hash);
    expect(changed.plan_hash).not.toBe(first.plan_hash);
  });

  it("keeps a missing optional video credential out of the required markdown path and preserves every required Gate", () => {
    const plan = dryRun();

    expect(plan.startability).toMatchObject({ required_path: "ready", full_workflow: "blocked" });
    expect(plan.core_plan.valid).toBe(false);
    expect(plan.branch_impact).toContainEqual(expect.objectContaining({ branch_id: "video_package", readiness: "blocked" }));
    expect(plan.gate_plan).toEqual([expect.objectContaining({ gate_spec_id: "final_human_review" })]);
    expect(() => confirmRunDraft({ draft: draft(), plan, actor: "operator", acknowledgements: [] })).toThrow(RunDraftError);
  });

  it("supersedes confirmation when a plan-affecting draft field changes", () => {
    const plan = dryRun();
    const confirmed = confirmRunDraft({
      draft: draft(),
      plan,
      actor: "operator",
      acknowledgements: plan.required_acknowledgements,
      now: "2026-07-13T01:02:00.000Z"
    });
    const changed = updateRunDraft({
      draft: confirmed.draft,
      confirmation: confirmed.confirmation,
      patch: { inputs: { topic_brief: "Changed topic" } },
      now: "2026-07-13T01:03:00.000Z"
    });

    expect(changed.draft.status).toBe("ready_for_dry_run");
    expect(changed.confirmation).toMatchObject({ decision: "superseded", superseded_by_revision: changed.draft.revision });
  });

  it("supersedes confirmation when the source Workflow changes", () => {
    const plan = dryRun();
    const confirmed = confirmRunDraft({
      draft: draft(),
      plan,
      actor: "operator",
      acknowledgements: plan.required_acknowledgements,
      now: "2026-07-13T01:02:00.000Z"
    });
    const changedWorkflow = { ...workflow, version: "0.1.1" };
    const refreshed = refreshRunDraftWorkflowSource({ draft: confirmed.draft, confirmation: confirmed.confirmation, workflow: changedWorkflow, now: "2026-07-13T01:03:00.000Z" });

    expect(refreshed.draft.workflow_source_hash).not.toBe(confirmed.draft.workflow_source_hash);
    expect(refreshed.draft.status).toBe("ready_for_dry_run");
    expect(refreshed.confirmation).toMatchObject({ decision: "superseded" });
  });

  it("returns the existing confirmation for an identical confirm command", () => {
    const plan = dryRun();
    const first = confirmRunDraft({
      draft: draft(),
      plan,
      actor: "operator",
      acknowledgements: plan.required_acknowledgements,
      now: "2026-07-13T01:02:00.000Z"
    });
    const second = confirmRunDraft({
      draft: first.draft,
      plan,
      existing_confirmation: first.confirmation,
      actor: "operator",
      acknowledgements: plan.required_acknowledgements,
      now: "2026-07-13T01:04:00.000Z"
    });

    expect(second.confirmation).toEqual(first.confirmation);
    expect(second.draft).toEqual(first.draft);
  });

  it("revises a confirmed draft by superseding confirmation and requiring a new dry-run", () => {
    const plan = dryRun();
    const confirmed = confirmRunDraft({ draft: draft(), plan, actor: "operator", acknowledgements: plan.required_acknowledgements, now: "2026-07-13T01:02:00.000Z" });
    const revised = reviseRunDraft({ draft: confirmed.draft, confirmation: confirmed.confirmation, now: "2026-07-13T01:03:00.000Z" });

    expect(revised.draft).toMatchObject({ status: "ready_for_dry_run", latest_plan_hash: undefined, confirmation_id: undefined });
    expect(revised.confirmation).toMatchObject({ decision: "superseded" });
  });

  it("cancels a draft without creating any Run facts", () => {
    const cancelled = cancelRunDraft({ draft: draft(), now: "2026-07-13T01:02:00.000Z" });

    expect(cancelled.draft.status).toBe("cancelled");
    expect(cancelled.draft.converted_run_id).toBeUndefined();
  });
});
