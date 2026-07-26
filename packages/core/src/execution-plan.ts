import type {
  ArtifactManifest,
  ArtifactSpec,
  CalculateExecutionPlanInput,
  EdgeSpec,
  ExecutionDecision,
  ExecutionPlan,
  GateInstance,
  NodeExecutionDecision,
  NodeRun,
  NodeSpec,
  ResolveNodeInputsInput,
  ResolvedNodeInput,
  WorkflowSpec
} from "./types";

const activeStatuses = new Set<NodeRun["status"]>(["queued", "running", "waiting", "reviewing"]);
const terminalStatuses = new Set<NodeRun["status"]>(["done", "failed", "skipped"]);

function edgeId(edge: EdgeSpec) {
  return `${edge.from}->${edge.to}`;
}

function sortedEdges(edges: EdgeSpec[]) {
  return [...edges].sort((left, right) => edgeId(left).localeCompare(edgeId(right)));
}

function compareNodeRuns(left: NodeRun, right: NodeRun) {
  if (left.updated_at !== right.updated_at) return right.updated_at.localeCompare(left.updated_at);
  return left.node_run_id.localeCompare(right.node_run_id);
}

function nodeRunForNodeId(nodeRuns: NodeRun[], nodeId: string) {
  return [...nodeRuns].filter((nodeRun) => nodeRun.node_id === nodeId).sort(compareNodeRuns)[0];
}

function newestArtifact(artifacts: ArtifactManifest[]) {
  return [...artifacts].sort((left, right) => {
    if (left.version !== right.version) return right.version - left.version;
    if (left.created_at !== right.created_at) return right.created_at.localeCompare(left.created_at);
    return left.artifact_id.localeCompare(right.artifact_id);
  })[0];
}

function latestGateDecision(gate: GateInstance) {
  return [...gate.decisions].sort((left, right) => {
    if (left.created_at !== right.created_at) return right.created_at.localeCompare(left.created_at);
    return right.decision_id.localeCompare(left.decision_id);
  })[0];
}

function artifactMetadataValid(artifact: ArtifactManifest) {
  return Number.isInteger(artifact.version) && artifact.version > 0 && artifact.hash.trim().length > 0 && artifact.path.trim().length > 0;
}

function artifactMatchesSpec(workflow: WorkflowSpec, artifact: ArtifactManifest, artifactSpec: ArtifactSpec) {
  if (artifact.type !== artifactSpec.type) return false;
  if (artifact.artifact_spec_ref) return artifact.artifact_spec_ref === artifactSpec.id;
  return workflow.artifacts.filter((item) => item.produced_by === artifactSpec.produced_by && item.type === artifactSpec.type).length === 1;
}

function artifactQualifies(input: {
  workflow: WorkflowSpec;
  sourceNodeId: string;
  nodeRuns: NodeRun[];
  artifacts: ArtifactManifest[];
  artifactSpec?: ArtifactSpec;
  artifactType?: string;
  edge?: EdgeSpec;
}) {
  const sourceRun = nodeRunForNodeId(input.nodeRuns, input.sourceNodeId);
  if (!sourceRun || sourceRun.status !== "done") return [];
  return input.artifacts.filter((artifact) => {
    if (artifact.node_run_id !== sourceRun.node_run_id || artifact.status !== "created" || !artifactMetadataValid(artifact)) return false;
    if (input.artifactSpec && !artifactMatchesSpec(input.workflow, artifact, input.artifactSpec)) return false;
    if (input.artifactType && artifact.type !== input.artifactType) return false;
    if (input.edge?.artifact_selector?.artifact_type && artifact.type !== input.edge.artifact_selector.artifact_type) return false;
    if (input.edge?.artifact_selector?.review_status && artifact.review_status !== input.edge.artifact_selector.review_status) return false;
    return true;
  });
}

function inputArtifactSpec(workflow: WorkflowSpec, input: NodeSpec["inputs"][number]) {
  return input.artifact_spec_ref ? workflow.artifacts.find((item) => item.id === input.artifact_spec_ref) : undefined;
}

function inputMatchesEdge(workflow: WorkflowSpec, input: NodeSpec["inputs"][number], edge: EdgeSpec) {
  if (input.kind !== "artifact") return false;
  const artifactSpec = inputArtifactSpec(workflow, input);
  return !artifactSpec || artifactSpec.produced_by === edge.from;
}

function qualifiedArtifactsForInput(workflow: WorkflowSpec, input: NodeSpec["inputs"][number], edge: EdgeSpec, nodeRuns: NodeRun[], artifacts: ArtifactManifest[]) {
  const artifactSpec = inputArtifactSpec(workflow, input);
  return artifactQualifies({
    workflow,
    sourceNodeId: edge.from,
    nodeRuns,
    artifacts,
    artifactSpec,
    artifactType: input.artifact_type ?? artifactSpec?.type,
    edge
  });
}

function qualifiedArtifactsForDestinationEdge(workflow: WorkflowSpec, node: NodeSpec, edge: EdgeSpec, nodeRuns: NodeRun[], artifacts: ArtifactManifest[]) {
  const candidates = node.inputs
    .filter((input) => inputMatchesEdge(workflow, input, edge))
    .flatMap((input) => qualifiedArtifactsForInput(workflow, input, edge, nodeRuns, artifacts));
  return candidates.filter((artifact, index) => candidates.findIndex((item) => item.artifact_id === artifact.artifact_id) === index);
}

function latestCreatedArtifactForSpec(workflow: WorkflowSpec, artifactSpecId: string, artifacts: ArtifactManifest[]) {
  const artifactSpec = workflow.artifacts.find((item) => item.id === artifactSpecId);
  if (!artifactSpec) return undefined;
  return newestArtifact(artifacts.filter((artifact) => artifact.status === "created" && artifactMetadataValid(artifact) && artifactMatchesSpec(workflow, artifact, artifactSpec)));
}

function gateForSpec(workflow: WorkflowSpec, gates: GateInstance[], gateSpecId: string, runId: string, artifacts: ArtifactManifest[]) {
  const gateSpec = workflow.gates.find((gate) => gate.id === gateSpecId);
  if (!gateSpec) return undefined;
  const targetArtifact = latestCreatedArtifactForSpec(workflow, gateSpec.target_artifact_ref, artifacts);
  if (!targetArtifact) return undefined;
  return [...gates]
    .filter((gate) => gate.gate_spec_id === gateSpecId && gate.run_id === runId)
    .filter((gate) => gate.target.id === targetArtifact.artifact_id)
    .sort((left, right) => left.gate_instance_id.localeCompare(right.gate_instance_id))[0];
}

function durationMs(value: string | undefined) {
  if (!value) return undefined;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return undefined;
  return (Number(match[1] ?? 0) * 3_600_000) + (Number(match[2] ?? 0) * 60_000) + (Number(match[3] ?? 0) * 1_000);
}

function joinTimedOut(edge: EdgeSpec, sourceRun: NodeRun, calculatedAt: string) {
  const maxWaitMs = durationMs(edge.join_policy.max_wait);
  const startedAt = sourceRun.started_at ?? sourceRun.updated_at;
  return maxWaitMs !== undefined && Date.parse(calculatedAt) - Date.parse(startedAt) >= maxWaitMs;
}

function resolvedArtifactInput(input: NodeSpec["inputs"][number], artifact: ArtifactManifest, calculatedAt: string): ResolvedNodeInput {
  return {
    input_id: input.id,
    source_kind: "artifact",
    source_ref: artifact.path,
    artifact_id: artifact.artifact_id,
    artifact_version: artifact.version,
    artifact_hash: artifact.hash,
    media_type: artifact.type,
    required: input.required,
    resolved_at: calculatedAt
  };
}

export function resolveNodeInputs(input: ResolveNodeInputsInput): ResolvedNodeInput[] {
  const nodeRuns = input.nodeRuns.filter((nodeRun) => nodeRun.run_id === input.runId);
  const artifacts = input.artifacts.filter((artifact) => artifact.run_id === input.runId);
  const incomingEdges = sortedEdges(input.workflow.edges.filter((edge) => edge.to === input.node.id));
  return input.node.inputs.flatMap((nodeInput) => {
    if (nodeInput.kind === "parameter") {
      return [{ input_id: nodeInput.id, source_kind: "parameter" as const, source_ref: nodeInput.id, media_type: nodeInput.artifact_type ?? "application/json", required: nodeInput.required, resolved_at: input.calculatedAt }];
    }
    const candidates = incomingEdges
      .filter((edge) => inputMatchesEdge(input.workflow, nodeInput, edge))
      .flatMap((edge) => qualifiedArtifactsForInput(input.workflow, nodeInput, edge, nodeRuns, artifacts));
    const artifact = newestArtifact(candidates);
    return artifact ? [resolvedArtifactInput(nodeInput, artifact, input.calculatedAt)] : [];
  });
}

function gateDecision(node: NodeSpec, workflow: WorkflowSpec, nodeRuns: NodeRun[], artifacts: ArtifactManifest[], gates: GateInstance[], runId: string): { decision?: ExecutionDecision; reasonCode?: string; gateInstanceId?: string } {
  for (const requiredGate of workflow.gates.filter((gate) => gate.required_before.includes(node.id))) {
    const gate = gateForSpec(workflow, gates, requiredGate.id, runId, artifacts);
    if (!gate) {
      const targetSpec = workflow.artifacts.find((artifact) => artifact.id === requiredGate.target_artifact_ref);
      const producer = targetSpec && nodeRunForNodeId(nodeRuns, targetSpec.produced_by);
      if (producer?.status === "done") return { decision: "pause_for_gate", reasonCode: "required_gate_pending" };
      continue;
    }
    const latestDecision = gate && latestGateDecision(gate)?.decision;
    if (gate?.status === "decided" && latestDecision === "approve") continue;
    if (latestDecision === "reject" || latestDecision === "request_changes" || gate?.status === "invalidated") return { decision: "blocked", reasonCode: "required_gate_rejected", gateInstanceId: gate.gate_instance_id };
    return { decision: "pause_for_gate", reasonCode: "required_gate_pending", gateInstanceId: gate.gate_instance_id };
  }
  return {};
}

function nodeDecision(input: CalculateExecutionPlanInput, node: NodeSpec): NodeExecutionDecision {
  const nodeRun = nodeRunForNodeId(input.nodeRuns, node.id);
  const incomingEdges = sortedEdges(input.workflow.edges.filter((edge) => edge.to === node.id));
  const requiredEdges = incomingEdges.filter((edge) => edge.required);
  const resolvedInputs = resolveNodeInputs({ runId: input.runId, workflow: input.workflow, node, nodeRuns: input.nodeRuns, artifacts: input.artifacts, calculatedAt: input.calculatedAt });
  const requiredEdgeStatus = requiredEdges.map((edge) => {
    const sourceNodeRun = nodeRunForNodeId(input.nodeRuns, edge.from);
    return { edge_id: edgeId(edge), source_node_run_id: sourceNodeRun?.node_run_id ?? "", satisfied: qualifiedArtifactsForDestinationEdge(input.workflow, node, edge, input.nodeRuns, input.artifacts).length > 0 };
  });
  const base = { node_run_id: nodeRun?.node_run_id ?? "", node_id: node.id, required_edge_status: requiredEdgeStatus, resolved_inputs: resolvedInputs, eligible_adapter_kinds: node.type === "end" || node.type === "terminate" ? [] : ["codex", "model-api"] as Array<"codex" | "model-api"> };

  if (!nodeRun) return { ...base, decision: "skip", reason_code: "node_run_missing" };
  if (terminalStatuses.has(nodeRun.status)) return { ...base, decision: "skip", reason_code: "node_run_terminal" };
  if (node.type === "end" || node.type === "terminate") return { ...base, decision: "skip", reason_code: "terminal_node" };

  const gate = gateDecision(node, input.workflow, input.nodeRuns, input.artifacts, input.gates, input.runId);
  if (gate.decision) return { ...base, decision: gate.decision, reason_code: gate.reasonCode!, ...(gate.gateInstanceId ? { gate_instance_id: gate.gateInstanceId } : {}) };

  if (nodeRun.status === "blocked") return { ...base, decision: "blocked", reason_code: "node_run_blocked" };
  if (nodeRun.status === "waiting" || nodeRun.status === "reviewing") return { ...base, decision: "wait", reason_code: "node_run_waiting" };

  const requiredBlocked = requiredEdgeStatus.find((status) => !status.satisfied && !activeStatuses.has(nodeRunForNodeId(input.nodeRuns, status.edge_id.split("->")[0])?.status ?? "blocked"));
  const requiredWaiting = requiredEdgeStatus.some((status) => !status.satisfied && activeStatuses.has(nodeRunForNodeId(input.nodeRuns, status.edge_id.split("->")[0])?.status ?? "blocked"));
  const missingRequiredInput = node.inputs.some((nodeInput) => nodeInput.kind === "artifact" && nodeInput.required && !resolvedInputs.some((resolved) => resolved.input_id === nodeInput.id));

  const optionalStates = incomingEdges.filter((edge) => !edge.required).map((edge) => {
    if (qualifiedArtifactsForDestinationEdge(input.workflow, node, edge, input.nodeRuns, input.artifacts).length > 0) return "continue" as const;
    const sourceRun = nodeRunForNodeId(input.nodeRuns, edge.from);
    if (sourceRun && edge.join_policy.wait_if_active && activeStatuses.has(sourceRun.status)) {
      if (!joinTimedOut(edge, sourceRun, input.calculatedAt)) return "wait" as const;
      return edge.join_policy.on_timeout === "continue_if_required_inputs_ready" ? "continue" as const : "blocked" as const;
    }
    return edge.join_policy.on_no_qualified_artifact === "ignore_optional" ? "continue" as const : "blocked" as const;
  });
  const blockedOptionalIndex = optionalStates.findIndex((state) => state === "blocked");
  if (requiredBlocked) return { ...base, decision: "blocked", reason_code: missingRequiredInput ? "required_input_missing" : "required_edge_unsatisfied" };
  if (missingRequiredInput && !requiredWaiting) return { ...base, decision: "blocked", reason_code: "required_input_missing" };
  if (blockedOptionalIndex >= 0) {
    const blockedEdge = incomingEdges.filter((edge) => !edge.required)[blockedOptionalIndex]!;
    const sourceRun = nodeRunForNodeId(input.nodeRuns, blockedEdge.from);
    const timedOut = sourceRun && blockedEdge.join_policy.wait_if_active && activeStatuses.has(sourceRun.status) && joinTimedOut(blockedEdge, sourceRun, input.calculatedAt);
    return { ...base, decision: "blocked", reason_code: timedOut ? `optional_edge_timeout_${blockedEdge.join_policy.on_timeout}` : `optional_edge_no_qualified_artifact_${blockedEdge.join_policy.on_no_qualified_artifact}` };
  }
  if (requiredWaiting) return { ...base, decision: "wait", reason_code: "required_edge_active" };
  if (optionalStates.includes("wait")) return { ...base, decision: "wait", reason_code: "optional_edge_active" };
  return { ...base, decision: "execute", reason_code: "ready" };
}

export function calculateExecutionPlan(input: CalculateExecutionPlanInput): ExecutionPlan {
  const scopedInput: CalculateExecutionPlanInput = { ...input, nodeRuns: input.nodeRuns.filter((nodeRun) => nodeRun.run_id === input.runId), artifacts: input.artifacts.filter((artifact) => artifact.run_id === input.runId), gates: input.gates.filter((gate) => gate.run_id === input.runId) };
  const decisions = scopedInput.workflow.nodes.map((node) => nodeDecision(scopedInput, node));
  return {
    run_id: scopedInput.runId,
    workflow_snapshot_id: scopedInput.workflowSnapshotId,
    calculated_at: scopedInput.calculatedAt,
    revision: scopedInput.revision ?? 0,
    decisions,
    ready_node_run_ids: decisions.filter((decision) => decision.decision === "execute").map((decision) => decision.node_run_id),
    paused_node_run_ids: decisions.filter((decision) => decision.decision === "pause_for_gate").map((decision) => decision.node_run_id),
    blocked_node_run_ids: decisions.filter((decision) => decision.decision === "blocked").map((decision) => decision.node_run_id),
    terminal: scopedInput.workflow.nodes.every((node) => {
      const nodeRun = nodeRunForNodeId(scopedInput.nodeRuns, node.id);
      return nodeRun !== undefined && terminalStatuses.has(nodeRun.status);
    }) && scopedInput.gates.every((gate) => gate.status !== "pending_review")
  };
}
