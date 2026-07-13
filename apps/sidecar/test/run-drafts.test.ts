import { beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  provider_policy: { default_provider: "codex-local", allowed_providers: ["codex-local"], required_credentials: ["VOLC_TTS_API_KEY"], fallback_providers: [] },
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
      credential_scopes: [{ credential_ref: "VOLC_TTS_API_KEY", required_for_branch: "video_package", blocking_scope: "optional_branch" }]
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

    expect(confirmed.draft.status).toBe("confirmed");
    expect(updated.confirmation).toMatchObject({ decision: "superseded" });
    expect(audit.map((entry) => entry.type)).toEqual(["run_draft_created", "dry_run_generated", "launch_confirmation_recorded", "run_draft_updated"]);
  });

  it("rejects an unavailable Adapter without changing a confirmed draft", async () => {
    const created = await store.create({ draft_id: "rundraft_store_002", workflow_id: workflow.id, enabled_optional_paths: ["video_package"], actor: "operator" });
    const planned = await store.dryRun({
      draft_id: created.draft.draft_id,
      expected_revision: created.draft.revision,
      actor: "operator",
      credential_scopes: [{ credential_ref: "VOLC_TTS_API_KEY", required_for_branch: "video_package", blocking_scope: "optional_branch" }]
    });
    const confirmed = await store.confirm({
      draft_id: planned.draft.draft_id,
      expected_revision: planned.draft.revision,
      plan_hash: planned.plan.plan_hash,
      actor: "operator",
      acknowledgements: planned.plan.required_acknowledgements
    });

    await expect(store.requestLaunch({ draft_id: confirmed.draft.draft_id, adapter_ready: false })).rejects.toBeInstanceOf(RunDraftStoreError);
    expect((await store.read(confirmed.draft.draft_id)).draft.status).toBe("confirmed");
  });
});
