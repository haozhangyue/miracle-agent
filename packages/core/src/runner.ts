import type {
  AdapterArtifactDescriptor,
  AdapterInvocation,
  AdapterResult,
  ArtifactManifest,
  ArtifactReviewStatus,
  NodeAttempt,
  NodeRun,
  RunSpec,
  TraceEvent,
  WorkflowSpec
} from "./types";

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
}): AdapterInvocation {
  const nodeSpec = input.workflow.nodes.find((node) => node.id === input.nodeRun.node_id);
  if (!nodeSpec) throw new Error(`NodeSpec not found: ${input.nodeRun.node_id}`);
  const dispatchedAt = input.createdAt ?? new Date().toISOString();
  return {
    operation_id: `op_${normalizeId(input.nodeRun.node_run_id)}_${Date.parse(dispatchedAt)}`,
    run_id: input.runSpec.run_id,
    node_run_id: input.nodeRun.node_run_id,
    node_id: input.nodeRun.node_id,
    adapter_kind: input.adapterKind ?? "mock-local",
    provider: input.nodeRun.provider ?? input.runSpec.resolved_provider_policy.default_provider,
    capability_requirements: nodeSpec.capability_requirements,
    input_artifacts: input.nodeRun.upstream_artifacts,
    expected_outputs: nodeSpec.outputs.map((output) => ({
      output_id: output.id,
      artifact_type: output.artifact_type ?? "document",
      artifact_spec_ref: output.artifact_spec_ref,
      required: output.required
    })),
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
    return {
      operation_id: input.invocation.operation_id,
      node_run_id: input.invocation.node_run_id,
      status: "failed",
      provider_receipt: {
        provider: input.invocation.provider,
        adapter_kind: input.invocation.adapter_kind,
        raw_receipt_id: `receipt_${input.invocation.operation_id}`
      },
      artifact_descriptors: [],
      error: { code: "node_spec_not_found", message: `NodeSpec not found: ${input.invocation.node_id}`, recoverable: false },
      received_at: input.receivedAt ?? new Date().toISOString()
    };
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

  return {
    operation_id: input.invocation.operation_id,
    node_run_id: input.invocation.node_run_id,
    status: "succeeded",
    provider_receipt: {
      provider: input.invocation.provider,
      adapter_kind: input.invocation.adapter_kind,
      model: "mock-runner-v0",
      cost: 0,
      latency_ms: Math.max(0, Date.parse(receivedAt) - Date.parse(input.invocation.dispatched_at)),
      raw_receipt_id: `receipt_${input.invocation.operation_id}`
    },
    artifact_descriptors: artifactDescriptors,
    received_at: receivedAt
  };
}

export function createNodeAttemptFromAdapterResult(result: AdapterResult): NodeAttempt {
  return {
    attempt_id: `attempt_${normalizeId(result.operation_id)}`,
    node_run_id: result.node_run_id,
    operation_id: result.operation_id,
    status: result.status,
    provider_receipt: result.provider_receipt,
    error: result.error
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
  return [
    {
      event_id: `evt_${input.invocation.operation_id}_dispatched`,
      run_id: input.invocation.run_id,
      type: "runner_operation_dispatched",
      subject: { type: "NodeRun", id: input.invocation.node_run_id },
      message: `Runner operation dispatched to ${input.invocation.adapter_kind}`,
      created_at: input.invocation.dispatched_at
    },
    {
      event_id: `evt_${input.invocation.operation_id}_received`,
      run_id: input.invocation.run_id,
      type: "adapter_result_received",
      subject: { type: "NodeRun", id: input.invocation.node_run_id },
      message: `AdapterResult ${input.result.status} received from ${input.result.provider_receipt.provider}`,
      created_at: input.result.received_at
    },
    {
      event_id: `evt_${input.invocation.operation_id}_committed`,
      run_id: input.invocation.run_id,
      type: "node_run_committed",
      subject: { type: "NodeRun", id: input.invocation.node_run_id },
      message: `Orchestrator committed NodeRun as ${input.committedNodeStatus}`,
      created_at: input.result.received_at
    }
  ];
}
