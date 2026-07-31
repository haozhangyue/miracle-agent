import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createAdapterInvocation,
  type NodeAttempt,
  type NodeRun,
  type RetryScheduleRecord,
  type RunSpec,
  type WorkflowSpec
} from "@miracle/core";

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

const retryingWorkflow: WorkflowSpec = {
  ...workflow,
  id: "codex-retry-once-v0",
  name: "Codex retry once workflow",
  nodes: workflow.nodes.map((node) => ({
    ...node,
    failure_policy: {
      ...node.failure_policy,
      retry: 1,
      retry_policy: {
        max_attempts: 2,
        backoff: "fixed",
        initial_delay_ms: 0,
        max_delay_ms: 0,
        retryable_error_codes: ["adapter_process_error"],
        attempt_timeout_ms: 5_000,
        total_time_budget_ms: 30_000,
        cost_budget: 5
      }
    }
  }))
};

const shortBudgetRetryingWorkflow: WorkflowSpec = {
  ...retryingWorkflow,
  id: "codex-retry-short-budget-v0",
  name: "Codex retry prepared intent recovery workflow",
  nodes: retryingWorkflow.nodes.map((node) => ({
    ...node,
    failure_policy: {
      ...node.failure_policy,
      retry_policy: {
        ...node.failure_policy.retry_policy!,
        attempt_timeout_ms: 6_000,
        total_time_budget_ms: 8_000
      }
    }
  }))
};

const multiOutputWorkflow: WorkflowSpec = {
  ...workflow,
  id: "codex-multi-output-v0",
  name: "Codex multi-output smoke workflow",
  nodes: [{
    ...workflow.nodes[0]!,
    review_gate_ref: undefined,
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
    review_gate_ref: undefined,
    outputs: [{ id: "data", kind: "artifact", artifact_type: "json", artifact_spec_ref: "data_artifact", required: true }]
  }],
  gates: [],
  artifacts: [
    { id: "data_artifact", type: "json", produced_by: "C_md_master", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } }
  ]
};

const handoffWorkflow: WorkflowSpec = {
  ...workflow,
  id: "codex-artifact-handoff-v0",
  name: "Codex explicit artifact handoff workflow",
  nodes: [
    {
      ...workflow.nodes[0]!,
      id: "A_generate",
      review_gate_ref: undefined,
      outputs: [{ id: "upstream", kind: "artifact", artifact_type: "markdown", artifact_spec_ref: "upstream_artifact", required: true }]
    },
    {
      ...workflow.nodes[0]!,
      id: "B_consume",
      review_gate_ref: undefined,
      inputs: [{ id: "upstream_input", kind: "artifact", artifact_type: "markdown", artifact_spec_ref: "upstream_artifact", required: true }],
      outputs: [{ id: "downstream", kind: "artifact", artifact_type: "markdown", artifact_spec_ref: "downstream_artifact", required: true }]
    }
  ],
  edges: [{ from: "A_generate", to: "B_consume", required: true, artifact_selector: { artifact_type: "markdown" }, join_policy: { wait_if_active: false, on_timeout: "continue_if_required_inputs_ready", on_no_qualified_artifact: "block_downstream" } }],
  gates: [],
  artifacts: [
    { id: "upstream_artifact", type: "markdown", produced_by: "A_generate", review_policy: { mode: "none" }, required_for: ["B_consume"], versioning: { immutable: true, compare_by: "hash" } },
    { id: "downstream_artifact", type: "markdown", produced_by: "B_consume", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } }
  ],
  layouts: { dag: { A_generate: { x: 80, y: 80 }, B_consume: { x: 320, y: 80 } } }
};

const collisionOutputWorkflow: WorkflowSpec = {
  ...workflow,
  id: "codex-output-id-collision-v0",
  name: "Codex output identity collision workflow",
  nodes: [{
    ...workflow.nodes[0]!,
    review_gate_ref: undefined,
    outputs: [
      { id: "a/b", kind: "artifact", artifact_type: "report", artifact_spec_ref: "slash_artifact", required: true },
      { id: "a?b", kind: "artifact", artifact_type: "script", artifact_spec_ref: "question_artifact", required: true }
    ]
  }],
  gates: [],
  artifacts: [
    { id: "slash_artifact", type: "report", produced_by: "C_md_master", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } },
    { id: "question_artifact", type: "script", produced_by: "C_md_master", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } }
  ]
};

const caseCollisionOutputWorkflow: WorkflowSpec = {
  ...workflow,
  id: "codex-output-id-case-collision-v0",
  name: "Codex case-insensitive output identity collision workflow",
  nodes: [{
    ...workflow.nodes[0]!,
    review_gate_ref: undefined,
    outputs: [
      { id: "Summary", kind: "artifact", artifact_type: "report", artifact_spec_ref: "upper_summary_artifact", required: true },
      { id: "summary", kind: "artifact", artifact_type: "script", artifact_spec_ref: "lower_summary_artifact", required: true }
    ]
  }],
  gates: [],
  artifacts: [
    { id: "upper_summary_artifact", type: "report", produced_by: "C_md_master", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } },
    { id: "lower_summary_artifact", type: "script", produced_by: "C_md_master", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } }
  ]
};

const longOutputIdWorkflow: WorkflowSpec = {
  ...workflow,
  id: "codex-long-output-id-v0",
  name: "Codex bounded output identity workflow",
  nodes: [{
    ...workflow.nodes[0]!,
    review_gate_ref: undefined,
    outputs: [{
      id: "x".repeat(256),
      kind: "artifact",
      artifact_type: "report",
      artifact_spec_ref: "long_output_artifact",
      required: true
    }]
  }],
  gates: [],
  artifacts: [
    { id: "long_output_artifact", type: "report", produced_by: "C_md_master", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } }
  ]
};

const suffixCollisionOutputWorkflow: WorkflowSpec = {
  ...workflow,
  id: "codex-output-id-suffix-collision-v0",
  name: "Codex output hash suffix collision workflow",
  nodes: [{
    ...workflow.nodes[0]!,
    review_gate_ref: undefined,
    outputs: [
      { id: "a/b", kind: "artifact", artifact_type: "report", artifact_spec_ref: "slash_artifact", required: true },
      { id: "a?b", kind: "artifact", artifact_type: "script", artifact_spec_ref: "question_artifact", required: true },
      { id: "a_b_c14cddc033f6", kind: "artifact", artifact_type: "outline", artifact_spec_ref: "raw_suffix_artifact", required: true }
    ]
  }],
  gates: [],
  artifacts: [
    { id: "slash_artifact", type: "report", produced_by: "C_md_master", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } },
    { id: "question_artifact", type: "script", produced_by: "C_md_master", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } },
    { id: "raw_suffix_artifact", type: "outline", produced_by: "C_md_master", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } }
  ]
};

const duplicateSummaryWorkflow: WorkflowSpec = {
  ...workflow,
  id: "codex-duplicate-summary-v0",
  name: "Codex duplicate summary output workflow",
  nodes: [{
    ...workflow.nodes[0]!,
    review_gate_ref: undefined,
    outputs: [
      { id: "summary", kind: "artifact", artifact_type: "report", artifact_spec_ref: "summary_artifact", required: true },
      { id: "summary", kind: "artifact", artifact_type: "report", artifact_spec_ref: "optional_summary_artifact", required: false }
    ]
  }],
  gates: [],
  artifacts: [
    { id: "summary_artifact", type: "report", produced_by: "C_md_master", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } },
    { id: "optional_summary_artifact", type: "report", produced_by: "C_md_master", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } }
  ]
};

const twoNodeIdentityCollisionWorkflow: WorkflowSpec = {
  ...workflow,
  id: "codex-two-node-identity-collision-v0",
  name: "Codex two-node Artifact identity collision workflow",
  nodes: [
    {
      ...workflow.nodes[0]!,
      id: "A/B",
      review_gate_ref: undefined,
      outputs: [
        { id: "primary", kind: "artifact", artifact_type: "markdown", artifact_spec_ref: "slash_node_artifact", required: true }
      ]
    },
    {
      ...workflow.nodes[0]!,
      id: "A?B",
      review_gate_ref: undefined,
      outputs: [
        { id: "primary", kind: "artifact", artifact_type: "markdown", artifact_spec_ref: "question_node_artifact", required: true }
      ]
    }
  ],
  edges: [],
  gates: [],
  artifacts: [
    { id: "slash_node_artifact", type: "markdown", produced_by: "A/B", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } },
    { id: "question_node_artifact", type: "markdown", produced_by: "A?B", review_policy: { mode: "none" }, required_for: [], versioning: { immutable: true, compare_by: "hash" } }
  ],
  layouts: { dag: { "A/B": { x: 80, y: 80 }, "A?B": { x: 320, y: 80 } } }
};

function schemaLimitWorkflow(id: string, outputs: WorkflowSpec["nodes"][number]["outputs"]): WorkflowSpec {
  return {
    ...workflow,
    id,
    name: `Codex Structured Outputs limit workflow ${id}`,
    nodes: [{
      ...workflow.nodes[0]!,
      review_gate_ref: undefined,
      outputs
    }],
    gates: [],
    artifacts: []
  };
}

const propertyLimitWorkflow = schemaLimitWorkflow(
  "codex-schema-property-limit-v0",
  Array.from({ length: 1_667 }, (_, index) => ({
    id: `output_${index}`,
    kind: "artifact" as const,
    artifact_type: "report",
    required: true
  }))
);

const stringLimitWorkflow = schemaLimitWorkflow(
  "codex-schema-string-limit-v0",
  Array.from({ length: 500 }, (_, index) => ({
    id: `output_${index}_${"x".repeat(240)}`,
    kind: "artifact" as const,
    artifact_type: "report",
    required: true
  }))
);

let tempRoot = "";
let tempWorkspace = "";
let runtimeWorkspace = "";
let sidecar: ChildProcessWithoutNullStreams | undefined;
let baseUrl = "";
let sidecarOutput = "";
let fakeCodexMarker = "";
let fakeCodexWrapper = "";
let staleStartupLock = "";
let sidecarPort = 0;

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

async function startSidecar() {
  sidecar = spawn("npm", ["run", "dev", "-w", "apps/sidecar"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MIRACLE_WORKSPACE_DIR: tempWorkspace,
      MIRACLE_WORKFLOW_REGISTRY_DIR: path.join(tempWorkspace, "workflows"),
      MIRACLE_RUNTIME_WORKSPACE_DIR: runtimeWorkspace,
      MIRACLE_SIDECAR_PORT: String(sidecarPort),
      MIRACLE_CODEX_CLI_PATH: process.execPath,
      MIRACLE_CODEX_CLI_ARGUMENT_PREFIX: fakeCodexWrapper,
      MIRACLE_ENABLE_REAL_CODEX: "1",
      FAKE_CODEX_EXEC_MARKER: fakeCodexMarker,
      npm_config_cache: path.join(repoRoot, ".npm-cache")
    }
  });
  sidecar.stdout.on("data", (chunk) => { sidecarOutput += chunk.toString(); });
  sidecar.stderr.on("data", (chunk) => { sidecarOutput += chunk.toString(); });
  await waitForHealth();
}

async function stopSidecar() {
  const active = sidecar;
  if (!active) return;
  sidecar = undefined;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Sidecar did not stop")), 10_000);
    active.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    active.kill("SIGTERM");
  });
}

async function fakeCodexDispatchCount() {
  try {
    return (await readFile(fakeCodexMarker, "utf8")).split("\n").filter(Boolean).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function writeFakeCodexWrapper(mode: "healthy" | "missing" | "authentication_error" | "permission" = "healthy") {
  await writeFile(
    fakeCodexWrapper,
    `process.env.FAKE_CODEX_EXEC_MARKER = ${JSON.stringify(fakeCodexMarker)};\n`
      + (mode === "missing" ? 'process.env.FAKE_CODEX_LOGIN = "missing";\n' : "")
      + (mode === "authentication_error" ? 'process.env.FAKE_CODEX_LOGIN = "error";\n' : "")
      + (mode === "permission" ? 'process.env.FAKE_CODEX_PERMISSION = "denied";\n' : "")
      + `await import(${JSON.stringify(pathToFileURL(fakeCodex).href)});\n`,
    "utf8"
  );
}

async function runStartupProbe(workspace: string, runtime: string) {
  const probePort = 5900 + Math.floor(Math.random() * 500);
  const child = spawn("npm", ["run", "dev", "-w", "apps/sidecar"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MIRACLE_WORKSPACE_DIR: workspace,
      MIRACLE_WORKFLOW_REGISTRY_DIR: path.join(workspace, "workflows"),
      MIRACLE_RUNTIME_WORKSPACE_DIR: runtime,
      MIRACLE_SIDECAR_PORT: String(probePort),
      MIRACLE_CODEX_CLI_PATH: process.execPath,
      MIRACLE_CODEX_CLI_ARGUMENT_PREFIX: fakeCodex,
      npm_config_cache: path.join(repoRoot, ".npm-cache")
    }
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const result = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Startup probe did not exit.\n${output}`)), 10_000);
    })
  ]).finally(() => {
    if (!child.killed) child.kill("SIGTERM");
  });
  return { ...result, output };
}

async function launchConfirmedRun(workflowId: string, inputs: Record<string, unknown> = {}) {
  const created = await fetchJson<{ draft: { draft_id: string; revision: number } }>("/api/v0/run-drafts", {
    method: "POST",
    body: JSON.stringify({ workflow_id: workflowId, inputs, execution_policy: "manual" })
  });
  const dryRun = await fetchJson<{ draft: { revision: number }; plan: { draft_plan_id: string; plan_hash: string; required_acknowledgements: string[] } }>(`/api/v0/run-drafts/${created.draft.draft_id}/dry-run`, {
    method: "POST",
    body: JSON.stringify({ expected_revision: created.draft.revision })
  });
  const confirmed = await fetchJson<{ confirmation: { confirmation_id: string } }>(`/api/v0/run-drafts/${created.draft.draft_id}/confirmation`, {
    method: "POST",
    body: JSON.stringify({ decision: "confirm", expected_revision: dryRun.draft.revision, plan_hash: dryRun.plan.plan_hash, acknowledgements: dryRun.plan.required_acknowledgements, actor: "p7-review-test" })
  });
  return fetchJson<{ run_id: string }>("/api/v0/runs", {
    method: "POST",
    body: JSON.stringify({ draft_id: created.draft.draft_id, draft_plan_id: dryRun.plan.draft_plan_id, plan_hash: dryRun.plan.plan_hash, confirmation_id: confirmed.confirmation.confirmation_id })
  });
}

function expectedSingleArtifactId(runId: string, nodeId: string, outputId: string) {
  const bounded = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32) || "id";
  const suffix = createHash("sha256").update(JSON.stringify([runId, nodeId, outputId])).digest("hex");
  return `art_${bounded(runId)}_${bounded(nodeId)}_${outputId}_${suffix}_v1`;
}

function nodeDispatchIntentPath(runId: string, nodeRunId: string) {
  const prefix = nodeRunId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48) || "node";
  const suffix = createHash("sha256").update(nodeRunId).digest("hex").slice(0, 16);
  return path.join(tempWorkspace, "runs", runId, "dispatches", `${prefix}_${suffix}.json`);
}

function preparedRetryIntent(input: {
  run: RunSpec;
  node: NodeRun;
  attempt: NodeAttempt;
  schedule: RetryScheduleRecord;
  preparedAt: string;
}) {
  const startedAt = input.attempt.started_at ?? input.attempt.dispatched_at ?? input.attempt.created_at;
  if (!startedAt) throw new Error("Expected retry source timing");
  const operationDeadlineAt = new Date(
    Date.parse(startedAt) + shortBudgetRetryingWorkflow.nodes[0]!.failure_policy.retry_policy!.total_time_budget_ms
  ).toISOString();
  const remainingTotalBudgetMs = Date.parse(operationDeadlineAt) - Date.parse(input.preparedAt);
  const invocation = createAdapterInvocation({
    runSpec: input.run,
    workflow: shortBudgetRetryingWorkflow,
    nodeRun: input.node,
    createdAt: input.preparedAt,
    adapterKind: "codex",
    adapterId: "codex-cli-real",
    resolvedInputs: [],
    operationId: input.schedule.operation_id,
    attemptNumber: input.schedule.attempt_number,
    remainingTotalBudgetMs
  });
  return {
    node_run_id: input.node.node_run_id,
    invocation,
    decision: {
      reason_code: input.schedule.reason_code,
      resolved_input_count: 0,
      resolved_input_ids: [] as string[]
    },
    event: {
      event_id: `evt_${invocation.attempt_id}_inputs_resolved`,
      run_id: input.run.run_id,
      type: "node_inputs_resolved",
      subject: { type: "NodeRun", id: input.node.node_run_id },
      message: `NodeRun ${input.node.node_run_id} resolved 0 input(s); reason_code=${input.schedule.reason_code}`,
      created_at: input.preparedAt
    },
    state: "prepared",
    prepared_at: input.preparedAt,
    operation_deadline_at: operationDeadlineAt
  };
}

describe("P6-07 Codex real single-node execution", () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "miracle-p6-07-"));
    tempWorkspace = path.join(tempRoot, "workspace", ".miracle");
    runtimeWorkspace = path.join(tempRoot, "runtime");
    fakeCodexMarker = path.join(tempRoot, "fake-codex-exec.jsonl");
    fakeCodexWrapper = path.join(tempRoot, "fake-codex-with-counter.mjs");
    await writeFakeCodexWrapper();
    await cp(fixtureWorkspace, tempWorkspace, { recursive: true });
    await writeFile(path.join(tempWorkspace, "workflows", `${workflow.id}.json`), `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
    await writeFile(path.join(tempWorkspace, "workflows", `${retryingWorkflow.id}.json`), `${JSON.stringify(retryingWorkflow, null, 2)}\n`, "utf8");
    await writeFile(path.join(tempWorkspace, "workflows", `${shortBudgetRetryingWorkflow.id}.json`), `${JSON.stringify(shortBudgetRetryingWorkflow, null, 2)}\n`, "utf8");
    await writeFile(path.join(tempWorkspace, "workflows", `${multiOutputWorkflow.id}.json`), `${JSON.stringify(multiOutputWorkflow, null, 2)}\n`, "utf8");
    await writeFile(path.join(tempWorkspace, "workflows", `${unsupportedOutputWorkflow.id}.json`), `${JSON.stringify(unsupportedOutputWorkflow, null, 2)}\n`, "utf8");
    await writeFile(path.join(tempWorkspace, "workflows", `${handoffWorkflow.id}.json`), `${JSON.stringify(handoffWorkflow, null, 2)}\n`, "utf8");
    await writeFile(path.join(tempWorkspace, "workflows", `${collisionOutputWorkflow.id}.json`), `${JSON.stringify(collisionOutputWorkflow, null, 2)}\n`, "utf8");
    await writeFile(path.join(tempWorkspace, "workflows", `${caseCollisionOutputWorkflow.id}.json`), `${JSON.stringify(caseCollisionOutputWorkflow, null, 2)}\n`, "utf8");
    await writeFile(path.join(tempWorkspace, "workflows", `${longOutputIdWorkflow.id}.json`), `${JSON.stringify(longOutputIdWorkflow, null, 2)}\n`, "utf8");
    await writeFile(path.join(tempWorkspace, "workflows", `${suffixCollisionOutputWorkflow.id}.json`), `${JSON.stringify(suffixCollisionOutputWorkflow, null, 2)}\n`, "utf8");
    await writeFile(path.join(tempWorkspace, "workflows", `${duplicateSummaryWorkflow.id}.json`), `${JSON.stringify(duplicateSummaryWorkflow, null, 2)}\n`, "utf8");
    await writeFile(path.join(tempWorkspace, "workflows", `${twoNodeIdentityCollisionWorkflow.id}.json`), `${JSON.stringify(twoNodeIdentityCollisionWorkflow, null, 2)}\n`, "utf8");
    await writeFile(path.join(tempWorkspace, "workflows", `${propertyLimitWorkflow.id}.json`), `${JSON.stringify(propertyLimitWorkflow, null, 2)}\n`, "utf8");
    await writeFile(path.join(tempWorkspace, "workflows", `${stringLimitWorkflow.id}.json`), `${JSON.stringify(stringLimitWorkflow, null, 2)}\n`, "utf8");
    staleStartupLock = path.join(tempWorkspace, "runs", "run-demo-001", "locks", "run-demo-001.mutation.lock");
    await mkdir(staleStartupLock, { recursive: true });
    await writeFile(
      path.join(staleStartupLock, "owner.json"),
      `${JSON.stringify({ instance_id: "dead-sidecar", owner_token: "stale", pid: 2_147_483_647, created_at: "2020-01-01T00:00:00.000Z" })}\n`,
      "utf8"
    );
    sidecarPort = 5600 + Math.floor(Math.random() * 300);
    baseUrl = `http://127.0.0.1:${sidecarPort}`;
    await startSidecar();
  }, 20_000);

  afterAll(async () => {
    await stopSidecar();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it("recovers a mutation lock owned by a dead process before accepting requests", async () => {
    await expect(stat(staleStartupLock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a second Sidecar that targets the same workspace", async () => {
    const probe = await runStartupProbe(tempWorkspace, path.join(tempRoot, "second-runtime"));

    expect(probe.code).not.toBe(0);
    expect(probe.output).toContain("Workspace is already owned by active Sidecar process");
  });

  it("fails closed when a mutation lock owner cannot be verified", async () => {
    const probeWorkspace = path.join(tempRoot, "invalid-owner-workspace", ".miracle");
    await cp(fixtureWorkspace, probeWorkspace, { recursive: true });
    const lockDir = path.join(probeWorkspace, "runs", "run-demo-001", "locks", "run-demo-001.mutation.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), "{}\n", "utf8");

    const probe = await runStartupProbe(probeWorkspace, path.join(tempRoot, "invalid-owner-runtime"));

    expect(probe.code).not.toBe(0);
    expect(probe.output).toContain("Refusing to recover mutation lock without verifiable owner metadata");
    await expect(stat(lockDir)).resolves.toBeDefined();
  });

  it("does not replace an empty workspace instance lock during startup", async () => {
    const probeWorkspace = path.join(tempRoot, "empty-instance-lock-workspace", ".miracle");
    const instanceLock = path.join(probeWorkspace, "locks", "sidecar.instance.lock");
    await cp(fixtureWorkspace, probeWorkspace, { recursive: true });
    await mkdir(instanceLock, { recursive: true });

    const probe = await runStartupProbe(probeWorkspace, path.join(tempRoot, "empty-instance-lock-runtime"));

    expect(probe.code).not.toBe(0);
    expect(probe.output).toContain("Refusing to recover mutation lock without verifiable owner metadata");
    await expect(stat(instanceLock)).resolves.toBeDefined();
  });

  it("fails closed on a dead workspace instance owner until an operator removes the lock", async () => {
    const probeWorkspace = path.join(tempRoot, "dead-instance-lock-workspace", ".miracle");
    const instanceLock = path.join(probeWorkspace, "locks", "sidecar.instance.lock");
    await cp(fixtureWorkspace, probeWorkspace, { recursive: true });
    await mkdir(instanceLock, { recursive: true });
    await writeFile(
      path.join(instanceLock, "owner.json"),
      `${JSON.stringify({
        instance_id: "dead-sidecar",
        owner_token: "dead-owner",
        pid: 2_147_483_647,
        created_at: "2020-01-01T00:00:00.000Z"
      })}\n`,
      "utf8"
    );

    const probe = await runStartupProbe(probeWorkspace, path.join(tempRoot, "dead-instance-lock-runtime"));

    expect(probe.code).not.toBe(0);
    expect(probe.output).toContain("Remove the stale Sidecar instance lock only after confirming no process uses this workspace");
    await expect(stat(instanceLock)).resolves.toBeDefined();
  });

  it("refuses a symlinked locks root without touching its external target", async () => {
    const probeWorkspace = path.join(tempRoot, "symlink-lock-workspace", ".miracle");
    const externalLocks = path.join(tempRoot, "external-locks");
    const locksPath = path.join(probeWorkspace, "runs", "run-demo-001", "locks");
    await cp(fixtureWorkspace, probeWorkspace, { recursive: true });
    await mkdir(externalLocks, { recursive: true });
    await writeFile(path.join(externalLocks, "sentinel.txt"), "keep\n", "utf8");
    await rm(locksPath, { recursive: true, force: true });
    await symlink(externalLocks, locksPath, "dir");

    const probe = await runStartupProbe(probeWorkspace, path.join(tempRoot, "symlink-lock-runtime"));

    expect(probe.code).not.toBe(0);
    expect(probe.output).toContain("Refusing symlinked mutation locks directory");
    await expect(readFile(path.join(externalLocks, "sentinel.txt"), "utf8")).resolves.toBe("keep\n");
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

  it("does not follow a child-controlled formal Artifact link during commit", async () => {
    const launched = await launchConfirmedRun(workflow.id);
    const artifactId = expectedSingleArtifactId(launched.run_id, "C_md_master", "md_master");
    const external = path.join(tempRoot, "external-formal-artifact.md");
    const target = path.join(tempWorkspace, "artifacts", `${artifactId}.md`);
    await writeFile(external, "external remains unchanged\n", "utf8");
    await symlink(external, target);

    const response = await fetch(`${baseUrl}/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    const scheduled = await response.json() as { summary: { failures: number; nodes_executed: number } };
    const bundle = await fetchJson<{ artifacts: unknown[]; gates: unknown[] }>(`/api/v0/runs/${launched.run_id}`);

    expect(response.status).toBe(200);
    expect(scheduled.summary).toEqual(expect.objectContaining({ failures: 1, nodes_executed: 0 }));
    expect(await readFile(external, "utf8")).toBe("external remains unchanged\n");
    expect(bundle.artifacts).toEqual([]);
    expect(bundle.gates).toEqual([]);
  });

  it("rolls back earlier files when a later Artifact in the same output batch is unsafe", async () => {
    const launched = await launchConfirmedRun(multiOutputWorkflow.id, { force_multi_output: true });
    const voiceoverId = expectedSingleArtifactId(launched.run_id, "C_md_master", "voiceover");
    const summaryId = expectedSingleArtifactId(launched.run_id, "C_md_master", "summary");
    const voiceoverPath = path.join(tempWorkspace, "artifacts", `${voiceoverId}.md`);
    const summaryPath = path.join(tempWorkspace, "artifacts", `${summaryId}.md`);
    const external = path.join(tempRoot, "external-batch-artifact.md");
    await writeFile(external, "external remains unchanged\n", "utf8");
    await symlink(external, summaryPath);

    await fetchJson(`/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    const bundle = await fetchJson<{ artifacts: unknown[] }>(`/api/v0/runs/${launched.run_id}`);

    await expect(readFile(voiceoverPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(external, "utf8")).toBe("external remains unchanged\n");
    expect(bundle.artifacts).toEqual([]);
  });

  it("reuses an existing immutable Artifact file when its content hash matches", async () => {
    const launched = await launchConfirmedRun(multiOutputWorkflow.id, { force_multi_output: true });
    const existing = [
      { outputId: "voiceover", content: "这是经校验的口播稿。" },
      { outputId: "summary", content: "# Miracle P7-03\n\n这是经校验的报告。\n" }
    ];
    for (const item of existing) {
      const artifactId = expectedSingleArtifactId(launched.run_id, "C_md_master", item.outputId);
      await writeFile(path.join(tempWorkspace, "artifacts", `${artifactId}.md`), item.content, "utf8");
    }

    const scheduled = await fetchJson<{ summary: { failures: number; nodes_executed: number } }>(`/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    const bundle = await fetchJson<{ artifacts: unknown[] }>(`/api/v0/runs/${launched.run_id}`);

    expect(scheduled.summary).toEqual(expect.objectContaining({ failures: 0, nodes_executed: 1 }));
    expect(bundle.artifacts).toHaveLength(2);
  });

  it("recovers a partial fact commit from the node journal without rerunning Codex", async () => {
    const dispatchCountBefore = await fakeCodexDispatchCount();
    const launched = await launchConfirmedRun(workflow.id, { force_slow_output: true });
    const dispatchesDir = path.join(tempWorkspace, "runs", launched.run_id, "dispatches");
    const transactionsDir = path.join(tempWorkspace, "runs", launched.run_id, "transactions");
    const firstRequest = fetch(`${baseUrl}/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    let runningObserved = false;
    for (let index = 0; index < 200; index += 1) {
      const current = await fetchJson<{ nodes: Array<{ status: string }> }>(`/api/v0/runs/${launched.run_id}`);
      if (current.nodes.some((node) => node.status === "running")) {
        runningObserved = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runningObserved).toBe(true);
    const dispatchVisibleEvents = await fetchJson<{ events: Array<{ type: string; event_id: string }> }>(`/api/v0/runs/${launched.run_id}/events`);
    expect(dispatchVisibleEvents.events.filter((event) => event.type === "node_inputs_resolved")).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [intentName] = await readdir(dispatchesDir);
    if (!intentName) throw new Error("Expected persisted dispatch intent");
    const intentPath = path.join(dispatchesDir, intentName);
    await rm(intentPath, { force: true });
    await mkdir(intentPath);
    await writeFile(path.join(intentPath, "hold"), "intent delete must fail", "utf8");
    const firstResponse = await firstRequest;
    const beforeRecoveryEvents = await fetchJson<{ events: Array<{ type: string }> }>(`/api/v0/runs/${launched.run_id}/events`);
    const attemptsAfterFailure = await readdir(path.join(runtimeWorkspace, "runtime", "attempts"));
    const dispatchCountAfterFailure = await fakeCodexDispatchCount();
    expect(dispatchCountAfterFailure).toBe(dispatchCountBefore + 1);
    expect((await readdir(transactionsDir)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    await rm(intentPath, { recursive: true, force: true });
    await stopSidecar();
    await startSidecar();

    const second = await fetchJson<{ summary: { failures: number; nodes_executed: number } }>(`/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    const bundle = await fetchJson<{ nodes: Array<{ status: string }>; artifacts: unknown[]; gates: unknown[] }>(`/api/v0/runs/${launched.run_id}`);
    const events = await fetchJson<{ events: Array<{ type: string; event_id: string }> }>(`/api/v0/runs/${launched.run_id}/events`);

    expect(firstResponse.status).toBe(500);
    expect(beforeRecoveryEvents.events.filter((event) => event.type === "node_inputs_resolved")).toHaveLength(1);
    expect(second.summary).toEqual(expect.objectContaining({ failures: 0, nodes_executed: 0 }));
    expect(await readdir(path.join(runtimeWorkspace, "runtime", "attempts"))).toEqual(attemptsAfterFailure);
    expect(bundle.nodes).toEqual([expect.objectContaining({ status: "reviewing" })]);
    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.gates).toHaveLength(1);
    expect(events.events.filter((event) => event.type === "node_inputs_resolved")).toHaveLength(1);
    expect(new Set(events.events.filter((event) => event.type === "node_inputs_resolved").map((event) => event.event_id)).size).toBe(1);
    expect((await readdir(transactionsDir)).filter((name) => name.endsWith(".json"))).toEqual([]);
    expect(await fakeCodexDispatchCount()).toBe(dispatchCountAfterFailure);
  });

  it("does not redispatch Codex after restarting with a dispatched_unknown intent", async () => {
    const launched = await launchConfirmedRun(workflow.id, { force_slow_output: true });
    const before = await fetchJson<{
      nodes: Array<{ node_run_id: string }>;
      attempts: unknown[];
      artifacts: unknown[];
      gates: unknown[];
    }>(`/api/v0/runs/${launched.run_id}`);
    const nodeRunId = before.nodes[0]!.node_run_id;
    const dispatchCountBefore = await fakeCodexDispatchCount();
    const runDir = path.join(tempWorkspace, "runs", launched.run_id);
    const intentPath = path.join(runDir, "dispatches", `${nodeRunId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48)}_${createHash("sha256").update(nodeRunId).digest("hex").slice(0, 16)}.json`);
    const execution = fetchJson<{ accepted: boolean }>(`/api/v0/runs/${launched.run_id}/nodes/${nodeRunId}/execute`, {
      method: "POST",
      body: JSON.stringify({})
    });
    let capturedIntent: (Record<string, unknown> & { invocation: { dispatched_at: string } }) | undefined;
    for (let index = 0; index < 100; index += 1) {
      try {
        capturedIntent = JSON.parse(await readFile(intentPath, "utf8")) as typeof capturedIntent;
        if (capturedIntent?.state === "dispatched_unknown") break;
      } catch {
        // The Adapter has not reached the dispatch window yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(capturedIntent?.state).toBe("dispatched_unknown");
    await execution;
    expect(await fakeCodexDispatchCount()).toBe(dispatchCountBefore + 1);

    await writeFile(path.join(runDir, "nodes.json"), `${JSON.stringify(before.nodes, null, 2)}\n`, "utf8");
    await writeFile(path.join(runDir, "attempts.json"), `${JSON.stringify(before.attempts, null, 2)}\n`, "utf8");
    await writeFile(path.join(runDir, "artifacts.json"), `${JSON.stringify(before.artifacts, null, 2)}\n`, "utf8");
    await writeFile(path.join(runDir, "gates.json"), `${JSON.stringify(before.gates, null, 2)}\n`, "utf8");
    await mkdir(path.dirname(intentPath), { recursive: true });
    await writeFile(intentPath, `${JSON.stringify({
      ...capturedIntent,
      state: "dispatched_unknown",
      dispatched_at: capturedIntent!.invocation.dispatched_at
    }, null, 2)}\n`, "utf8");

    await stopSidecar();
    await startSidecar();
    const dispatchCountBeforeRecovery = await fakeCodexDispatchCount();
    const response = await fetch(`${baseUrl}/api/v0/runs/${launched.run_id}/nodes/${nodeRunId}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const responseBody = await response.json();
    expect(response.status, JSON.stringify(responseBody)).toBe(409);
    expect(responseBody).toMatchObject({
      error: { code: "node_dispatch_unknown", reason_code: "dispatch_result_unknown" }
    });
    expect(await fakeCodexDispatchCount()).toBe(dispatchCountBeforeRecovery);
  });

  it.each([
    { mode: "missing", expectedCode: "credential_missing" },
    { mode: "authentication_error", expectedCode: "authentication_failed" },
    { mode: "permission", expectedCode: "permission_denied" }
  ] as const)("refreshes healthy Codex state before dispatch and blocks a live $expectedCode failure without restarting", async ({ mode, expectedCode }) => {
    await writeFakeCodexWrapper();
    const healthy = await fetchJson<{ status: string }>("/api/v0/adapters/codex-cli/health/refresh", {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(healthy.status).toBe("healthy");
    const launched = await launchConfirmedRun(workflow.id);
    const markerBefore = await fakeCodexDispatchCount();
    await writeFakeCodexWrapper(mode);
    try {
      const scheduled = await fetchJson<{
        stop_reason: string;
        next_suggested_actions: string[];
      }>(`/api/v0/runs/${launched.run_id}/scheduler/run`, {
        method: "POST",
        body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
      });
      const bundle = await fetchJson<{
        nodes: Array<{ node_run_id: string; status: string }>;
        attempts: Array<{
          status: string;
          provider_receipt?: { adapter_kind: string; adapter_id: string };
          error?: { code: string; recoverable: boolean };
        }>;
      }>(`/api/v0/runs/${launched.run_id}`);
      const node = bundle.nodes[0]!;
      const attention = await fetchJson<{
        attention: Array<{ root_cause_key: string; status: string; safe_actions: string[] }>;
      }>(`/api/v0/attention?run_id=${launched.run_id}`);
      const detail = await fetchJson<{
        retry_decision: { phase: string; reason_code: string };
        execution_decision: { decision: string; reason_code: string };
        next_suggested_actions: string[];
      }>(`/api/v0/runs/${launched.run_id}/nodes/${node.node_run_id}`);

      expect(await fakeCodexDispatchCount()).toBe(markerBefore);
      expect(bundle.nodes).toEqual([expect.objectContaining({ status: "blocked" })]);
      expect(bundle.attempts).toEqual([
        expect.objectContaining({
          status: "failed",
          provider_receipt: expect.objectContaining({
            adapter_kind: "codex",
            adapter_id: "codex-cli-real"
          }),
          error: expect.objectContaining({ code: expectedCode, recoverable: false })
        })
      ]);
      expect(attention.attention).toEqual([
        expect.objectContaining({
          root_cause_key: `run:${launched.run_id}:node:${node.node_run_id}:retry:${expectedCode}`,
          status: "open",
          safe_actions: expect.arrayContaining(["configure_credentials", "repair_permissions"])
        })
      ]);
      expect(detail.retry_decision).toMatchObject({ phase: "blocked", reason_code: "error_not_retryable" });
      expect(detail.execution_decision).toMatchObject({ decision: "blocked", reason_code: "error_not_retryable" });
      expect(scheduled.stop_reason).toBe("attention_required");
      expect(scheduled.next_suggested_actions).toEqual(detail.next_suggested_actions);
      const retry = await fetch(`${baseUrl}/api/v0/runs/${launched.run_id}/nodes/${node.node_run_id}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      expect(retry.status).toBe(409);
      expect(await fakeCodexDispatchCount()).toBe(markerBefore);
    } finally {
      await writeFakeCodexWrapper();
      await fetchJson("/api/v0/adapters/codex-cli/health/refresh", {
        method: "POST",
        body: JSON.stringify({})
      });
    }
  }, 30_000);

  it("resumes a prepared retry intent without mutating its absolute deadline or prepared timeout", async () => {
    const markerBefore = await fakeCodexDispatchCount();
    const launched = await launchConfirmedRun(shortBudgetRetryingWorkflow.id, {
      force_fail_first_attempt: true,
      force_slow_output: true
    });
    await fetchJson(`/api/v0/runs/${launched.run_id}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ max_nodes: 1 })
    });
    const runDir = path.join(tempWorkspace, "runs", launched.run_id);
    const bundle = await fetchJson<{
      run: RunSpec;
      nodes: NodeRun[];
      attempts: NodeAttempt[];
    }>(`/api/v0/runs/${launched.run_id}`);
    const schedule = (JSON.parse(await readFile(path.join(runDir, "retry_schedule.json"), "utf8")) as RetryScheduleRecord[])[0]!;
    const preparedAt = new Date().toISOString();
    const intent = preparedRetryIntent({
      run: bundle.run,
      node: bundle.nodes[0]!,
      attempt: bundle.attempts[0]!,
      schedule,
      preparedAt
    });
    const intentPath = nodeDispatchIntentPath(launched.run_id, bundle.nodes[0]!.node_run_id);
    await mkdir(path.dirname(intentPath), { recursive: true });
    await writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`, "utf8");
    expect(intent.invocation.runtime_control.timeout_ms).toBe(6_000);

    await new Promise((resolve) => setTimeout(resolve, 2_300));
    await stopSidecar();
    await startSidecar();
    const execution = fetchJson<{
      invocation: {
        operation_id: string;
        attempt_id: string;
        resolved_inputs: unknown[];
        runtime_control: { timeout_ms: number };
      };
    }>(`/api/v0/runs/${launched.run_id}/nodes/${bundle.nodes[0]!.node_run_id}/execute`, {
      method: "POST",
      body: JSON.stringify({})
    });
    let observedDeadline: string | undefined;
    for (let index = 0; index < 100; index += 1) {
      try {
        const persistedIntent = JSON.parse(await readFile(intentPath, "utf8")) as {
          state?: string;
          operation_deadline_at?: string;
        };
        if (persistedIntent.state === "dispatched_unknown") {
          observedDeadline = persistedIntent.operation_deadline_at;
          break;
        }
      } catch {
        // The retry has not entered the Adapter dispatch window yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const result = await execution;

    expect(result.invocation).toMatchObject({
      operation_id: intent.invocation.operation_id,
      attempt_id: intent.invocation.attempt_id,
      resolved_inputs: []
    });
    expect(result.invocation.runtime_control.timeout_ms).toBe(intent.invocation.runtime_control.timeout_ms);
    expect(observedDeadline).toBe(intent.operation_deadline_at);
    expect(await fakeCodexDispatchCount()).toBe(markerBefore + 2);
    expect((await fetchJson<{ attempts: unknown[] }>(`/api/v0/runs/${launched.run_id}`)).attempts).toHaveLength(2);
  }, 30_000);

  it("does not start a prepared retry process when the authoritative remaining budget is exhausted", async () => {
    const markerBefore = await fakeCodexDispatchCount();
    const launched = await launchConfirmedRun(shortBudgetRetryingWorkflow.id, { force_fail_first_attempt: true });
    await fetchJson(`/api/v0/runs/${launched.run_id}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ max_nodes: 1 })
    });
    const runDir = path.join(tempWorkspace, "runs", launched.run_id);
    const bundle = await fetchJson<{
      run: RunSpec;
      nodes: NodeRun[];
      attempts: NodeAttempt[];
    }>(`/api/v0/runs/${launched.run_id}`);
    const schedule = (JSON.parse(await readFile(path.join(runDir, "retry_schedule.json"), "utf8")) as RetryScheduleRecord[])[0]!;
    const intent = preparedRetryIntent({
      run: bundle.run,
      node: bundle.nodes[0]!,
      attempt: bundle.attempts[0]!,
      schedule,
      preparedAt: new Date().toISOString()
    });
    const intentPath = nodeDispatchIntentPath(launched.run_id, bundle.nodes[0]!.node_run_id);
    await mkdir(path.dirname(intentPath), { recursive: true });
    await writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`, "utf8");
    const attempts = JSON.parse(await readFile(path.join(runDir, "attempts.json"), "utf8")) as Array<Record<string, unknown>>;
    attempts[0] = {
      ...attempts[0],
      started_at: "2020-01-01T00:00:00.000Z",
      dispatched_at: "2020-01-01T00:00:00.000Z"
    };
    await writeFile(path.join(runDir, "attempts.json"), `${JSON.stringify(attempts, null, 2)}\n`, "utf8");

    const response = await fetch(`${baseUrl}/api/v0/runs/${launched.run_id}/nodes/${bundle.nodes[0]!.node_run_id}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "retry_budget_exhausted", reason_code: "time_budget_exhausted" }
    });
    expect(await fakeCodexDispatchCount()).toBe(markerBefore + 1);
    expect((await fetchJson<{ attempts: unknown[] }>(`/api/v0/runs/${launched.run_id}`)).attempts).toHaveLength(1);
  }, 30_000);

  it("retries one real Codex process failure once and remains at-most-once across restart, concurrency, and a stale schedule", async () => {
    const markerBefore = await fakeCodexDispatchCount();
    const launched = await launchConfirmedRun(retryingWorkflow.id, { force_fail_first_attempt: true });
    const first = await fetchJson<{
      executed: Array<{ result: { adapter_result: { status: string }; retry_decision: { phase?: string } } }>;
    }>(`/api/v0/runs/${launched.run_id}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ max_nodes: 1 })
    });
    expect(first.executed[0]?.result.adapter_result.status).toBe("failed");
    const schedules = JSON.parse(await readFile(
      path.join(tempWorkspace, "runs", launched.run_id, "retry_schedule.json"),
      "utf8"
    )) as Array<Record<string, unknown>>;
    expect(schedules).toHaveLength(1);
    expect(await fakeCodexDispatchCount()).toBe(markerBefore + 1);

    const bundleBeforeRetry = await fetchJson<{ nodes: Array<{ node_run_id: string }> }>(`/api/v0/runs/${launched.run_id}`);
    const nodeRunId = bundleBeforeRetry.nodes[0]!.node_run_id;
    await stopSidecar();
    await startSidecar();
    await Promise.all([
      fetch(`${baseUrl}/api/v0/runs/${launched.run_id}/scheduler/tick`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ max_nodes: 1 })
      }),
      fetch(`${baseUrl}/api/v0/runs/${launched.run_id}/nodes/${nodeRunId}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      })
    ]);

    const completed = await fetchJson<{
      attempts: Array<{ operation_id: string; attempt_number: number; status: string; error?: { code: string } }>;
    }>(`/api/v0/runs/${launched.run_id}`);
    expect(completed.attempts).toHaveLength(2);
    expect(completed.attempts).toEqual([
      expect.objectContaining({
        attempt_number: 1,
        status: "failed",
        error: expect.objectContaining({ code: "adapter_process_error" })
      }),
      expect.objectContaining({ attempt_number: 2, status: "succeeded" })
    ]);
    expect(new Set(completed.attempts.map((attempt) => attempt.operation_id)).size).toBe(1);
    expect(await fakeCodexDispatchCount()).toBe(markerBefore + 2);
    const retryStatePath = path.join(tempWorkspace, "runs", launched.run_id, "retry_state.json");
    expect(JSON.parse(await readFile(retryStatePath, "utf8"))).toEqual([
      expect.objectContaining({
        operation_id: completed.attempts[1]!.operation_id,
        attempt_number: 2,
        phase: "completed",
        reason_code: "retry_completed",
        effects_committed: true
      })
    ]);

    await writeFile(
      path.join(tempWorkspace, "runs", launched.run_id, "retry_schedule.json"),
      `${JSON.stringify(schedules, null, 2)}\n`,
      "utf8"
    );
    const detailBeforeCleanup = await fetchJson<{ retry_decision?: unknown }>(
      `/api/v0/runs/${launched.run_id}/nodes/${nodeRunId}`
    );
    expect(detailBeforeCleanup.retry_decision).toBeUndefined();
    await stopSidecar();
    await startSidecar();
    await Promise.all([
      fetch(`${baseUrl}/api/v0/runs/${launched.run_id}/scheduler/tick`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ max_nodes: 1 })
      }),
      fetch(`${baseUrl}/api/v0/runs/${launched.run_id}/nodes/${nodeRunId}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      })
    ]);
    expect(await fakeCodexDispatchCount()).toBe(markerBefore + 2);
    expect((await fetchJson<{ attempts: unknown[] }>(`/api/v0/runs/${launched.run_id}`)).attempts).toHaveLength(2);
    expect(JSON.parse(await readFile(path.join(tempWorkspace, "runs", launched.run_id, "retry_schedule.json"), "utf8"))).toEqual([]);
    expect(JSON.parse(await readFile(retryStatePath, "utf8"))).toEqual([
      expect.objectContaining({ phase: "completed", effects_committed: true })
    ]);
  }, 30_000);

  it("does not steal another Sidecar instance mutation lock while requests are active", async () => {
    const launched = await launchConfirmedRun(workflow.id);
    const lockDir = path.join(tempWorkspace, "runs", launched.run_id, "locks", `${launched.run_id}.mutation.lock`);
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({ instance_id: "other-sidecar", owner_token: "active", pid: process.pid, created_at: new Date().toISOString() })}\n`,
      "utf8"
    );

    const response = await fetch(`${baseUrl}/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    const scheduled = await response.json() as {
      stop_reason: string;
      summary: { failures: number; nodes_executed: number };
    };
    const bundle = await fetchJson<{ nodes: Array<{ status: string }> }>(`/api/v0/runs/${launched.run_id}`);

    expect(response.status).toBe(200);
    expect(scheduled).toMatchObject({
      stop_reason: "execution_failed",
      summary: { failures: 1, nodes_executed: 0 }
    });
    expect(bundle.nodes[0]?.status).toBe("queued");
    await expect(readFile(path.join(lockDir, "owner.json"), "utf8")).resolves.toContain("\"other-sidecar\"");
    await rm(lockDir, { recursive: true, force: true });
  });

  it("stops a max_nodes=5 tick after a locked NodeRun and emits one deduplicated Attention event", async () => {
    const launched = await launchConfirmedRun(workflow.id);
    const lockDir = path.join(tempWorkspace, "runs", launched.run_id, "locks", `${launched.run_id}.mutation.lock`);
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({ instance_id: "other-sidecar", owner_token: "active", pid: process.pid, created_at: new Date().toISOString() })}\n`,
      "utf8"
    );
    try {
      const tick = await fetchJson<{
        failed: Array<{ node_run_id: string; error: { code: string } }>;
        attention_items: Array<{ root_cause_key: string }>;
        created_events: string[];
      }>(`/api/v0/runs/${launched.run_id}/scheduler/tick`, {
        method: "POST",
        body: JSON.stringify({ max_nodes: 5 })
      });
      const eventsPath = path.join(tempWorkspace, "runs", launched.run_id, "events.jsonl");
      const events = await fetchJson<{ events: Array<{ type: string; event_id: string }> }>(`/api/v0/runs/${launched.run_id}/events`);
      const attentionEvents = events.events.filter((event) => event.type === "attention_item_created");

      expect(tick.failed).toEqual([expect.objectContaining({ error: expect.objectContaining({ code: "operation_in_progress" }) })]);
      expect(tick.attention_items).toHaveLength(1);
      expect(tick.created_events.filter((eventId) => eventId.includes("execution_failed"))).toHaveLength(1);
      expect(attentionEvents).toHaveLength(1);
      expect(new Set(attentionEvents.map((event) => event.event_id)).size).toBe(1);

      await writeFile(
        eventsPath,
        `${events.events.filter((event) => event.type !== "attention_item_created").map((event) => JSON.stringify(event)).join("\n")}\n`,
        "utf8"
      );
      const repaired = await Promise.all(Array.from({ length: 20 }, () => fetchJson<{ attention_items: unknown[]; created_events: string[] }>(`/api/v0/runs/${launched.run_id}/scheduler/tick`, {
        method: "POST",
        body: JSON.stringify({ max_nodes: 5 })
      })));
      const repairedEvents = await fetchJson<{ events: Array<{ type: string; event_id: string }> }>(`/api/v0/runs/${launched.run_id}/events`);

      expect(repaired.every((item) => item.attention_items.length === 0)).toBe(true);
      expect(repaired.filter((item) => item.created_events.some((eventId) => eventId.includes("execution_failed")))).toHaveLength(1);
      expect(repairedEvents.events.filter((event) => event.type === "attention_item_created")).toHaveLength(1);
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
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

  it("accepts a schema-valid multi-output JSON file near the output contract byte limit", async () => {
    const launched = await launchConfirmedRun(multiOutputWorkflow.id, { force_near_limit_multi_output: true });
    const scheduled = await fetchJson<{ summary: { failures: number; nodes_executed: number } }>(`/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    const bundle = await fetchJson<{ nodes: Array<{ status: string }>; artifacts: Array<{ type: string }> }>(`/api/v0/runs/${launched.run_id}`);

    expect(scheduled.summary).toEqual(expect.objectContaining({ failures: 0, nodes_executed: 1 }));
    expect(bundle.nodes).toEqual([expect.objectContaining({ status: "done" })]);
    expect(bundle.artifacts.map((artifact) => artifact.type).sort()).toEqual(["report", "script"]);
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

  it.each([
    ["property count", propertyLimitWorkflow.id, "5000"],
    ["schema string characters", stringLimitWorkflow.id, "120000"]
  ])("rejects Structured Outputs %s limits before Attempt workspace or process", async (_label, workflowId, messagePart) => {
    const beforeAttempts = await readdir(path.join(runtimeWorkspace, "runtime", "attempts"));
    const beforeMarker = await readFile(fakeCodexMarker, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const launched = await launchConfirmedRun(workflowId);
    const scheduled = await fetchJson<{ summary: { failures: number } }>(`/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    const bundle = await fetchJson<{
      attempts: Array<{ status: string; error?: { code: string; message: string; recoverable: boolean } }>;
      artifacts: unknown[];
    }>(`/api/v0/runs/${launched.run_id}`);
    const afterMarker = await readFile(fakeCodexMarker, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });

    expect(scheduled.summary.failures).toBe(1);
    expect(bundle.attempts).toEqual([expect.objectContaining({
      status: "failed",
      error: expect.objectContaining({
        code: "invalid_codex_artifact_output",
        message: expect.stringContaining(messagePart),
        recoverable: false
      })
    })]);
    expect(bundle.artifacts).toEqual([]);
    expect(await readdir(path.join(runtimeWorkspace, "runtime", "attempts"))).toEqual(beforeAttempts);
    expect(afterMarker).toBe(beforeMarker);
  });

  it("stages the input snapshot inside the verified Attempt without writing through run input-snapshots", async () => {
    const launched = await launchConfirmedRun(workflow.id);
    await writeFile(path.join(tempWorkspace, "runs", launched.run_id, "input-snapshots"), "blocked", "utf8");
    await rm(fakeCodexMarker, { force: true });

    const scheduled = await fetchJson<{ summary: { failures: number; nodes_executed: number } }>(`/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    const bundle = await fetchJson<{
      nodes: Array<{ status: string }>;
      attempts: Array<{ attempt_id: string; status: string }>;
      artifacts: unknown[];
    }>(`/api/v0/runs/${launched.run_id}`);

    expect(scheduled.summary).toEqual(expect.objectContaining({ failures: 0, nodes_executed: 1 }));
    expect(bundle.nodes).toEqual([expect.objectContaining({ status: "reviewing" })]);
    expect(bundle.attempts).toEqual([expect.objectContaining({ status: "succeeded" })]);
    expect(bundle.artifacts).toHaveLength(1);
    await expect(readFile(path.join(
      runtimeWorkspace,
      "runtime",
      "attempts",
      bundle.attempts[0]!.attempt_id,
      "input",
      "resolved-inputs.json"
    ), "utf8")).resolves.toContain('"resolved_inputs"');
  });

  it("runs real Codex nodes continuously and hands artifacts downstream in one scheduler call", async () => {
    const launched = await launchConfirmedRun(handoffWorkflow.id);

    const first = await fetchJson<{ summary: { nodes_executed: number; ticks_committed: number } }>(`/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 20, max_nodes_per_tick: 1 })
    });
    let bundle = await fetchJson<{
      nodes: Array<{ node_id: string; status: string }>;
      attempts: Array<{ attempt_id: string; node_run_id: string }>;
      artifacts: Array<{ artifact_id: string; artifact_spec_ref?: string; hash: string; path: string }>;
    }>(`/api/v0/runs/${launched.run_id}`);

    expect(first.summary).toEqual(expect.objectContaining({ nodes_executed: 2, ticks_committed: 2 }));
    expect(bundle.nodes).toEqual([expect.objectContaining({ node_id: "A_generate", status: "done" }), expect.objectContaining({ node_id: "B_consume", status: "done" })]);

    const second = await fetchJson<{ summary: { nodes_executed: number; ticks_committed: number } }>(`/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 20, max_nodes_per_tick: 1 })
    });
    bundle = await fetchJson<typeof bundle>(`/api/v0/runs/${launched.run_id}`);
    const upstream = bundle.artifacts.find((artifact) => artifact.artifact_spec_ref === "upstream_artifact")!;
    const downstreamNode = bundle.nodes.find((node) => node.node_id === "B_consume")!;
    const downstreamAttempt = bundle.attempts.find((attempt) => attempt.node_run_id === (downstreamNode as { node_run_id?: string }).node_run_id)!;
    const snapshot = JSON.parse(await readFile(path.join(runtimeWorkspace, "runtime", "attempts", downstreamAttempt.attempt_id, "input", "resolved-inputs.json"), "utf8")) as { artifact_files: Array<{ hash: string; target_path: string }> };

    expect(second.summary).toEqual(expect.objectContaining({ nodes_executed: 0, ticks_committed: 0 }));
    expect(bundle.nodes).toEqual([expect.objectContaining({ node_id: "A_generate", status: "done" }), expect.objectContaining({ node_id: "B_consume", status: "done" })]);
    expect(snapshot.artifact_files).toEqual([expect.objectContaining({ hash: upstream.hash })]);
    await expect(readFile(path.join(runtimeWorkspace, "runtime", "attempts", downstreamAttempt.attempt_id, "input", snapshot.artifact_files[0]!.target_path), "utf8")).resolves.toContain("Miracle P6-07");
  });

  it("classifies a missing input artifact as blocked and opens one root-cause Attention", async () => {
    const launched = await launchConfirmedRun(handoffWorkflow.id);
    await fetchJson(`/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    const before = await fetchJson<{
      nodes: Array<{ node_id: string; node_run_id: string; status: string }>;
      artifacts: Array<{ artifact_spec_ref?: string; path: string }>;
    }>(`/api/v0/runs/${launched.run_id}`);
    const upstream = before.artifacts.find((artifact) => artifact.artifact_spec_ref === "upstream_artifact")!;
    const downstream = before.nodes.find((node) => node.node_id === "B_consume")!;
    await rm(path.join(tempWorkspace, upstream.path));

    const scheduled = await fetchJson<{
      failed: Array<{ node_run_id: string; retry_decision?: { action: string } }>;
      decisions: Array<{ node_run_id: string; decision: string; reason_code: string }>;
      next_suggested_actions: string[];
    }>(`/api/v0/runs/${launched.run_id}/scheduler/tick`, {
      method: "POST",
      body: JSON.stringify({ max_nodes: 1 })
    });
    const bundle = await fetchJson<{
      nodes: Array<{ node_id: string; status: string }>;
      attempts: Array<{ node_run_id: string; status: string; error?: { code: string; recoverable: boolean } }>;
      attention: Array<{ root_cause_key: string; status: string; related_objects: Array<{ type: string; id: string }> }>;
    }>(`/api/v0/runs/${launched.run_id}`);
    const downstreamAttempt = bundle.attempts.find((attempt) => attempt.node_run_id === downstream.node_run_id)!;

    expect(scheduled.failed).toEqual([
      expect.objectContaining({
        node_run_id: downstream.node_run_id,
        retry_decision: expect.objectContaining({ action: "fail_terminal" })
      })
    ]);
    expect(scheduled.decisions.find((decision) => decision.node_run_id === downstream.node_run_id)).toMatchObject({
      decision: "blocked",
      reason_code: "error_not_retryable"
    });
    expect(scheduled.next_suggested_actions).toEqual(["inspect_attention", "retry_manually"]);
    expect(bundle.nodes.find((node) => node.node_id === "B_consume")).toMatchObject({ status: "blocked" });
    expect(downstreamAttempt).toMatchObject({
      status: "failed",
      error: { code: "artifact_missing", recoverable: false }
    });
    expect(bundle.attention).toEqual([
      expect.objectContaining({
        root_cause_key: expect.stringContaining(":retry:artifact_missing"),
        status: "open",
        related_objects: expect.arrayContaining([
          expect.objectContaining({ type: "NodeAttempt", id: expect.any(String) })
        ])
      })
    ]);
  });

  it("keeps colliding normalized output IDs distinct in artifact identity and output path", async () => {
    const launched = await launchConfirmedRun(collisionOutputWorkflow.id, { force_collision_output: true });
    await fetchJson(`/api/v0/runs/${launched.run_id}/scheduler/run`, { method: "POST", body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 }) });
    const bundle = await fetchJson<{ artifacts: Array<{ artifact_id: string; path: string }> }>(`/api/v0/runs/${launched.run_id}`);

    expect(bundle.artifacts).toHaveLength(2);
    expect(new Set(bundle.artifacts.map((artifact) => artifact.artifact_id)).size).toBe(2);
    expect(new Set(bundle.artifacts.map((artifact) => artifact.path)).size).toBe(2);
  });

  it("rejects duplicate summary output IDs before creating an Attempt", async () => {
    const before = await readdir(path.join(runtimeWorkspace, "runtime", "attempts"));
    const launched = await launchConfirmedRun(duplicateSummaryWorkflow.id);
    const scheduled = await fetchJson<{ summary: { failures: number } }>(`/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    const bundle = await fetchJson<{ attempts: Array<{ status: string; error?: { code: string } }>; artifacts: unknown[] }>(`/api/v0/runs/${launched.run_id}`);

    expect(scheduled.summary.failures).toBe(1);
    expect(bundle.attempts).toEqual([expect.objectContaining({
      status: "failed",
      error: expect.objectContaining({ code: "invalid_codex_artifact_output" })
    })]);
    expect(bundle.artifacts).toEqual([]);
    expect(await readdir(path.join(runtimeWorkspace, "runtime", "attempts"))).toEqual(before);
  });

  it("allocates Summary and summary with case-insensitively unique Artifact IDs and paths", async () => {
    const launched = await launchConfirmedRun(caseCollisionOutputWorkflow.id, { force_case_collision_output: true });
    await fetchJson(`/api/v0/runs/${launched.run_id}/scheduler/run`, { method: "POST", body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 }) });
    const bundle = await fetchJson<{ artifacts: Array<{ artifact_id: string; path: string }> }>(`/api/v0/runs/${launched.run_id}`);
    const artifactIds = bundle.artifacts.map((artifact) => artifact.artifact_id.toLowerCase());
    const artifactPaths = bundle.artifacts.map((artifact) => artifact.path.toLowerCase());

    expect(bundle.artifacts).toHaveLength(2);
    expect(new Set(artifactIds).size).toBe(2);
    expect(new Set(artifactPaths).size).toBe(2);
  });

  it("bounds filesystem components while preserving long output identity with a full hash", async () => {
    const launched = await launchConfirmedRun(longOutputIdWorkflow.id, { force_long_output: true });
    await fetchJson(`/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    const bundle = await fetchJson<{
      artifacts: Array<{ artifact_id: string; path: string }>;
      attempts: Array<{ status: string; error?: { code: string; message: string } }>;
    }>(`/api/v0/runs/${launched.run_id}`);
    const artifact = bundle.artifacts[0]!;

    expect(bundle.artifacts, JSON.stringify(bundle.attempts)).toHaveLength(1);
    expect(path.basename(artifact.path).length).toBeLessThanOrEqual(255);
    expect(artifact.artifact_id).toMatch(/_[a-f0-9]{64}_v1$/);
  });

  it("preserves a unique raw normalized ID when another output hash suffix would collide with it", async () => {
    const launched = await launchConfirmedRun(suffixCollisionOutputWorkflow.id, { force_suffix_collision_output: true });
    await fetchJson(`/api/v0/runs/${launched.run_id}/scheduler/run`, { method: "POST", body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 }) });
    const bundle = await fetchJson<{ artifacts: Array<{ artifact_id: string; path: string }> }>(`/api/v0/runs/${launched.run_id}`);
    const artifactIds = bundle.artifacts.map((artifact) => artifact.artifact_id.toLowerCase());
    const artifactPaths = bundle.artifacts.map((artifact) => artifact.path.toLowerCase());

    expect(bundle.artifacts).toHaveLength(3);
    expect(new Set(artifactIds).size).toBe(3);
    expect(new Set(artifactPaths).size).toBe(3);
    expect(artifactIds.filter((artifactId) => /_a_b_c14cddc033f6_[a-f0-9]{64}_v1$/.test(artifactId))).toHaveLength(1);
  });

  it("keeps Artifact manifest IDs and paths distinct across lossy node ID collisions", async () => {
    const launched = await launchConfirmedRun(twoNodeIdentityCollisionWorkflow.id);
    await fetchJson(`/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    await fetchJson(`/api/v0/runs/${launched.run_id}/scheduler/run`, {
      method: "POST",
      body: JSON.stringify({ max_ticks: 1, max_nodes_per_tick: 1 })
    });
    const bundle = await fetchJson<{
      nodes: Array<{ status: string }>;
      artifacts: Array<{ artifact_id: string; path: string }>;
    }>(`/api/v0/runs/${launched.run_id}`);
    const artifactIds = bundle.artifacts.map((artifact) => artifact.artifact_id.toLowerCase());
    const artifactPaths = bundle.artifacts.map((artifact) => artifact.path.toLowerCase());

    expect(bundle.nodes).toEqual([
      expect.objectContaining({ status: "done" }),
      expect.objectContaining({ status: "done" })
    ]);
    expect(bundle.artifacts).toHaveLength(2);
    expect(new Set(artifactIds).size).toBe(2);
    expect(new Set(artifactPaths).size).toBe(2);
  });
});
