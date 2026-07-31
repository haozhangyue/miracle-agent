import { describe, expect, it } from "vitest";
import {
  adapterArtifactDescriptorSchema,
  adapterInvocationSchema,
  adapterResultSchema,
  buildAdapterRegistry,
  createAdapterInvocation,
  createNodeAttemptFromAdapterResult,
  defaultAdapterManifests,
  executeMockAdapter,
  parseAdapterResultForInvocation,
  type NodeRun,
  type RunSpec,
  type WorkflowSpec
} from "../src";
import { codexCliRealAdapterManifest } from "../src/codex-cli";

const runSpec: RunSpec = {
  run_id: "run_contract",
  workflow_id: "workflow_contract",
  workflow_version: "0.1.0",
  workflow_snapshot_id: "snap_contract",
  run_mode: "executable",
  execution_policy: "manual",
  status: "queued",
  role_profile: "operator",
  resolved_components: [],
  resolved_provider_policy: {
    default_provider: "codex-local",
    allowed_providers: ["codex-local"],
    required_credentials: [],
    fallback_providers: []
  },
  created_at: "2026-07-13T00:00:00.000Z"
};

const workflow: WorkflowSpec = {
  id: "workflow_contract",
  name: "Adapter Contract",
  version: "0.1.0",
  domain: "test",
  category: "test",
  nodes: [
    {
      id: "C_md_master",
      name: "Markdown master",
      type: "agent",
      capability_requirements: ["content.longform_draft"],
      recommended_libraries: [],
      agent_candidates: [],
      inputs: [],
      outputs: [{ id: "md_master", kind: "artifact", artifact_type: "markdown", artifact_spec_ref: "md_master_artifact", required: true }],
      failure_policy: { retry: 0, on_missing_input: "blocked", on_provider_failure: "failed" }
    }
  ],
  edges: [],
  gates: [],
  artifacts: [
    {
      id: "md_master_artifact",
      type: "markdown",
      produced_by: "C_md_master",
      review_policy: { mode: "none" },
      required_for: [],
      versioning: { immutable: true, compare_by: "hash" }
    }
  ],
  provider_policy: runSpec.resolved_provider_policy,
  layouts: { dag: { C_md_master: { x: 0, y: 0 } } },
  registry_meta: { source: "test", status: "experimental" }
};

const nodeRun: NodeRun = {
  node_run_id: "nr_contract",
  run_id: runSpec.run_id,
  node_id: "C_md_master",
  status: "queued",
  updated_at: "2026-07-13T00:00:00.000Z",
  upstream_artifacts: [],
  output_artifacts: []
};

function createInvocation() {
  return createAdapterInvocation({
    runSpec,
    workflow,
    nodeRun,
    adapterKind: "codex",
    adapterId: "codex-cli-real",
    createdAt: "2026-07-13T00:00:01.000Z"
  });
}

describe("P6-05 adapter contract", () => {
  it("creates a complete invocation for legacy mock callers", () => {
    const invocation = createAdapterInvocation({ runSpec, workflow, nodeRun, createdAt: "2026-07-13T00:00:01.000Z" });

    expect(adapterInvocationSchema.parse(invocation)).toMatchObject({
      attempt_id: `attempt_${invocation.operation_id}`,
      adapter_id: "mock-local-adapter",
      prompt_path: `runtime/${runSpec.run_id}/${nodeRun.node_run_id}/${invocation.attempt_id}/prompt.md`,
      output_schema_path: "runtime/schemas/adapter-result-v0.json",
      runtime_control: {
        timeout_ms: 1_800_000,
        cancellation_token_id: `cancel_${invocation.operation_id}`,
        attempt_workspace: `runtime/${runSpec.run_id}/${nodeRun.node_run_id}/${invocation.attempt_id}`,
        sandbox: "workspace-write"
      }
    });
  });

  it("uses node attempt timeout and caps retry timeout by remaining total budget", () => {
    const policyWorkflow = structuredClone(workflow);
    policyWorkflow.nodes[0]!.failure_policy.retry_policy = {
      max_attempts: 3,
      backoff: "fixed",
      initial_delay_ms: 1_000,
      max_delay_ms: 1_000,
      retryable_error_codes: ["adapter_timeout"],
      attempt_timeout_ms: 1_250,
      total_time_budget_ms: 5_000,
      cost_budget: 5
    };

    expect(createAdapterInvocation({
      runSpec,
      workflow: policyWorkflow,
      nodeRun,
      createdAt: "2026-07-13T00:00:01.000Z"
    }).runtime_control.timeout_ms).toBe(1_250);
    expect(createAdapterInvocation({
      runSpec,
      workflow: policyWorkflow,
      nodeRun,
      createdAt: "2026-07-13T00:00:01.000Z",
      operationId: "op_retry_timeout",
      attemptNumber: 2,
      remainingTotalBudgetMs: 700
    }).runtime_control.timeout_ms).toBe(700);
    expect(() => createAdapterInvocation({
      runSpec,
      workflow: policyWorkflow,
      nodeRun,
      createdAt: "2026-07-13T00:00:01.000Z",
      operationId: "op_retry_exhausted",
      attemptNumber: 2,
      remainingTotalBudgetMs: 0
    })).toThrow(/remaining total retry budget/i);
  });

  it("requires result, receipt, and artifact descriptor audit fields to agree", () => {
    const invocation = createInvocation();
    const result = executeMockAdapter({ invocation, workflow, receivedAt: "2026-07-13T00:00:02.000Z" });

    expect(adapterResultSchema.parse(result)).toMatchObject({
      operation_id: invocation.operation_id,
      attempt_id: invocation.attempt_id,
      node_run_id: invocation.node_run_id,
      provider_receipt: {
        provider: "codex-local",
        adapter_kind: "codex",
        adapter_id: "codex-cli-real",
        operation_id: invocation.operation_id
      }
    });
    expect(adapterResultSchema.parse({
      ...result,
      provider_receipt: { ...result.provider_receipt, external_session_id: "codex-thread-001" }
    }).provider_receipt).toMatchObject({
      model: "mock-runner-v0",
      external_session_id: "codex-thread-001",
      cost: 0,
      latency_ms: 1000
    });
    expect(adapterArtifactDescriptorSchema.parse(result.artifact_descriptors[0])).toMatchObject({
      output_id: "md_master",
      artifact_spec_ref: "md_master_artifact",
      type: "markdown"
    });
    expect(parseAdapterResultForInvocation(invocation, result)).toEqual(result);
  });

  it.each(["succeeded", "failed", "timed_out", "cancelled", "aborted", "unknown"] as const)("accepts %s results through the shared schema", (status) => {
    const invocation = createInvocation();

    expect(adapterResultSchema.parse({
      operation_id: invocation.operation_id,
      attempt_id: invocation.attempt_id,
      node_run_id: invocation.node_run_id,
      status,
      provider_receipt: {
        provider: invocation.provider,
        adapter_kind: invocation.adapter_kind,
        adapter_id: invocation.adapter_id,
        operation_id: invocation.operation_id
      },
      artifact_descriptors: [],
      received_at: "2026-07-13T00:00:02.000Z"
    })).toMatchObject({ status });
  });

  it.each([
    ["operation_id", (invocation: ReturnType<typeof createInvocation>, result: ReturnType<typeof executeMockAdapter>) => ({ ...result, operation_id: `${invocation.operation_id}_other`, provider_receipt: { ...result.provider_receipt, operation_id: `${invocation.operation_id}_other` } })],
    ["attempt_id", (invocation: ReturnType<typeof createInvocation>, result: ReturnType<typeof executeMockAdapter>) => ({ ...result, attempt_id: `${invocation.attempt_id}_other` })],
    ["node_run_id", (_invocation: ReturnType<typeof createInvocation>, result: ReturnType<typeof executeMockAdapter>) => ({ ...result, node_run_id: "nr_other" })],
    ["adapter_id", (_invocation: ReturnType<typeof createInvocation>, result: ReturnType<typeof executeMockAdapter>) => ({ ...result, provider_receipt: { ...result.provider_receipt, adapter_id: "adapter_other" } })],
    ["adapter_kind", (_invocation: ReturnType<typeof createInvocation>, result: ReturnType<typeof executeMockAdapter>) => ({ ...result, provider_receipt: { ...result.provider_receipt, adapter_kind: "mock-local" as const } })],
    ["provider", (_invocation: ReturnType<typeof createInvocation>, result: ReturnType<typeof executeMockAdapter>) => ({ ...result, provider_receipt: { ...result.provider_receipt, provider: "provider_other" } })]
  ] as const)("rejects a result with mismatched %s", (field, mutate) => {
    const invocation = createInvocation();
    const result = executeMockAdapter({ invocation, workflow, receivedAt: "2026-07-13T00:00:02.000Z" });

    expect(() => parseAdapterResultForInvocation(invocation, mutate(invocation, result))).toThrow(new RegExp(field));
  });

  it("rejects a receipt whose operation differs from the result", () => {
    const invocation = createInvocation();
    const result = executeMockAdapter({ invocation, workflow, receivedAt: "2026-07-13T00:00:02.000Z" });

    expect(() => adapterResultSchema.parse({
      ...result,
      provider_receipt: { ...result.provider_receipt, operation_id: "op_other" }
    })).toThrow(/operation_id/);
  });

  it("does not manufacture an attempt id for legacy results", () => {
    const invocation = createInvocation();
    const result = executeMockAdapter({ invocation, workflow, receivedAt: "2026-07-13T00:00:02.000Z" });

    expect(() => createNodeAttemptFromAdapterResult({ ...result, attempt_id: undefined } as unknown as typeof result)).toThrow(/attempt_id/);
  });

  it.each(["attempt_id", "adapter_id", "operation_id"] as const)("requires %s in the audit contract", (field) => {
    const invocation = createInvocation();
    const result = executeMockAdapter({ invocation, workflow, receivedAt: "2026-07-13T00:00:02.000Z" });
    const candidate = field === "attempt_id"
      ? { ...result, attempt_id: undefined }
      : {
          ...result,
          provider_receipt: { ...result.provider_receipt, [field]: undefined }
        };

    expect(adapterResultSchema.safeParse(candidate).success).toBe(false);
  });

  it("validates the mock failure branch against the shared result schema", () => {
    const invocation = createInvocation();
    const failed = executeMockAdapter({
      invocation: { ...invocation, node_id: "missing_node" },
      workflow,
      receivedAt: "2026-07-13T00:00:02.000Z"
    });

    expect(adapterResultSchema.parse(failed)).toMatchObject({
      status: "failed",
      attempt_id: invocation.attempt_id,
      provider_receipt: {
        adapter_id: invocation.adapter_id,
        operation_id: invocation.operation_id
      },
      artifact_descriptors: []
    });
  });

  it("rejects incomplete artifact descriptors", () => {
    const invocation = createInvocation();
    const result = executeMockAdapter({ invocation, workflow, receivedAt: "2026-07-13T00:00:02.000Z" });

    expect(adapterResultSchema.safeParse({
      ...result,
      artifact_descriptors: [{ ...result.artifact_descriptors[0], hash: "" }]
    }).success).toBe(false);
  });

  it("registers the real Codex CLI manifest as non-executable without changing the mock-compatible manifest", () => {
    const registry = buildAdapterRegistry({ manifests: defaultAdapterManifests, availableCredentials: [] });
    const real = registry.find((manifest) => manifest.id === codexCliRealAdapterManifest.id);
    const mock = registry.find((manifest) => manifest.id === "codex-mock-compatible-adapter");

    expect(codexCliRealAdapterManifest).toMatchObject({
      id: "codex-cli-real",
      kind: "codex",
      execution_mode: "shell",
      runtime: { local_executor: "codex-cli", can_execute: false, entrypoint: "codex" }
    });
    expect(real).toMatchObject({ executable: false });
    expect(real?.unavailable_reasons).toContain("runtime_not_executable");
    expect(mock).toMatchObject({ execution_mode: "mock-compatible", executable: true });
  });
});
