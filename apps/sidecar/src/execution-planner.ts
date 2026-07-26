import { calculateExecutionPlan, type ArtifactManifest, type ExecutionPlan, type GateInstance, type NodeRun, type RunSpec, type WorkflowSpec } from "@miracle/core";

export interface RunExecutionPlanBundle {
  run: Pick<RunSpec, "run_id" | "workflow_snapshot_id">;
  workflow: WorkflowSpec;
  nodes: NodeRun[];
  artifacts: ArtifactManifest[];
  gates: GateInstance[];
}

export function buildRunExecutionPlan(input: RunExecutionPlanBundle): ExecutionPlan {
  return calculateExecutionPlan({
    runId: input.run.run_id,
    workflowSnapshotId: input.run.workflow_snapshot_id,
    workflow: input.workflow,
    nodeRuns: input.nodes,
    artifacts: input.artifacts,
    gates: input.gates,
    calculatedAt: new Date().toISOString()
  });
}
