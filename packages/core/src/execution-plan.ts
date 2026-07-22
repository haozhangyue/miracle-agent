import type {
  ArtifactManifest,
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

function compareNodeRuns(left: NodeRun, right: NodeRun) {
  if (left.updated_at !== right.updated_at) return right.updated_at.localeCompare(left.updated_at);
  return left.node_run_id.localeCompare(right.node_run_id);
}

function nodeRunForNodeId(nodeRuns: NodeRun[], nodeId: string) {
  return [...nodeRuns].filter((nodeRun) => nodeRun.node_id === nodeId).sort(compareNodeRuns)[0];
}

function latestGateDecision(gate: GateInstance) {
  return [...gate.decisions].sort((left, right) => {
    if (left.created_at !== right.created_at) return right.created_at.localeCompare(left.created_at);
    return right.decision_id.localeCompare(left.decision_id);
  })[0];
}

function latestArtifactForSpec(workflow: WorkflowSpec, artifactSpecId: string, nodeRuns: NodeRun[], artifacts: ArtifactManifest[]) {
  const artifactSpec = workflow.artifacts.find((item) => item.id === artifactSpecId);
  if (!artifactSpec) return undefined;
  const producerRun = nodeRunForNodeId(nodeRuns, artifactSpec.produced_by);
  return newestArtifact(artifacts.filter((artifact) => artifact.node_run_id === producerRun?.node_run_id && artifact.status === "created" && artifact.type === artifactSpec.type));
}

function gateForSpec(workflow: WorkflowSpec, gates: GateInstance[], gateSpecId: string, runId: string, nodeRuns: NodeRun[], artifacts: ArtifactManifest[]) {
  const targetArtifact = latestArtifactForSpec(workflow, workflow.gates.find((gate) => gate.id === gateSpecId)?.target_artifact_ref ?? "", nodeRuns, artifacts);
  return [...gates]
    .filter((gate) => gate.gate_spec_id === gateSpecId && gate.run_id === runId)
    .filter((gate) => !targetArtifact || gate.target.id === targetArtifact.artifact_id)
    .sort((left, right) => left.gate_instance_id.localeCompare(right.gate_instance_id))[0];
}

function artifactsForEdge(workflow: WorkflowSpec, edge: EdgeSpec, nodeRuns: NodeRun[], artifacts: ArtifactManifest[]) {
  const sourceRun = nodeRunForNodeId(nodeRuns, edge.from);
  const sourceArtifactSpecs = workflow.artifacts.filter((artifactSpec) => artifactSpec.produced_by === edge.from);
  return artifacts.filter((artifact) => {
    if (artifact.node_run_id !== sourceRun?.node_run_id || artifact.status !== "created") return false;
    if (sourceArtifactSpecs.length > 0 && !sourceArtifactSpecs.some((artifactSpec) => artifactSpec.type === artifact.type)) return false;
    if (edge.artifact_selector?.artifact_type && artifact.type !== edge.artifact_selector.artifact_type) return false;
    if (edge.artifact_selector?.review_status && artifact.review_status !== edge.artifact_selector.review_status) return false;
    return true;
  });
}

function newestArtifact(artifacts: ArtifactManifest[]) {
  return [...artifacts].sort((left, right) => {
    if (left.version !== right.version) return right.version - left.version;
    if (left.created_at !== right.created_at) return right.created_at.localeCompare(left.created_at);
    return left.artifact_id.localeCompare(right.artifact_id);
  })[0];
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

function inputMatchesEdge(workflow: WorkflowSpec, node: NodeSpec, input: NodeSpec["inputs"][number], edge: EdgeSpec) {
  if (input.kind !== "artifact") return false;
  if (!input.artifact_spec_ref) return true;
  const artifactSpec = workflow.artifacts.find((item) => item.id === input.artifact_spec_ref);
  return artifactSpec?.produced_by === edge.from && (!input.artifact_type || artifactSpec.type === input.artifact_type);
}

function requiredArtifactType(workflow: WorkflowSpec, input: NodeSpec["inputs"][number]) {
  return input.artifact_type ?? (input.artifact_spec_ref ? workflow.artifacts.find((item) => item.id === input.artifact_spec_ref)?.type : undefined);
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
  const incomingEdges = input.workflow.edges.filter((edge) => edge.to === input.node.id);
  return input.node.inputs.flatMap((nodeInput) => {
    if (nodeInput.kind === "parameter") {
      return [{
        input_id: nodeInput.id,
        source_kind: "parameter" as const,
        source_ref: nodeInput.id,
        media_type: nodeInput.artifact_type ?? "application/json",
        required: nodeInput.required,
        resolved_at: input.calculatedAt
      }];
    }

    const candidates = incomingEdges
      .filter((edge) => inputMatchesEdge(input.workflow, input.node, nodeInput, edge))
      .flatMap((edge) => artifactsForEdge(input.workflow, edge, input.nodeRuns, input.artifacts))
      .filter((artifact) => !requiredArtifactType(input.workflow, nodeInput) || artifact.type === requiredArtifactType(input.workflow, nodeInput));
    const artifact = newestArtifact(candidates);
    return artifact ? [resolvedArtifactInput(nodeInput, artifact, input.calculatedAt)] : [];
  });
}

function gateDecision(node: NodeSpec, workflow: WorkflowSpec, nodeRuns: NodeRun[], artifacts: ArtifactManifest[], gates: GateInstance[], runId: string): { decision?: ExecutionDecision; reasonCode?: string } {
  const requiredGates = workflow.gates.filter((gate) => gate.required_before.includes(node.id));
  for (const requiredGate of requiredGates) {
    const gate = gateForSpec(workflow, gates, requiredGate.id, runId, nodeRuns, artifacts);
    const latestDecision = gate && latestGateDecision(gate)?.decision;
    if (gate?.status === "decided" && latestDecision === "approve") continue;
    if (latestDecision === "reject" || latestDecision === "request_changes" || gate?.status === "invalidated") {
      return { decision: "blocked", reasonCode: "required_gate_rejected" };
    }
    return { decision: "pause_for_gate", reasonCode: "required_gate_pending" };
  }
  return {};
}

function nodeDecision(input: CalculateExecutionPlanInput, node: NodeSpec, runId: string): NodeExecutionDecision {
  const nodeRun = nodeRunForNodeId(input.nodeRuns, node.id);
  const incomingEdges = input.workflow.edges.filter((edge) => edge.to === node.id);
  const requiredEdges = incomingEdges.filter((edge) => edge.required);
  const resolvedInputs = resolveNodeInputs({ workflow: input.workflow, node, nodeRuns: input.nodeRuns, artifacts: input.artifacts, calculatedAt: input.calculatedAt });
  const requiredEdgeStatus = requiredEdges.map((edge) => {
    const sourceNodeRun = nodeRunForNodeId(input.nodeRuns, edge.from);
    return {
      edge_id: edgeId(edge),
      source_node_run_id: sourceNodeRun?.node_run_id ?? "",
      satisfied: artifactsForEdge(input.workflow, edge, input.nodeRuns, input.artifacts).length > 0
    };
  });
  const base = {
    node_run_id: nodeRun?.node_run_id ?? "",
    node_id: node.id,
    required_edge_status: requiredEdgeStatus,
    resolved_inputs: resolvedInputs,
    eligible_adapter_kinds: node.type === "end" || node.type === "terminate" ? [] : ["codex", "model-api"] as Array<"codex" | "model-api">
  };

  if (!nodeRun) return { ...base, decision: "skip", reason_code: "node_run_missing" };
  if (terminalStatuses.has(nodeRun.status)) return { ...base, decision: "skip", reason_code: "node_run_terminal" };
  if (node.type === "end" || node.type === "terminate") return { ...base, decision: "skip", reason_code: "terminal_node" };
  if (nodeRun.status === "blocked") return { ...base, decision: "blocked", reason_code: "node_run_blocked" };
  if (nodeRun.status === "waiting" || nodeRun.status === "reviewing") return { ...base, decision: "wait", reason_code: "node_run_waiting" };

  const gate = gateDecision(node, input.workflow, input.nodeRuns, input.artifacts, input.gates, runId);
  if (gate.decision) return { ...base, decision: gate.decision, reason_code: gate.reasonCode! };

  const unsatisfiedRequired = requiredEdges.find((edge) => artifactsForEdge(input.workflow, edge, input.nodeRuns, input.artifacts).length === 0);
  if (unsatisfiedRequired) {
    const sourceRun = nodeRunForNodeId(input.nodeRuns, unsatisfiedRequired.from);
    if (sourceRun && activeStatuses.has(sourceRun.status)) return { ...base, decision: "wait", reason_code: "required_edge_active" };
    return { ...base, decision: "blocked", reason_code: "required_edge_unsatisfied" };
  }

  const missingRequiredInput = node.inputs.some((nodeInput) => nodeInput.kind === "artifact" && nodeInput.required && !resolvedInputs.some((resolved) => resolved.input_id === nodeInput.id));
  if (missingRequiredInput) return { ...base, decision: "blocked", reason_code: "required_input_missing" };

  const activeOptional = incomingEdges.find((edge) => {
    if (edge.required || !edge.join_policy.wait_if_active || artifactsForEdge(input.workflow, edge, input.nodeRuns, input.artifacts).length > 0) return false;
    const sourceRun = nodeRunForNodeId(input.nodeRuns, edge.from);
    return sourceRun !== undefined && activeStatuses.has(sourceRun.status) && !joinTimedOut(edge, sourceRun, input.calculatedAt);
  });
  if (activeOptional) return { ...base, decision: "wait", reason_code: "optional_edge_active" };

  const timedOutOptional = incomingEdges.find((edge) => {
    if (edge.required || !edge.join_policy.wait_if_active || artifactsForEdge(input.workflow, edge, input.nodeRuns, input.artifacts).length > 0) return false;
    const sourceRun = nodeRunForNodeId(input.nodeRuns, edge.from);
    return sourceRun !== undefined && activeStatuses.has(sourceRun.status) && joinTimedOut(edge, sourceRun, input.calculatedAt);
  });
  if (timedOutOptional && timedOutOptional.join_policy.on_timeout !== "continue_if_required_inputs_ready") {
    return { ...base, decision: "blocked", reason_code: `optional_edge_timeout_${timedOutOptional.join_policy.on_timeout}` };
  }

  const optionalWithoutArtifact = incomingEdges.find((edge) => {
    if (edge.required || artifactsForEdge(input.workflow, edge, input.nodeRuns, input.artifacts).length > 0) return false;
    const sourceRun = nodeRunForNodeId(input.nodeRuns, edge.from);
    return !(sourceRun && edge.join_policy.wait_if_active && joinTimedOut(edge, sourceRun, input.calculatedAt) && edge.join_policy.on_timeout === "continue_if_required_inputs_ready");
  });
  if (optionalWithoutArtifact && optionalWithoutArtifact.join_policy.on_no_qualified_artifact !== "ignore_optional") {
    return { ...base, decision: "blocked", reason_code: `optional_edge_no_qualified_artifact_${optionalWithoutArtifact.join_policy.on_no_qualified_artifact}` };
  }

  return { ...base, decision: "execute", reason_code: "ready" };
}

export function calculateExecutionPlan(input: CalculateExecutionPlanInput): ExecutionPlan {
  const runId = input.runId ?? [...new Set(input.nodeRuns.map((nodeRun) => nodeRun.run_id))].sort()[0] ?? "";
  const scopedInput: CalculateExecutionPlanInput = {
    ...input,
    nodeRuns: input.nodeRuns.filter((nodeRun) => nodeRun.run_id === runId),
    artifacts: input.artifacts.filter((artifact) => artifact.run_id === runId),
    gates: input.gates.filter((gate) => gate.run_id === runId)
  };
  const decisions = scopedInput.workflow.nodes.map((node) => nodeDecision(scopedInput, node, runId));
  return {
    run_id: runId,
    workflow_snapshot_id: input.workflowSnapshotId ?? `snap_${runId}`,
    calculated_at: input.calculatedAt,
    revision: input.revision ?? 0,
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
