import type {
  ArtifactManifest,
  AttentionItem,
  GateInstance,
  HistoricalNodeEvidence,
  HistoricalObjectSource,
  HistoricalProjectionInput,
  HistoricalRunProjection,
  HistoricalTraceEvent,
  NodeRun
} from "./types";

function nodeRunId(runId: string, nodeId: string) {
  return `nr_${runId}_${nodeId}`;
}

function sourceObject(objectType: string, sourcePaths: string[], confidence: HistoricalObjectSource["confidence"]): HistoricalObjectSource {
  return {
    object_type: objectType,
    source_paths: sourcePaths,
    confidence,
    import_note: "historical projection; not re-executed"
  };
}

function runStatus(input: HistoricalProjectionInput) {
  if (input.request.sample_kind === "w23" && input.gaps.some((gap) => gap.severity === "error")) return "paused" as const;
  if (input.nodes.some((node) => ["queued", "running", "waiting", "blocked", "reviewing"].includes(node.status))) return "running" as const;
  return "completed" as const;
}

function buildNodeRun(input: HistoricalProjectionInput, evidence: HistoricalNodeEvidence): NodeRun {
  const outputArtifacts = input.artifacts.filter((artifact) => artifact.node_id === evidence.node_id).map((artifact) => artifact.artifact_id);
  const incomingNodeIds = input.workflow.edges.filter((edge) => edge.to === evidence.node_id).map((edge) => edge.from);
  const upstreamArtifacts = input.artifacts.filter((artifact) => incomingNodeIds.includes(artifact.node_id)).map((artifact) => artifact.artifact_id);
  return {
    node_run_id: nodeRunId(input.run_id, evidence.node_id),
    run_id: input.run_id,
    node_id: evidence.node_id,
    status: evidence.status,
    agent_id: input.workflow.nodes.find((node) => node.id === evidence.node_id)?.agent_candidates[0],
    updated_at: evidence.updated_at ?? input.imported_at,
    upstream_artifacts: upstreamArtifacts,
    output_artifacts: outputArtifacts
  };
}

export function buildHistoricalProjection(input: HistoricalProjectionInput): HistoricalRunProjection {
  const snapshotId = `snap_${input.run_id}`;
  const runSpec: HistoricalRunProjection["runSpec"] = {
    run_id: input.run_id,
    workflow_id: input.workflow.id,
    workflow_version: input.workflow.version,
    workflow_snapshot_id: snapshotId,
    status: runStatus(input),
    run_mode: "historical_readonly",
    execution_policy: null,
    source_meta_path: `runs/${input.run_id}/source_meta.json`,
    role_profile: "operator",
    resolved_components: Array.from(new Set(input.workflow.nodes.flatMap((node) => node.recommended_libraries))),
    resolved_provider_policy: input.workflow.provider_policy,
    created_at: input.imported_at
  };
  const workflowSnapshot = {
    snapshot_id: snapshotId,
    run_id: input.run_id,
    frozen_at: input.imported_at,
    workflow: input.workflow
  };
  const nodeRuns = input.nodes.map((evidence) => buildNodeRun(input, evidence));
  const attempts = input.attempts.map(({ confidence: _confidence, source_paths: _sourcePaths, ...attempt }) => attempt);
  const artifacts: ArtifactManifest[] = input.artifacts.map((artifact) => ({
    artifact_id: artifact.artifact_id,
    run_id: input.run_id,
    node_run_id: nodeRunId(input.run_id, artifact.node_id),
    type: artifact.type,
    version: 1,
    path: artifact.path,
    hash: artifact.hash,
    status: artifact.status,
    review_status: artifact.review_status,
    producer: artifact.producer,
    created_at: artifact.created_at ?? input.imported_at
  }));
  const gates: GateInstance[] = input.gates.map((gate) => ({
    gate_instance_id: `gate_${input.run_id}_${gate.gate_spec_id}`,
    run_id: input.run_id,
    gate_spec_id: gate.gate_spec_id,
    target: { type: "ArtifactManifest", id: gate.target_artifact_id },
    status: gate.status,
    required_before: input.workflow.gates.find((spec) => spec.id === gate.gate_spec_id)?.required_before ?? [],
    decisions: gate.decisions
  }));
  const events: HistoricalTraceEvent[] = [
    ...input.source_events.map((event): HistoricalTraceEvent => ({
      event_id: `evt_${input.run_id}_source_${event.source_line}`,
      run_id: input.run_id,
      type: "historical_source_event",
      subject: { type: event.subject_type, id: event.subject_id },
      message: event.message,
      created_at: event.occurred_at,
      source: { path: event.source_path, line: event.source_line, event_type: event.event_type, confidence: "observed_from_event" }
    })),
    {
      event_id: `evt_${input.run_id}_imported`,
      run_id: input.run_id,
      type: "historical_run_imported",
      subject: { type: "RunSpec", id: input.run_id },
      message: `Historical run imported from ${input.request.sample_kind.toUpperCase()} evidence`,
      created_at: input.imported_at
    }
  ];
  const attention: AttentionItem[] = input.gaps.map((gap) => ({
    attention_id: `att_${input.run_id}_${gap.code}`,
    root_cause_key: `historical_gap:${gap.code}`,
    title: gap.message,
    severity: gap.severity === "error" ? "P1" : "P2",
    status: "open",
    related_objects: [{ type: "RunSpec", id: input.run_id, label: input.workflow.name }],
    impact: { blocked_nodes: [], waiting_agents: [], unaffected_paths: [] },
    safe_actions: ["review_source_evidence"]
  }));
  for (const gate of gates.filter((item) => item.status === "pending_review")) {
    const gateEvidence = input.gates.find((item) => item.gate_spec_id === gate.gate_spec_id);
    const inferred = gateEvidence?.confidence === "inferred" || gateEvidence?.confidence === "missing";
    attention.unshift({
      attention_id: `att_${input.run_id}_${gate.gate_spec_id}_pending_review`,
      root_cause_key: `historical_gate_pending:${gate.gate_spec_id}`,
      title: `${gate.gate_spec_id} 等待人工审核`,
      severity: inferred ? "P2" : "P0",
      status: "open",
      related_objects: [
        { type: "GateInstance", id: gate.gate_instance_id },
        { type: "ArtifactManifest", id: gate.target.id }
      ],
      impact: { blocked_nodes: gate.required_before, waiting_agents: [], unaffected_paths: [] },
      safe_actions: inferred ? ["review_source_evidence", "view_artifact"] : ["open_gate_review", "view_artifact"]
    });
  }

  const objects: Record<string, HistoricalObjectSource> = {};
  for (const node of input.nodes) objects[nodeRunId(input.run_id, node.node_id)] = sourceObject("NodeRun", node.source_paths, node.confidence);
  for (const attempt of input.attempts) objects[attempt.attempt_id] = sourceObject("NodeAttempt", attempt.source_paths, attempt.confidence);
  for (const artifact of input.artifacts) objects[artifact.artifact_id] = sourceObject("ArtifactManifest", artifact.source_paths, artifact.confidence);
  for (const gate of input.gates) objects[`gate_${input.run_id}_${gate.gate_spec_id}`] = sourceObject("GateInstance", gate.source_paths, gate.confidence);

  return {
    runSpec,
    workflowSnapshot,
    nodeRuns,
    attempts,
    artifacts,
    gates,
    events,
    attention,
    sourceMeta: {
      importer: "historical-run-importer",
      importer_version: "0.1.0",
      mode: "historical_readonly",
      source_run_dir: input.request.source_run_dir,
      source_fingerprint: input.source_fingerprint,
      imported_at: input.imported_at,
      objects,
      gaps: input.gaps
    },
    manifest: {
      run_id: input.run_id,
      run_spec_path: `runs/${input.run_id}/run_spec.json`,
      workflow_snapshot_path: `runs/${input.run_id}/workflow_snapshot.json`,
      nodes_path: `runs/${input.run_id}/nodes.json`,
      attempts_path: `runs/${input.run_id}/attempts.json`,
      artifacts_path: `runs/${input.run_id}/artifacts.json`,
      gates_path: `runs/${input.run_id}/gates.json`,
      attention_path: `runs/${input.run_id}/attention.json`,
      events_path: `runs/${input.run_id}/events.jsonl`,
      source_meta_path: `runs/${input.run_id}/source_meta.json`
    }
  };
}
