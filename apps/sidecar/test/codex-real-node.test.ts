import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowSpec } from "@miracle/core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureWorkspace = path.join(repoRoot, "fixtures/mvp-workspace/.miracle");
const fakeCodex = path.join(repoRoot, "apps/sidecar/test/fixtures/bin/fake-codex.mjs");

const workflow: WorkflowSpec = {
  id: "codex-md-master-v0",
  name: "Codex Markdown master smoke workflow",
  version: "0.1.0",
  domain: "content-production",
  category: "content",
  nodes: [
    {
      id: "C_md_master",
      name: "内容 MD 母稿",
      type: "agent",
      capability_requirements: ["content.longform_draft", "fact.safe_writing"],
      recommended_libraries: ["content-packaging-library"],
      agent_candidates: ["content-agent"],
      inputs: [],
      outputs: [
        {
          id: "md_master",
          kind: "artifact",
          artifact_type: "markdown",
          artifact_spec_ref: "md_master_artifact",
          required: true
        }
      ],
      review_gate_ref: "C_md_master_gate",
      failure_policy: { retry: 0, on_missing_input: "blocked", on_provider_failure: "failed" }
    }
  ],
  edges: [],
  gates: [
    {
      id: "C_md_master_gate",
      name: "母稿人工审核",
      target_artifact_ref: "md_master_artifact",
      required_before: [],
      actions: ["approve", "reject", "request_changes"]
    }
  ],
  artifacts: [
    {
      id: "md_master_artifact",
      type: "markdown",
      produced_by: "C_md_master",
      review_policy: { mode: "manual", gate_spec_id: "C_md_master_gate" },
      required_for: [],
      versioning: { immutable: true, compare_by: "hash" }
    }
  ],
  provider_policy: {
    default_provider: "codex-local",
    allowed_providers: ["codex-local"],
    required_credentials: [],
    fallback_providers: []
  },
  layouts: { dag: { C_md_master: { x: 80, y: 80 } } },
  registry_meta: { source: "p6-integration-test", status: "experimental" }
};

const multiOutputWorkflow: WorkflowSpec = {
  ...workflow,
  id: "codex-multi-output-v0",
  name: "Codex multi-output smoke workflow",
  nodes: [{
    ...workflow.nodes[0]!,
    outputs: [
      { id: "summary", kind: "artifact", artifact_type: "report", artifact_spec_ref: "summary_artifact", required: true },
      { id: "voiceover", kind: "artifact", artifact_type: "script", artifact_spec_ref: "voiceover_artifact", required: true }
    ]
  }],
  gates: [],
  artifacts: [
    { id: "summary_artifact", type: "report", produced_by: "C_md_master", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } },
    { id: "voiceover_artifact", type: "script", produced_by: "C_md_master", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } }
  ]
};

const unsupportedOutputWorkflow: WorkflowSpec = {
  ...workflow,
  id: "codex-unsupported-output-v0",
  name: "Codex unsupported output smoke workflow",
  nodes: [{
    ...workflow.nodes[0]!,
    outputs: [{ id: "data", kind: "artifact", artifact_type: "json", artifact_spec_ref: "data_artifact", required: true }]
  }],
  gates: [],
  artifacts: [
    { id: "data_artifact", type: "json", produced_by: "C_md_master", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } }
  ]
};

let tempRoot = "";
let tempWorkspace = "";
let runtimeWorkspace = "";
let sidecar: ChildProcessWithoutNullStreams | undefined;
let baseUrl = "";
let sidecarOutput = "";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${url}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  const body = (await response.json()) as T;
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}: ${JSON.stringify(body)}`);
  return body;
}

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/v0/health`)).ok) return;
    } catch {
      // The Sidecar is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Sidecar did not become healthy.\n${sidecarOutput}`);
}

describe("P6-07 Codex real single-node execution", () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "miracle-p6-07-"));
    tempWorkspace = path.join(tempRoot, "workspace", ".miracle");
    runtimeWorkspace = path.join(tempRoot, "runtime");
    await cp(fixtureWorkspace, tempWorkspace, { recursive: true });
    await writeFile(path.join(tempWorkspace, "workflows", `${workflow.id}.json`), `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
    await writeFile(path.join(tempWorkspace, "workflows", `${multiOutputWorkflow.id}.json`), `${JSON.stringify(multiOutputWorkflow, null, 2)}\n`, "utf8");
    await writeFile(path.join(tempWorkspace, "workflows", `${unsupportedOutputWorkflow.id}.json`), `${JSON.stringify(unsupportedOutputWorkflow, null, 2)}\n`, "utf8");
    const port = 5600 + Math.floor(Math.random() * 300);
    baseUrl = `http://127.0.0.1:${port}`;
    sidecar = spawn("npm", ["run", "dev", "-w", "apps/sidecar"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MIRACLE_WORKSPACE_DIR: tempWorkspace,
        MIRACLE_WORKFLOW_REGISTRY_DIR: path.join(tempWorkspace, "workflows"),
        MIRACLE_RUNTIME_WORKSPACE_DIR: runtimeWorkspace,
        MIRACLE_SIDECAR_PORT: String(port),
        MIRACLE_CODEX_CLI_PATH: process.execPath,
        MIRACLE_CODEX_CLI_ARGUMENT_PREFIX: fakeCodex,
        MIRACLE_ENABLE_REAL_CODEX: "1",
        npm_config_cache: path.join(repoRoot, ".npm-cache")
      }
    });
    sidecar.stdout.on("data", (chunk) => { sidecarOutput += chunk.toString(); });
    sidecar.stderr.on("data", (chunk) => { sidecarOutput += chunk.toString(); });
    await waitForHealth();
  }, 20_000);

  afterAll(async () => {
    sidecar?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it("converts a confirmed draft and commits a validated Markdown artifact behind a pending gate", async () => {
    const created = await fetchJson<{ draft: { draft_id: string; revision: number } }>("/api/v0/run-drafts", {
      method: "POST",
      body: JSON.stringify({ workflow_id: workflow.id, inputs: { topic_brief: "Miracle P6-07 安全执行测试" }, execution_policy: "manual" })
    });
    const dryRun = await fetchJson<{
      draft: { revision: number };
      plan: { draft_plan_id: string; plan_hash: string; required_acknowledgements: string[] };
    }>(`/api/v0/run-drafts/${created.draft.draft_id}/dry-run`, {
      method: "POST",
      body: JSON.stringify({ expected_revision: created.draft.revision })
    });
    const confirmed = await fetchJson<{
      confirmation: { confirmation_id: string };
    }>(`/api/v0/run-drafts/${created.draft.draft_id}/confirmation`, {
      method: "POST",
      body: JSON.stringify({
        decision: "confirm",
        expected_revision: dryRun.draft.revision,
        plan_hash: dryRun.plan.plan_hash,
        acknowledgements: dryRun.plan.required_acknowledgements,
        actor: "p6-test"
      })
    });

    const launched = await fetchJson<{ run_id: string; reused: boolean }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({
        draft_id: created.draft.draft_id,
        draft_plan_id: dryRun.plan.draft_plan_id,
        plan_hash: dryRun.plan.plan_hash,
        confirmation_id: confirmed.confirmation.confirmation_id
      })
    });
    expect(launched.reused).toBe(false);

    const draftDir = path.join(tempWorkspace, "run-drafts", created.draft.draft_id);
    const draftPath = path.join(draftDir, "run_draft.json");
    const auditPath = path.join(draftDir, "draft_audit.jsonl");
    const convertedDraft = JSON.parse(await readFile(draftPath, "utf8")) as Record<string, unknown>;
    delete convertedDraft.converted_run_id;
    convertedDraft.status = "confirmed";
    convertedDraft.revision = Number(convertedDraft.revision) - 1;
    await writeFile(draftPath, `${JSON.stringify(convertedDraft, null, 2)}\n`, "utf8");
    const auditRecords = (await readFile(auditPath, "utf8")).trim().split("\n");
    await writeFile(auditPath, `${auditRecords.slice(0, -1).join("\n")}\n`, "utf8");

    const recovered = await fetchJson<{ run_id: string; reused: boolean }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({
        draft_id: created.draft.draft_id,
        draft_plan_id: dryRun.plan.draft_plan_id,
        plan_hash: dryRun.plan.plan_hash,
        confirmation_id: confirmed.confirmation.confirmation_id
      })
    });
    expect(recovered).toEqual({ run_id: launched.run_id, reused: true });
    expect((await readdir(path.join(tempWorkspace, "runs"))).filter((name) => name.startsWith(`run-${created.draft.draft_id}-`))).toEqual([launched.run_id]);

    const mismatchedRetry = await fetch(`${baseUrl}/api/v0/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft_id: created.draft.draft_id,
        draft_plan_id: dryRun.plan.draft_plan_id,
        plan_hash: dryRun.plan.plan_hash,
        confirmation_id: "launch_confirm_mismatched"
      })
    });
    expect(mismatchedRetry.status).toBe(409);

    const repeated = await fetchJson<{ run_id: string; reused: boolean }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({
        draft_id: created.draft.draft_id,
        draft_plan_id: dryRun.plan.draft_plan_id,
        plan_hash: dryRun.plan.plan_hash,
        confirmation_id: confirmed.confirmation.confirmation_id
      })
    });
    expect(repeated).toEqual({ run_id: launched.run_id, reused: true });

    const scheduled = await fetchJson<{ stop_reason: string; summary: { nodes_executed: number } }>(`/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 2, max_nodes_per_tick: 1 })
    });
    expect(scheduled.summary.nodes_executed).toBe(1);
    expect(scheduled.stop_reason).toBe("no_executable_nodes");

    const bundle = await fetchJson<{
      run: { resolved_components: string[] };
      nodes: Array<{ node_id: string; status: string; output_artifacts: string[] }>;
      attempts: Array<{ status: string; operation_id: string; provider_receipt: { adapter_id: string; latency_ms: number } }>;
      artifacts: Array<{ artifact_id: string; type: string; status: string; review_status: string; hash: string; path: string }>;
      gates: Array<{ status: string; target: { id: string } }>;
    }>(`/api/v0/runs/${launched.run_id}`);
    expect(bundle.run.resolved_components).toContain("codex-cli-real");
    expect(bundle.nodes).toEqual([expect.objectContaining({ node_id: "C_md_master", status: "reviewing", output_artifacts: [expect.any(String)] })]);
    expect(bundle.attempts).toEqual([expect.objectContaining({ status: "succeeded", provider_receipt: expect.objectContaining({ adapter_id: "codex-cli-real", latency_ms: expect.any(Number) }) })]);
    expect(bundle.artifacts).toEqual([
      expect.objectContaining({ type: "markdown", status: "created", review_status: "pending_review", hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) })
    ]);
    expect(bundle.gates).toEqual([expect.objectContaining({ status: "pending_review", target: expect.objectContaining({ id: bundle.artifacts[0]?.artifact_id }) })]);
    expect(await readFile(path.join(tempWorkspace, bundle.artifacts[0]!.path), "utf8")).toContain("Miracle P6-07");

    const events = await fetchJson<{ events: Array<{ type: string }> }>(`/api/v0/runs/${launched.run_id}/events`);
    const eventTypes = events.events.map((event) => event.type);
    expect(eventTypes.indexOf("runner_operation_dispatched")).toBeLessThan(eventTypes.indexOf("adapter_result_received"));
    expect(eventTypes.indexOf("adapter_result_received")).toBeLessThan(eventTypes.indexOf("node_run_committed"));
    expect(eventTypes.filter((type) => type === "artifact_manifest_created")).toHaveLength(1);

    const draft = await fetchJson<{ draft: { status: string; converted_run_id: string }; audit: Array<{ type: string }> }>(`/api/v0/run-drafts/${created.draft.draft_id}`);
    expect(draft.draft).toMatchObject({ status: "converted", converted_run_id: launched.run_id });
    expect(draft.audit.map((record) => record.type)).toContain("run_draft_converted");
  });

  it("aborts an invalid Codex output without creating artifact or gate facts", async () => {
    const created = await fetchJson<{ draft: { draft_id: string; revision: number } }>("/api/v0/run-drafts", {
      method: "POST",
      body: JSON.stringify({ workflow_id: workflow.id, inputs: { force_invalid_output: true }, execution_policy: "manual" })
    });
    const dryRun = await fetchJson<{
      draft: { revision: number };
      plan: { draft_plan_id: string; plan_hash: string; required_acknowledgements: string[] };
    }>(`/api/v0/run-drafts/${created.draft.draft_id}/dry-run`, {
      method: "POST",
      body: JSON.stringify({ expected_revision: created.draft.revision })
    });
    const confirmed = await fetchJson<{ confirmation: { confirmation_id: string } }>(`/api/v0/run-drafts/${created.draft.draft_id}/confirmation`, {
      method: "POST",
      body: JSON.stringify({
        decision: "confirm",
        expected_revision: dryRun.draft.revision,
        plan_hash: dryRun.plan.plan_hash,
        acknowledgements: dryRun.plan.required_acknowledgements,
        actor: "p6-test"
      })
    });
    const launched = await fetchJson<{ run_id: string }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({
        draft_id: created.draft.draft_id,
        draft_plan_id: dryRun.plan.draft_plan_id,
        plan_hash: dryRun.plan.plan_hash,
        confirmation_id: confirmed.confirmation.confirmation_id
      })
    });
    const scheduled = await fetchJson<{ stop_reason: string; summary: { failures: number } }>(`/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    expect(scheduled).toMatchObject({ stop_reason: "execution_failed", summary: { failures: 1 } });

    const bundle = await fetchJson<{
      nodes: Array<{ status: string }>;
      attempts: Array<{ status: string; error?: { code: string } }>;
      artifacts: unknown[];
      gates: unknown[];
    }>(`/api/v0/runs/${launched.run_id}`);
    expect(bundle.nodes[0]?.status).toBe("failed");
    expect(bundle.attempts).toEqual([expect.objectContaining({ status: "aborted", error: expect.objectContaining({ code: "invalid_codex_artifact_output" }) })]);
    expect(bundle.artifacts).toEqual([]);
    expect(bundle.gates).toEqual([]);
  });

  it("commits every NodeSpec output returned by the Codex output contract", async () => {
    const created = await fetchJson<{ draft: { draft_id: string; revision: number } }>("/api/v0/run-drafts", {
      method: "POST",
      body: JSON.stringify({ workflow_id: multiOutputWorkflow.id, inputs: { force_multi_output: true }, execution_policy: "manual" })
    });
    const dryRun = await fetchJson<{ draft: { revision: number }; plan: { draft_plan_id: string; plan_hash: string; required_acknowledgements: string[] } }>(`/api/v0/run-drafts/${created.draft.draft_id}/dry-run`, {
      method: "POST",
      body: JSON.stringify({ expected_revision: created.draft.revision })
    });
    const confirmed = await fetchJson<{ confirmation: { confirmation_id: string } }>(`/api/v0/run-drafts/${created.draft.draft_id}/confirmation`, {
      method: "POST",
      body: JSON.stringify({ decision: "confirm", expected_revision: dryRun.draft.revision, plan_hash: dryRun.plan.plan_hash, acknowledgements: dryRun.plan.required_acknowledgements, actor: "p7-test" })
    });
    const launched = await fetchJson<{ run_id: string }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ draft_id: created.draft.draft_id, draft_plan_id: dryRun.plan.draft_plan_id, plan_hash: dryRun.plan.plan_hash, confirmation_id: confirmed.confirmation.confirmation_id })
    });
    await fetchJson(`/api/v0/runs/${launched.run_id}/scheduler/run`, { method: "POST", body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 }) });

    const bundle = await fetchJson<{ nodes: Array<{ status: string }>; artifacts: Array<{ type: string; path: string }> }>(`/api/v0/runs/${launched.run_id}`);
    expect(bundle.nodes).toEqual([expect.objectContaining({ status: "done" })]);
    expect(bundle.artifacts.map((artifact) => artifact.type).sort()).toEqual(["report", "script"]);
    await expect(readFile(path.join(tempWorkspace, bundle.artifacts.find((artifact) => artifact.type === "report")!.path), "utf8")).resolves.toContain("Miracle P7-03");
  });

  it("blocks unsupported output types before creating an attempt workspace", async () => {
    const created = await fetchJson<{ draft: { draft_id: string; revision: number } }>("/api/v0/run-drafts", {
      method: "POST",
      body: JSON.stringify({ workflow_id: unsupportedOutputWorkflow.id, inputs: {}, execution_policy: "manual" })
    });
    const dryRun = await fetchJson<{ draft: { revision: number }; plan: { draft_plan_id: string; plan_hash: string; required_acknowledgements: string[] } }>(`/api/v0/run-drafts/${created.draft.draft_id}/dry-run`, {
      method: "POST",
      body: JSON.stringify({ expected_revision: created.draft.revision })
    });
    const confirmed = await fetchJson<{ confirmation: { confirmation_id: string } }>(`/api/v0/run-drafts/${created.draft.draft_id}/confirmation`, {
      method: "POST",
      body: JSON.stringify({ decision: "confirm", expected_revision: dryRun.draft.revision, plan_hash: dryRun.plan.plan_hash, acknowledgements: dryRun.plan.required_acknowledgements, actor: "p7-test" })
    });
    const before = await readdir(path.join(runtimeWorkspace, "runtime", "attempts"));
    const launched = await fetchJson<{ run_id: string }>("/api/v0/runs", {
      method: "POST",
      body: JSON.stringify({ draft_id: created.draft.draft_id, draft_plan_id: dryRun.plan.draft_plan_id, plan_hash: dryRun.plan.plan_hash, confirmation_id: confirmed.confirmation.confirmation_id })
    });
    const scheduled = await fetchJson<{ summary: { failures: number } }>(`/api/v0/runs/${launched.run_id}/scheduler/run`, { method: "POST", body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 }) });
    const bundle = await fetchJson<{ attempts: Array<{ status: string; error?: { code: string; recoverable: boolean } }>; artifacts: unknown[] }>(`/api/v0/runs/${launched.run_id}`);

    expect(scheduled.summary.failures).toBe(1);
    expect(bundle.attempts).toEqual([expect.objectContaining({ status: "failed", error: expect.objectContaining({ code: "unsupported_codex_output_type", recoverable: false }) })]);
    expect(bundle.artifacts).toEqual([]);
    expect(await readdir(path.join(runtimeWorkspace, "runtime", "attempts"))).toEqual(before);
  });
});
