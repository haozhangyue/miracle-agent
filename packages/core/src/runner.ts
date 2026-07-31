import type {
  AdapterArtifactDescriptor,
  AdapterInvocation,
  AdapterResult,
  ArtifactManifest,
  ArtifactReviewStatus,
  NodeAttempt,
  NodeRun,
  ResolvedNodeInput,
  RunSpec,
  TraceEvent,
  WorkflowSpec
} from "./types";
import { adapterResultSchema } from "./schemas";
import { classifyAdapterOutcome } from "./adapter-outcome";
import { resolveNodeRetryPolicy } from "./retry-policy";

function normalizeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function extensionForType(type: string) {
  if (type === "json" || type === "dataset") return "json";
  if (["markdown", "script", "document", "report", "publish_package", "prompt", "outline", "episode_script"].includes(type)) return "md";
  if (type === "image") return "txt";
  if (type === "audio") return "wav";
  if (type === "video") return "mp4";
  return "txt";
}

function contentForDescriptor(descriptor: AdapterArtifactDescriptor, nodeName: string) {
  if (descriptor.type === "json" || descriptor.type === "dataset") {
    return JSON.stringify(
      {
        artifact_id: descriptor.artifact_id,
        generated_by: nodeName,
        status: "mock",
        items: []
      },
      null,
      2
    );
  }
  if (["audio", "video"].includes(descriptor.type)) return undefined;
  return `# ${nodeName}\n\nMock Runner 生成的 ${descriptor.type} 产物。\n\n- artifact_id: ${descriptor.artifact_id}\n- output_id: ${descriptor.output_id}\n`;
}

function reviewStatusForOutput(workflow: WorkflowSpec, artifactSpecRef?: string): ArtifactReviewStatus {
  const artifactSpec = workflow.artifacts.find((artifact) => artifact.id === artifactSpecRef);
  if (!artifactSpec) return "none";
  return artifactSpec.review_policy.mode === "manual" ? "pending_review" : "none";
}

export function createAdapterInvocation(input: {
  runSpec: RunSpec;
  workflow: WorkflowSpec;
  nodeRun: NodeRun;
  createdAt?: string;
  adapterKind?: AdapterInvocation["adapter_kind"];
  adapterId?: string;
  resolvedInputs?: ResolvedNodeInput[];
  operationId?: string;
  attemptNumber?: number;
  remainingTotalBudgetMs?: number;
}): AdapterInvocation {
  const nodeSpec = input.workflow.nodes.find((node) => node.id === input.nodeRun.node_id);
  if (!nodeSpec) throw new Error(`NodeSpec not found: ${input.nodeRun.node_id}`);
  const dispatchedAt = input.createdAt ?? new Date().toISOString();
  const operationId = input.operationId ?? `op_${normalizeId(input.nodeRun.node_run_id)}_${Date.parse(dispatchedAt)}`;
  const attemptNumber = input.attemptNumber ?? 1;
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) throw new Error("attemptNumber must be a positive integer");
  const attemptId = attemptNumber === 1 ? `attempt_${operationId}` : `attempt_${operationId}_${attemptNumber}`;
  const adapterKind = input.adapterKind ?? "mock-local";
  const retryPolicy = resolveNodeRetryPolicy(nodeSpec);
  if (input.remainingTotalBudgetMs !== undefined
    && (!Number.isFinite(input.remainingTotalBudgetMs) || input.remainingTotalBudgetMs <= 0)) {
    throw new Error("remaining total retry budget must be a positive finite number");
  }
  const timeoutMs = Math.floor(Math.min(
    retryPolicy.attempt_timeout_ms,
    input.remainingTotalBudgetMs ?? retryPolicy.attempt_timeout_ms
  ));
  const attemptWorkspace = `runtime/${input.runSpec.run_id}/${input.nodeRun.node_run_id}/${attemptId}`;
  return {
    operation_id: operationId,
    attempt_id: attemptId,
    attempt_number: attemptNumber,
    run_id: input.runSpec.run_id,
    node_run_id: input.nodeRun.node_run_id,
    node_id: input.nodeRun.node_id,
    adapter_kind: adapterKind,
    adapter_id: input.adapterId ?? (
      adapterKind === "codex"
        ? "codex-mock-compatible-adapter"
        : adapterKind === "model-api"
          ? "model-api-compatible-adapter"
          : "mock-local-adapter"
    ),
    provider: input.nodeRun.provider ?? input.runSpec.resolved_provider_policy.default_provider,
    capability_requirements: nodeSpec.capability_requirements,
    input_artifacts: input.nodeRun.upstream_artifacts,
    resolved_inputs: input.resolvedInputs ?? [],
    expected_outputs: nodeSpec.outputs.map((output) => ({
      output_id: output.id,
      artifact_type: output.artifact_type ?? "document",
      artifact_spec_ref: output.artifact_spec_ref,
      required: output.required
    })),
    runtime_control: {
      timeout_ms: timeoutMs,
      cancellation_token_id: `cancel_${operationId}`,
      attempt_workspace: attemptWorkspace,
      sandbox: "workspace-write"
    },
    prompt_path: `${attemptWorkspace}/prompt.md`,
    output_schema_path: "runtime/schemas/adapter-result-v0.json",
    dispatched_at: dispatchedAt
  };
}

export function executeMockAdapter(input: {
  invocation: AdapterInvocation;
  workflow: WorkflowSpec;
  receivedAt?: string;
}): AdapterResult {
  const nodeSpec = input.workflow.nodes.find((node) => node.id === input.invocation.node_id);
  if (!nodeSpec) {
    return adapterResultSchema.parse({
      operation_id: input.invocation.operation_id,
      attempt_id: input.invocation.attempt_id,
      node_run_id: input.invocation.node_run_id,
      status: "failed",
      provider_receipt: {
        provider: input.invocation.provider,
        adapter_kind: input.invocation.adapter_kind,
        adapter_id: input.invocation.adapter_id,
        operation_id: input.invocation.operation_id,
        raw_receipt_id: `receipt_${input.invocation.operation_id}`
      },
      artifact_descriptors: [],
      error: { code: "node_spec_not_found", message: `NodeSpec not found: ${input.invocation.node_id}`, recoverable: false },
      received_at: input.receivedAt ?? new Date().toISOString()
    });
  }

  const receivedAt = input.receivedAt ?? new Date().toISOString();
  const artifactDescriptors = input.invocation.expected_outputs.map((output, index): AdapterArtifactDescriptor => {
    const artifactId = `art_${normalizeId(input.invocation.run_id)}_${normalizeId(input.invocation.node_id)}_${normalizeId(output.output_id)}_v1`;
    const ext = extensionForType(output.artifact_type);
    const descriptor: AdapterArtifactDescriptor = {
      artifact_id: artifactId,
      output_id: output.output_id,
      artifact_spec_ref: output.artifact_spec_ref,
      type: output.artifact_type,
      path: `artifacts/${artifactId}.${ext}`,
      hash: `sha256:mock-${normalizeId(input.invocation.operation_id)}-${index}`,
      status: ["audio", "video"].includes(output.artifact_type) ? "pending" : "created",
      review_status: reviewStatusForOutput(input.workflow, output.artifact_spec_ref)
    };
    return { ...descriptor, content: contentForDescriptor(descriptor, nodeSpec.name) };
  });

  return adapterResultSchema.parse({
    operation_id: input.invocation.operation_id,
    attempt_id: input.invocation.attempt_id,
    node_run_id: input.invocation.node_run_id,
    status: "succeeded",
    provider_receipt: {
      provider: input.invocation.provider,
      adapter_kind: input.invocation.adapter_kind,
      adapter_id: input.invocation.adapter_id,
      operation_id: input.invocation.operation_id,
      model: "mock-runner-v0",
      cost: 0,
      latency_ms: Math.max(0, Date.parse(receivedAt) - Date.parse(input.invocation.dispatched_at)),
      raw_receipt_id: `receipt_${input.invocation.operation_id}`
    },
    artifact_descriptors: artifactDescriptors,
    received_at: receivedAt
  });
}

export function createNodeAttemptFromAdapterResult(
  result: AdapterResult,
  attemptNumber = 1,
  timing?: { startedAt: string; dispatchedAt: string }
): NodeAttempt {
  const parsedResult = adapterResultSchema.parse(result);
  const outcome = classifyAdapterOutcome(parsedResult);
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) throw new Error("attemptNumber must be a positive integer");
  return {
    attempt_id: parsedResult.attempt_id,
    node_run_id: parsedResult.node_run_id,
    operation_id: parsedResult.operation_id,
    attempt_number: attemptNumber,
    attempt_kind: "execute",
    status: outcome.attempt_status,
    provider_receipt: parsedResult.provider_receipt,
    error: outcome.normalized_error,
    started_at: timing?.startedAt,
    dispatched_at: timing?.dispatchedAt,
    created_at: parsedResult.received_at
  };
}

export function createArtifactManifestsFromAdapterResult(input: {
  result: AdapterResult;
  runId: string;
  nodeRun: NodeRun;
  producer: string;
  createdAt?: string;
}): ArtifactManifest[] {
  const createdAt = input.createdAt ?? input.result.received_at;
  return input.result.artifact_descriptors.map((descriptor) => ({
    artifact_id: descriptor.artifact_id,
    artifact_spec_ref: descriptor.artifact_spec_ref,
    run_id: input.runId,
    node_run_id: input.nodeRun.node_run_id,
    type: descriptor.type,
    version: 1,
    path: descriptor.path,
    hash: descriptor.hash,
    status: descriptor.status,
    review_status: descriptor.review_status,
    producer: input.producer,
    created_at: createdAt
  }));
}

export function createRunnerTraceEvents(input: {
  invocation: AdapterInvocation;
  result: AdapterResult;
  committedNodeStatus: NodeRun["status"];
}): TraceEvent[] {
  const eventScope = (input.invocation.attempt_number ?? 1) === 1
    ? input.invocation.operation_id
    : input.invocation.attempt_id;
  return [
    {
      event_id: `evt_${eventScope}_dispatched`,
      run_id: input.invocation.run_id,
      type: "runner_operation_dispatched",
      subject: { type: "NodeRun", id: input.invocation.node_run_id },
      message: `Runner operation dispatched to ${input.invocation.adapter_kind}`,
      created_at: input.invocation.dispatched_at
    },
    {
      event_id: `evt_${eventScope}_received`,
      run_id: input.invocation.run_id,
      type: "adapter_result_received",
      subject: { type: "NodeRun", id: input.invocation.node_run_id },
      message: `AdapterResult ${input.result.status} received from ${input.result.provider_receipt.provider}`,
      created_at: input.result.received_at
    },
    {
      event_id: `evt_${eventScope}_committed`,
      run_id: input.invocation.run_id,
      type: "node_run_committed",
      subject: { type: "NodeRun", id: input.invocation.node_run_id },
      message: `Orchestrator committed NodeRun as ${input.committedNodeStatus}`,
      created_at: input.result.received_at
    }
  ];
}
