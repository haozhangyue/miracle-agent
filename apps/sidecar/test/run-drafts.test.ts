import { beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkflowSpec } from "@miracle/core";
import { RunDraftStore, RunDraftStoreError } from "../src/run-draft-store";

const workflow: WorkflowSpec = {
  id: "content-production-real-v0",
  name: "RunDraft store workflow",
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
  provider_policy: {
    default_provider: "codex-local",
    allowed_providers: ["codex-local"],
    required_credentials: ["VOLC_TTS_API_KEY"],
    fallback_providers: [],
    credential_scopes: [{ credential_ref: "VOLC_TTS_API_KEY", required_for_branch: "video_package", blocking_scope: "optional_branch" }]
  },
  layouts: { dag: {} },
  registry_meta: { source: "test", status: "stable" }
};

let tempRoot = "";
let workspaceDir = "";
let workflowsDir = "";
let store: RunDraftStore;

beforeEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = await mkdtemp(path.join(tmpdir(), "miracle-run-drafts-"));
  workspaceDir = path.join(tempRoot, ".miracle");
  workflowsDir = path.join(workspaceDir, "workflows");
  await writeFile(path.join(tempRoot, "workflow.json"), JSON.stringify(workflow), "utf8");
  await mkdir(workflowsDir, { recursive: true });
  await writeFile(path.join(workflowsDir, `${workflow.id}.json`), JSON.stringify(workflow), "utf8");
  store = new RunDraftStore({ workspace_dir: workspaceDir, workflows_dir: workflowsDir, now: () => "2026-07-13T02:00:00.000Z" });
});

describe("RunDraftStore", () => {
  async function createConfirmedDraft(draftId: string) {
    const created = await store.create({ draft_id: draftId, workflow_id: workflow.id, enabled_optional_paths: ["video_package"], actor: "operator" });
    const planned = await store.dryRun({
      draft_id: created.draft.draft_id,
      expected_revision: created.draft.revision,
      actor: "operator",
    });
    return store.confirm({
      draft_id: planned.draft.draft_id,
      expected_revision: planned.draft.revision,
      plan_hash: planned.plan.plan_hash,
      actor: "operator",
      acknowledgements: planned.plan.required_acknowledgements
    });
  }

  it("rejects workflow path traversal and duplicate draft ids without replacing the existing draft", async () => {
    await expect(store.create({ draft_id: "rundraft_escape_001", workflow_id: "../workflow", actor: "operator" })).rejects.toMatchObject({ code: "invalid_workflow_id" });
    const outsideWorkflow = path.join(tempRoot, "outside-workflow.json");
    await writeFile(outsideWorkflow, JSON.stringify(workflow), "utf8");
    await symlink(outsideWorkflow, path.join(workflowsDir, "linked-workflow.json"));
    await expect(store.create({ draft_id: "rundraft_symlink_001", workflow_id: "linked-workflow", actor: "operator" })).rejects.toMatchObject({ code: "invalid_workflow_id" });
    const created = await store.create({ draft_id: "rundraft_duplicate_001", workflow_id: workflow.id, inputs: { topic_brief: "original" }, actor: "operator" });

    await expect(store.create({ draft_id: created.draft.draft_id, workflow_id: workflow.id, inputs: { topic_brief: "replacement" }, actor: "operator" })).rejects.toMatchObject({ code: "draft_already_exists" });
    expect((await store.read(created.draft.draft_id)).draft.inputs).toEqual({ topic_brief: "original" });
  });

  it("replays an identical confirmation using the original revision without a conflict or a duplicate audit record", async () => {
    const created = await store.create({ draft_id: "rundraft_idempotent_001", workflow_id: workflow.id, enabled_optional_paths: ["video_package"], actor: "operator" });
    const planned = await store.dryRun({
      draft_id: created.draft.draft_id,
      expected_revision: created.draft.revision,
      actor: "operator",
    });
    const request = {
      draft_id: planned.draft.draft_id,
      expected_revision: planned.draft.revision,
      plan_hash: planned.plan.plan_hash,
      actor: "operator",
      acknowledgements: planned.plan.required_acknowledgements
    };
    const first = await store.confirm(request);
    const replayed = await store.confirm(request);

    expect(replayed.draft).toEqual(first.draft);
    expect(replayed.confirmation).toEqual(first.confirmation);
    expect((await store.read(first.draft.draft_id)).audit.filter((entry) => entry.type === "launch_confirmation_recorded")).toHaveLength(1);
  });

  it("serializes concurrent updates so only one request with the same revision succeeds", async () => {
    const created = await store.create({ draft_id: "rundraft_cas_001", workflow_id: workflow.id, actor: "operator" });
    const results = await Promise.allSettled([
      store.update({ draft_id: created.draft.draft_id, expected_revision: created.draft.revision, actor: "operator-a", patch: { inputs: { topic_brief: "A" } } }),
      store.update({ draft_id: created.draft.draft_id, expected_revision: created.draft.revision, actor: "operator-b", patch: { inputs: { topic_brief: "B" } } })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected" && result.reason instanceof RunDraftStoreError && result.reason.code === "revision_conflict")).toHaveLength(1);
  });

  it("invalidates the persisted plan and confirmation on update and workflow source refresh", async () => {
    const confirmed = await createConfirmedDraft("rundraft_invalidation_001");
    const updated = await store.update({
      draft_id: confirmed.draft.draft_id,
      expected_revision: confirmed.draft.revision,
      actor: "operator",
      patch: { inputs: { topic_brief: "revised" } }
    });
    const draftDir = path.join(workspaceDir, "run-drafts", confirmed.draft.draft_id);

    expect(JSON.parse(await readFile(path.join(draftDir, "run_draft_dry_run_plan.json"), "utf8"))).toEqual({ draft_id: confirmed.draft.draft_id, status: "not_generated" });
    expect(JSON.parse(await readFile(path.join(draftDir, "launch_confirmation.json"), "utf8"))).toMatchObject({ decision: "superseded" });

    const replanned = await store.dryRun({
      draft_id: updated.draft.draft_id,
      expected_revision: updated.draft.revision,
      actor: "operator",
    });
    const confirmedAgain = await store.confirm({
      draft_id: replanned.draft.draft_id,
      expected_revision: replanned.draft.revision,
      plan_hash: replanned.plan.plan_hash,
      actor: "operator",
      acknowledgements: replanned.plan.required_acknowledgements
    });
    await writeFile(path.join(workflowsDir, `${workflow.id}.json`), JSON.stringify({ ...workflow, version: "0.1.1" }), "utf8");
    await store.dryRun({
      draft_id: confirmedAgain.draft.draft_id,
      expected_revision: confirmedAgain.draft.revision,
      actor: "operator",
    });

    expect((await store.read(confirmedAgain.draft.draft_id)).confirmation).toMatchObject({ decision: "superseded" });
  });

  it("rejects malformed or partial persisted state before a command can continue", async () => {
    const created = await store.create({ draft_id: "rundraft_corrupt_001", workflow_id: workflow.id, actor: "operator" });
    const draftDir = path.join(workspaceDir, "run-drafts", created.draft.draft_id);
    await writeFile(path.join(draftDir, "run_draft_dry_run_plan.json"), "{not-json", "utf8");
    await expect(store.dryRun({ draft_id: created.draft.draft_id, expected_revision: created.draft.revision, actor: "operator" })).rejects.toMatchObject({ code: "draft_state_invalid" });

    await writeFile(path.join(draftDir, "run_draft_dry_run_plan.json"), JSON.stringify({ draft_id: created.draft.draft_id, status: "not_generated" }), "utf8");
    await writeFile(path.join(draftDir, "launch_confirmation.json"), JSON.stringify({ decision: "confirmed" }), "utf8");
    await expect(store.read(created.draft.draft_id)).rejects.toMatchObject({ code: "draft_state_invalid" });
  });

  it("revises and cancels a draft without creating formal Run facts", async () => {
    const confirmed = await createConfirmedDraft("rundraft_decision_001");
    const revised = await store.revise({ draft_id: confirmed.draft.draft_id, expected_revision: confirmed.draft.revision, actor: "operator" });

    expect(revised.draft.status).toBe("ready_for_dry_run");
    expect((await store.read(revised.draft.draft_id)).confirmation).toMatchObject({ decision: "superseded" });

    const cancelled = await store.cancel({ draft_id: revised.draft.draft_id, expected_revision: revised.draft.revision, actor: "operator" });
    expect(cancelled.draft.status).toBe("cancelled");
    await expect(readdir(path.join(workspaceDir, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes the five draft files outside runs and appends one audit record per accepted command", async () => {
    const created = await store.create({
      draft_id: "rundraft_store_001",
      workflow_id: workflow.id,
      inputs: { topic_brief: "P6-04" },
      enabled_optional_paths: ["video_package"],
      actor: "operator"
    });
    const draftDir = path.join(workspaceDir, "run-drafts", created.draft.draft_id);

    expect((await readdir(draftDir)).sort()).toEqual([
      "draft_audit.jsonl",
      "launch_confirmation.json",
      "run_draft.json",
      "run_draft_dry_run_plan.json",
      "workflow_snapshot_draft.json"
    ]);
    await expect(readdir(path.join(workspaceDir, "runs"))).rejects.toMatchObject({ code: "ENOENT" });

    const planned = await store.dryRun({
      draft_id: created.draft.draft_id,
      expected_revision: created.draft.revision,
      actor: "operator",
      available_credentials: [],
    });
    const confirmed = await store.confirm({
      draft_id: planned.draft.draft_id,
      expected_revision: planned.draft.revision,
      plan_hash: planned.plan.plan_hash,
      actor: "operator",
      acknowledgements: planned.plan.required_acknowledgements
    });

    await expect(store.update({ draft_id: confirmed.draft.draft_id, expected_revision: 1, actor: "operator", patch: { inputs: { topic_brief: "stale" } } })).rejects.toMatchObject({ code: "revision_conflict" });
    const updated = await store.update({
      draft_id: confirmed.draft.draft_id,
      expected_revision: confirmed.draft.revision,
      actor: "operator",
      patch: { inputs: { topic_brief: "revised" } }
    });
    const audit = (await readFile(path.join(draftDir, "draft_audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    const bundle = await store.read(confirmed.draft.draft_id);

    expect(confirmed.draft.status).toBe("confirmed");
    expect(updated.confirmation).toMatchObject({ decision: "superseded" });
    expect(audit.map((entry) => entry.type)).toEqual(["run_draft_created", "dry_run_generated", "launch_confirmation_recorded", "run_draft_updated"]);
    expect(bundle.audit.map((entry) => entry.type)).toEqual(audit.map((entry) => entry.type));
  });

  it("rejects an unavailable Adapter without changing a confirmed draft", async () => {
    const created = await store.create({ draft_id: "rundraft_store_002", workflow_id: workflow.id, enabled_optional_paths: ["video_package"], actor: "operator" });
    const planned = await store.dryRun({
      draft_id: created.draft.draft_id,
      expected_revision: created.draft.revision,
      actor: "operator",
    });
    const confirmed = await store.confirm({
      draft_id: planned.draft.draft_id,
      expected_revision: planned.draft.revision,
      plan_hash: planned.plan.plan_hash,
      actor: "operator",
      acknowledgements: planned.plan.required_acknowledgements
    });

    await expect(store.requestLaunch({
      draft_id: confirmed.draft.draft_id,
      adapter_ready: false,
      draft_plan_id: planned.plan.draft_plan_id,
      plan_hash: planned.plan.plan_hash,
      confirmation_id: confirmed.confirmation.confirmation_id
    })).rejects.toBeInstanceOf(RunDraftStoreError);
    expect((await store.read(confirmed.draft.draft_id)).draft.status).toBe("confirmed");
  });

  it("rolls back a launched run when the converted draft cannot be committed", async () => {
    const confirmed = await createConfirmedDraft("rundraft_store_launch_rollback");
    if (!confirmed.plan) throw new Error("Expected a stored dry-run plan");
    const auditPath = path.join(workspaceDir, "run-drafts", confirmed.draft.draft_id, "draft_audit.jsonl");
    let rolledBack = false;

    await expect(store.requestLaunch({
      draft_id: confirmed.draft.draft_id,
      adapter_ready: true,
      draft_plan_id: confirmed.plan.draft_plan_id,
      plan_hash: confirmed.plan.plan_hash,
      confirmation_id: confirmed.confirmation.confirmation_id,
      actor: "operator",
      launch: async () => {
        await rm(auditPath, { force: true });
        await mkdir(auditPath);
        return { run_id: "run_should_rollback", rollback: async () => { rolledBack = true; } };
      }
    })).rejects.toBeTruthy();

    expect(rolledBack).toBe(true);
    const restored = (await store.read(confirmed.draft.draft_id)).draft;
    expect(restored.status).toBe("confirmed");
    expect(restored).not.toHaveProperty("converted_run_id");
  });

  it("reuses a converted run from frozen references after the registry workflow changes", async () => {
    const confirmed = await createConfirmedDraft("rundraft_store_launch_reuse");
    if (!confirmed.plan) throw new Error("Expected a stored dry-run plan");
    const launchInput = {
      draft_id: confirmed.draft.draft_id,
      adapter_ready: true,
      draft_plan_id: confirmed.plan.draft_plan_id,
      plan_hash: confirmed.plan.plan_hash,
      confirmation_id: confirmed.confirmation.confirmation_id,
      actor: "operator",
      launch: async () => ({ run_id: "run_reused" })
    };

    await expect(store.requestLaunch(launchInput)).resolves.toEqual({ run_id: "run_reused", reused: false });
    await writeFile(path.join(workflowsDir, `${workflow.id}.json`), JSON.stringify({ ...workflow, version: "0.2.0" }), "utf8");
    await expect(store.requestLaunch(launchInput)).resolves.toEqual({ run_id: "run_reused", reused: true });
    await expect(store.requestLaunch({ ...launchInput, confirmation_id: "launch_confirm_other" })).rejects.toMatchObject({ code: "launch_handoff_required" });
  });

  it("recovers the previous complete bundle after a crashed multi-file transaction", async () => {
    const created = await store.create({ draft_id: "rundraft_store_recovery", workflow_id: workflow.id, actor: "operator" });
    const draftDir = path.join(workspaceDir, "run-drafts", created.draft.draft_id);
    const transactionDir = path.join(workspaceDir, "run-drafts", `.${created.draft.draft_id}.transaction`);
    await mkdir(transactionDir, { recursive: true });
    await cp(draftDir, path.join(transactionDir, "backup"), { recursive: true });
    await writeFile(path.join(transactionDir, "metadata.json"), `${JSON.stringify({ existed: true })}\n`, "utf8");
    await writeFile(path.join(draftDir, "run_draft.json"), "{broken", "utf8");

    const recovered = await store.read(created.draft.draft_id);
    expect(recovered.draft).toEqual(created.draft);
    await expect(readFile(path.join(transactionDir, "metadata.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
