import { workflowSpecSchema } from "./schemas";
import type { DryRunPlan, ValidationIssue, ValidationResult, WorkflowSpec } from "./types";

const now = () => new Date().toISOString();

export function validateWorkflowSpec(input: unknown): ValidationResult {
  const parsed = workflowSpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((issue) => ({
        code: "schema_error",
        object_type: "WorkflowSpec",
        object_id: issue.path.join("."),
        message: issue.message
      })),
      warnings: [],
      checked_at: now()
    };
  }

  const workflow = parsed.data as WorkflowSpec;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const nodeIds = new Set<string>();
  const artifactIds = new Set(workflow.artifacts.map((artifact) => artifact.id));
  const gateIds = new Set(workflow.gates.map((gate) => gate.id));

  for (const node of workflow.nodes) {
    if (nodeIds.has(node.id)) {
      errors.push({ code: "duplicate_node", object_type: "NodeSpec", object_id: node.id, message: `重复节点 ${node.id}` });
    }
    nodeIds.add(node.id);

    for (const output of node.outputs) {
      if (output.artifact_spec_ref && !artifactIds.has(output.artifact_spec_ref)) {
        errors.push({
          code: "missing_artifact_ref",
          object_type: "NodeSpec",
          object_id: node.id,
          message: `节点输出引用了不存在的 ArtifactSpec ${output.artifact_spec_ref}`
        });
      }
    }

    if (node.review_gate_ref && !gateIds.has(node.review_gate_ref)) {
      errors.push({
        code: "missing_gate_ref",
        object_type: "NodeSpec",
        object_id: node.id,
        message: `节点引用了不存在的 GateSpec ${node.review_gate_ref}`
      });
    }
  }

  for (const edge of workflow.edges) {
    if (!nodeIds.has(edge.from)) {
      errors.push({ code: "missing_edge_from", object_type: "EdgeSpec", object_id: `${edge.from}->${edge.to}`, message: `边起点不存在：${edge.from}` });
    }
    if (!nodeIds.has(edge.to)) {
      errors.push({ code: "missing_edge_to", object_type: "EdgeSpec", object_id: `${edge.from}->${edge.to}`, message: `边终点不存在：${edge.to}` });
    }
    if (!edge.required && edge.join_policy.on_no_qualified_artifact === "block_downstream") {
      warnings.push({
        code: "optional_edge_blocks_downstream",
        object_type: "EdgeSpec",
        object_id: `${edge.from}->${edge.to}`,
        message: "optional edge 使用 block_downstream 可能阻塞主链路"
      });
    }
  }

  for (const artifact of workflow.artifacts) {
    if (!nodeIds.has(artifact.produced_by)) {
      errors.push({
        code: "missing_artifact_producer",
        object_type: "ArtifactSpec",
        object_id: artifact.id,
        message: `ArtifactSpec producer 不存在：${artifact.produced_by}`
      });
    }
    if (artifact.review_policy.mode !== "none" && artifact.review_policy.gate_spec_id && !gateIds.has(artifact.review_policy.gate_spec_id)) {
      errors.push({
        code: "missing_artifact_gate",
        object_type: "ArtifactSpec",
        object_id: artifact.id,
        message: `ArtifactSpec 审核 gate 不存在：${artifact.review_policy.gate_spec_id}`
      });
    }
  }

  for (const gate of workflow.gates) {
    if (!artifactIds.has(gate.target_artifact_ref)) {
      errors.push({
        code: "missing_gate_artifact",
        object_type: "GateSpec",
        object_id: gate.id,
        message: `GateSpec 目标 ArtifactSpec 不存在：${gate.target_artifact_ref}`
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings, checked_at: now() };
}

export function createDryRunPlan(workflow: WorkflowSpec, availableCredentials: string[] = []): DryRunPlan {
  const validation = validateWorkflowSpec(workflow);
  const missingCredentials = workflow.provider_policy.required_credentials.filter((credential) => !availableCredentials.includes(credential));
  const reviewGateCount = workflow.gates.length;
  const optionalEdges = workflow.edges.filter((edge) => !edge.required);

  return {
    plan_id: `dryrun_${workflow.id}_${Date.now()}`,
    workflow_id: workflow.id,
    valid: validation.valid && missingCredentials.length === 0,
    estimated_cost: {
      min: workflow.nodes.length * 2,
      max: workflow.nodes.length * 6,
      currency: "CNY"
    },
    risks: [
      ...validation.errors.map((error) => ({
        severity: "P0" as const,
        code: error.code,
        message: error.message,
        recovery_actions: ["fix_workflow_spec"]
      })),
      ...missingCredentials.map((credential) => ({
        severity: "P0" as const,
        code: "missing_credential",
        message: `缺少凭证 ${credential}`,
        recovery_actions: ["configure_credential", "switch_provider", "skip_optional_branch"]
      })),
      ...(reviewGateCount > 0
        ? [
            {
              severity: "P1" as const,
              code: "manual_gate_required",
              message: `存在 ${reviewGateCount} 个审核门`,
              recovery_actions: ["prepare_reviewer", "confirm_gate_policy"]
            }
          ]
        : []),
      ...(optionalEdges.length > 0
        ? [
            {
              severity: "P2" as const,
              code: "optional_branch_detected",
              message: `存在 ${optionalEdges.length} 条可选分支，主链路可独立推进`,
              recovery_actions: ["review_join_policy"]
            }
          ]
        : [])
    ],
    nodes: workflow.nodes.map((node) => ({
      node_id: node.id,
      status: node.review_gate_ref ? "requires_review" : "ready"
    }))
  };
}
