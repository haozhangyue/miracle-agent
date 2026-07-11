import type { NodeRun, RunSpec, TraceEvent, WorkflowSnapshot, WorkflowSpec } from "./types";

export interface CreatedRun {
  runSpec: RunSpec;
  workflowSnapshot: WorkflowSnapshot;
  nodeRuns: NodeRun[];
  events: TraceEvent[];
}

export function createRunFromWorkflow(workflow: WorkflowSpec, options: { runId: string; executionPolicy: "auto" | "manual" | "hybrid"; roleProfile: string; createdAt?: string }): CreatedRun {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const snapshotId = `snap_${options.runId}`;
  const runSpec: RunSpec = {
    run_id: options.runId,
    workflow_id: workflow.id,
    workflow_version: workflow.version,
    workflow_snapshot_id: snapshotId,
    status: "created",
    run_mode: "executable",
    execution_policy: options.executionPolicy,
    role_profile: options.roleProfile,
    resolved_components: Array.from(new Set(workflow.nodes.flatMap((node) => node.recommended_libraries))),
    resolved_provider_policy: workflow.provider_policy,
    created_at: createdAt
  };
  const workflowSnapshot: WorkflowSnapshot = {
    snapshot_id: snapshotId,
    run_id: options.runId,
    frozen_at: createdAt,
    workflow
  };
  const incoming = new Map<string, number>();
  for (const node of workflow.nodes) incoming.set(node.id, 0);
  for (const edge of workflow.edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);

  const nodeRuns = workflow.nodes.map((node): NodeRun => ({
    node_run_id: `nr_${options.runId}_${node.id}`,
    run_id: options.runId,
    node_id: node.id,
    status: (incoming.get(node.id) ?? 0) === 0 ? "queued" : "waiting",
    agent_id: node.agent_candidates[0],
    provider: workflow.provider_policy.default_provider,
    updated_at: createdAt,
    upstream_artifacts: [],
    output_artifacts: []
  }));

  const events: TraceEvent[] = [
    {
      event_id: `evt_${options.runId}_created`,
      run_id: options.runId,
      type: "run_created",
      subject: { type: "RunSpec", id: options.runId },
      message: "RunSpec created and WorkflowSnapshot frozen",
      created_at: createdAt
    }
  ];

  return { runSpec, workflowSnapshot, nodeRuns, events };
}
