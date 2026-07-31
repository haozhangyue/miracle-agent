import { z } from "zod";
import type {
  AdapterInvocation,
  AdapterResult,
  ExecutionPlan,
  NodeExecutionDecision,
  ResolvedNodeInput,
  RetryPolicy,
  RetryScheduleRecord,
  RetryStateRecord
} from "./types";

const credentialScopeSchema = z.object({
  credential_ref: z.string(),
  required_for_branch: z.string(),
  blocking_scope: z.enum(["required_path", "optional_branch"])
});

const nodePortSchema = z.object({
  id: z.string().min(1).max(256),
  kind: z.enum(["artifact", "parameter"]),
  artifact_type: z.string().optional(),
  required: z.boolean(),
  optional_path_id: z.string().min(1).optional(),
  artifact_spec_ref: z.string().optional()
});

export const nodeSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["start", "source", "transform", "agent", "tool", "mcp_tool", "branch", "loop", "review_gate", "artifact", "subworkflow", "end", "terminate"]),
  domain_tags: z.array(z.string()).optional(),
  capability_requirements: z.array(z.string()),
  recommended_libraries: z.array(z.string()),
  agent_candidates: z.array(z.string()),
  inputs: z.array(nodePortSchema),
  outputs: z.array(nodePortSchema),
  review_gate_ref: z.string().optional(),
  failure_policy: z.object({
    retry: z.number().int().min(0),
    cost_budget: z.number().finite().min(0).optional(),
    retry_policy: z.lazy(() => retryPolicySchema).optional(),
    on_missing_input: z.enum(["blocked", "failed"]),
    on_provider_failure: z.enum(["blocked", "failed"])
  })
});

export const canvasNodeSpecDraftSchema = z.object({
  draft_id: z.string(),
  status: z.enum(["draft", "ready", "invalid"]),
  created_from: z.literal("canvas"),
  node_spec: nodeSpecSchema
});

export const edgeSpecSchema = z.object({
  from: z.string(),
  to: z.string(),
  required: z.boolean(),
  artifact_selector: z
    .object({
      artifact_type: z.string().optional(),
      review_status: z.enum(["none", "pending_review", "approved", "rejected"]).optional()
    })
    .optional(),
  join_policy: z.object({
    wait_if_active: z.boolean(),
    max_wait: z.string().optional(),
    on_timeout: z.enum(["continue_if_required_inputs_ready", "blocked", "failed", "require_decision"]),
    on_no_qualified_artifact: z.enum(["ignore_optional", "block_downstream", "require_decision"])
  })
});

export const artifactSpecSchema = z.object({
  id: z.string(),
  type: z.string(),
  produced_by: z.string(),
  review_policy: z.object({
    mode: z.enum(["none", "auto", "manual", "conditional"]),
    gate_spec_id: z.string().optional()
  }),
  required_for: z.array(z.string()),
  versioning: z.object({
    immutable: z.boolean(),
    compare_by: z.enum(["hash", "path", "version"])
  })
});

export const gateSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  target_artifact_ref: z.string(),
  required_before: z.array(z.string()),
  actions: z.array(z.string())
});

export const workflowSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  domain: z.string(),
  category: z.string(),
  nodes: z.array(nodeSpecSchema),
  edges: z.array(edgeSpecSchema),
  gates: z.array(gateSpecSchema),
  artifacts: z.array(artifactSpecSchema),
  provider_policy: z.object({
    default_provider: z.string(),
    allowed_providers: z.array(z.string()),
    required_credentials: z.array(z.string()),
    fallback_providers: z.array(z.string()),
    credential_scopes: z.array(credentialScopeSchema).optional()
  }),
  layouts: z.object({
    dag: z.record(z.string(), z.object({ x: z.number(), y: z.number(), stage: z.string().optional() })),
    canvas: z.object({ zones: z.array(z.object({ id: z.string(), name: z.string(), node_ids: z.array(z.string()) })) }).optional()
  }),
  registry_meta: z.object({
    source: z.string(),
    status: z.string()
  })
});

export const resolvedNodeInputSchema: z.ZodType<ResolvedNodeInput> = z.object({
  input_id: z.string().min(1),
  source_kind: z.enum(["run_input", "artifact", "parameter"]),
  source_ref: z.string().min(1),
  artifact_id: z.string().min(1).optional(),
  artifact_version: z.number().int().positive().optional(),
  artifact_hash: z.string().min(1).optional(),
  media_type: z.string().min(1),
  required: z.boolean(),
  resolved_at: z.string().min(1)
});

export const nodeExecutionDecisionSchema: z.ZodType<NodeExecutionDecision> = z.object({
  node_run_id: z.string(),
  node_id: z.string().min(1),
  decision: z.enum(["execute", "wait", "pause_for_gate", "blocked", "skip"]),
  reason_code: z.string().min(1),
  gate_instance_id: z.string().min(1).optional(),
  required_edge_status: z.array(z.object({
    edge_id: z.string().min(1),
    source_node_run_id: z.string(),
    satisfied: z.boolean()
  })),
  resolved_inputs: z.array(resolvedNodeInputSchema),
  eligible_adapter_kinds: z.array(z.enum(["codex", "model-api"])),
  selected_provider_profile_id: z.string().min(1).optional()
});

export const executionPlanSchema: z.ZodType<ExecutionPlan> = z.object({
  run_id: z.string(),
  workflow_snapshot_id: z.string(),
  calculated_at: z.string().min(1),
  revision: z.number().int().nonnegative(),
  decisions: z.array(nodeExecutionDecisionSchema),
  ready_node_run_ids: z.array(z.string()),
  paused_node_run_ids: z.array(z.string()),
  blocked_node_run_ids: z.array(z.string()),
  terminal: z.boolean()
});

export const domainPackSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  status: z.enum(["draft", "experimental", "stable", "deprecated", "blocked"]),
  categories: z.array(z.string()),
  artifact_types: z.array(z.string()),
  role_profiles: z.array(z.string()),
  workflow_templates: z.array(z.string()),
  component_libraries: z.array(z.string()),
  default_views: z.record(z.string(), z.string())
});

export const roleProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  default_landing: z.string(),
  visible_modules: z.array(z.string()),
  primary_objects: z.array(z.string()),
  default_filters: z.record(z.string(), z.unknown()),
  actions: z.array(z.string())
});

export const workflowTemplateSchema = z.object({
  template_id: z.string(),
  workflow_id: z.string(),
  domain: z.string(),
  name: z.string(),
  version: z.string(),
  status: z.enum(["draft", "experimental", "stable", "deprecated", "blocked"]),
  source: z.enum(["builtin_template", "local_project", "local_registry", "github_repo"]),
  tags: z.array(z.string())
});

const runSpecBaseSchema = z.object({
  run_id: z.string(),
  workflow_id: z.string(),
  workflow_version: z.string(),
  workflow_snapshot_id: z.string(),
  status: z.enum(["created", "queued", "running", "paused", "cancelling", "cancelled", "failed", "completed", "aborted"]),
  role_profile: z.string(),
  resolved_components: z.array(z.string()),
  resolved_provider_policy: z.object({
    default_provider: z.string(),
    allowed_providers: z.array(z.string()),
    required_credentials: z.array(z.string()),
    fallback_providers: z.array(z.string()),
    credential_scopes: z.array(credentialScopeSchema).optional()
  }),
  created_at: z.string()
});

export const executableRunSpecSchema = runSpecBaseSchema.extend({
  run_mode: z.literal("executable").default("executable"),
  execution_policy: z.enum(["auto", "manual", "hybrid"])
});

export const historicalRunSpecSchema = runSpecBaseSchema.extend({
  run_mode: z.literal("historical_readonly"),
  execution_policy: z.null(),
  source_meta_path: z.string()
});

export const runSpecSchema = z.union([executableRunSpecSchema, historicalRunSpecSchema]);

export const adapterCredentialRequirementSchema = z.object({
  key: z.string(),
  label: z.string(),
  source: z.enum(["env", "keychain", "workspace-secret"]),
  required: z.boolean(),
  providers: z.array(z.string()).optional()
});

export const adapterManifestSchema = z.object({
  id: z.string(),
  kind: z.enum(["mock-local", "codex", "hermes", "openclaw", "official-api"]),
  display_name: z.string(),
  version: z.string(),
  status: z.enum(["draft", "experimental", "stable", "deprecated", "blocked"]),
  description: z.string(),
  execution_mode: z.enum(["mock-compatible", "external", "shell"]),
  capabilities: z.array(z.string()),
  supported_providers: z.array(z.string()),
  default_provider: z.string(),
  required_credentials: z.array(adapterCredentialRequirementSchema),
  runtime: z.object({
    local_executor: z.enum(["mock-runner", "codex-cli", "external-api", "not-implemented"]),
    can_execute: z.boolean(),
    entrypoint: z.string().optional()
  })
});

const adapterKindSchema = z.enum(["mock-local", "codex", "hermes", "openclaw", "official-api"]);
const adapterStatusSchema = z.enum(["succeeded", "failed", "timed_out", "cancelled", "aborted", "unknown"]);

export const adapterRuntimeControlSchema = z.object({
  timeout_ms: z.number().int().positive(),
  cancellation_token_id: z.string().min(1),
  attempt_workspace: z.string().min(1),
  sandbox: z.enum(["read-only", "workspace-write"])
});

export const adapterInvocationSchema = z.object({
  operation_id: z.string().min(1),
  attempt_id: z.string().min(1),
  attempt_number: z.number().int().positive().default(1),
  run_id: z.string().min(1),
  node_run_id: z.string().min(1),
  node_id: z.string().min(1),
  adapter_kind: adapterKindSchema,
  adapter_id: z.string().min(1),
  provider: z.string().min(1),
  capability_requirements: z.array(z.string()),
  input_artifacts: z.array(z.string()),
  resolved_inputs: z.array(resolvedNodeInputSchema),
  expected_outputs: z.array(z.object({
    output_id: z.string().min(1),
    artifact_type: z.string().min(1),
    artifact_spec_ref: z.string().optional(),
    required: z.boolean()
  })),
  runtime_control: adapterRuntimeControlSchema,
  prompt_path: z.string().min(1),
  output_schema_path: z.string().min(1),
  dispatched_at: z.string().min(1)
});

export const providerReceiptSchema = z.object({
  provider: z.string().min(1),
  adapter_kind: adapterKindSchema,
  adapter_id: z.string().min(1),
  model: z.string().min(1).optional(),
  operation_id: z.string().min(1),
  external_session_id: z.string().min(1).optional(),
  cost: z.number().min(0).optional(),
  latency_ms: z.number().min(0).optional(),
  raw_receipt_id: z.string().min(1).optional()
});

export const adapterArtifactDescriptorSchema = z.object({
  artifact_id: z.string().min(1),
  output_id: z.string().min(1),
  artifact_spec_ref: z.string().min(1).optional(),
  type: z.string().min(1),
  path: z.string().min(1),
  hash: z.string().min(1),
  status: z.enum(["created", "pending", "missing", "hidden"]),
  review_status: z.enum(["none", "pending_review", "approved", "rejected"]),
  content: z.string().optional()
});

export const artifactManifestSchema = z.object({
  artifact_id: z.string().min(1),
  artifact_spec_ref: z.string().min(1).optional(),
  run_id: z.string().min(1),
  node_run_id: z.string().min(1),
  type: z.string().min(1),
  version: z.number().int().positive(),
  path: z.string().min(1),
  hash: z.string().min(1),
  status: z.enum(["created", "pending", "missing", "hidden"]),
  review_status: z.enum(["none", "pending_review", "approved", "rejected"]),
  producer: z.string().min(1),
  created_at: z.string().min(1),
  supersedes_artifact_id: z.string().min(1).optional(),
  rework_of_gate_instance_id: z.string().min(1).optional()
});

export const adapterResultSchema = z.object({
  operation_id: z.string().min(1),
  attempt_id: z.string().min(1),
  node_run_id: z.string().min(1),
  status: adapterStatusSchema,
  provider_receipt: providerReceiptSchema,
  artifact_descriptors: z.array(adapterArtifactDescriptorSchema),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    recoverable: z.boolean()
  }).optional(),
  received_at: z.string().min(1)
}).superRefine((result, context) => {
  if (result.provider_receipt.operation_id !== result.operation_id) {
    context.addIssue({
      code: "custom",
      path: ["provider_receipt", "operation_id"],
      message: "provider_receipt.operation_id must match AdapterResult.operation_id"
    });
  }
});

const finiteNonNegativeNumber = z.number().finite().min(0);
const finitePositiveNumber = z.number().finite().positive();
const finiteNonNegativeMs = finiteNonNegativeNumber.int();
const finitePositiveMs = finitePositiveNumber.int();

export const retryPolicySchema: z.ZodType<RetryPolicy> = z.object({
  max_attempts: z.number().finite().int().min(1).max(3),
  backoff: z.enum(["fixed", "exponential"]),
  initial_delay_ms: finiteNonNegativeMs,
  max_delay_ms: finiteNonNegativeMs,
  retryable_error_codes: z.array(z.string().min(1)),
  attempt_timeout_ms: finitePositiveMs,
  total_time_budget_ms: finitePositiveMs,
  cost_budget: finiteNonNegativeNumber,
  manual_confirmation_after: z.number().finite().int().min(1).max(3).optional()
}).superRefine((policy, context) => {
  if (policy.max_delay_ms < policy.initial_delay_ms) {
    context.addIssue({
      code: "custom",
      path: ["max_delay_ms"],
      message: "max_delay_ms must be greater than or equal to initial_delay_ms"
    });
  }
  if (policy.manual_confirmation_after !== undefined && policy.manual_confirmation_after > policy.max_attempts) {
    context.addIssue({
      code: "custom",
      path: ["manual_confirmation_after"],
      message: "manual_confirmation_after must not exceed max_attempts"
    });
  }
});

export const retryBudgetSnapshotSchema = z.object({
  attempts_used: z.number().int().nonnegative(),
  elapsed_ms: finiteNonNegativeNumber,
  cost_used: finiteNonNegativeNumber,
  max_attempts: z.number().int().min(1).max(3),
  total_time_budget_ms: finitePositiveNumber,
  cost_budget: finiteNonNegativeNumber.default(5)
});

export const retryScheduleRecordSchema: z.ZodType<RetryScheduleRecord> = z.object({
  operation_id: z.string().min(1),
  node_run_id: z.string().min(1),
  attempt_number: z.number().int().min(2),
  reason_code: z.string().min(1),
  scheduled_for: z.string().datetime(),
  budget_snapshot: retryBudgetSnapshotSchema
});

export const retryStateRecordSchema: z.ZodType<RetryStateRecord> = z.object({
  operation_id: z.string().min(1),
  node_run_id: z.string().min(1),
  phase: z.enum(["waiting_for_retry", "exhausted", "blocked"]),
  reason_code: z.string().min(1),
  decision: z.object({
    action: z.enum(["schedule_retry", "require_attention", "fail_terminal"]),
    phase: z.enum(["waiting_for_retry", "due", "exhausted", "blocked"]).optional(),
    reason_code: z.string().min(1),
    operation_id: z.string().min(1),
    next_attempt_number: z.number().int().min(2).optional(),
    delay_ms: finiteNonNegativeMs.optional(),
    scheduled_for: z.string().datetime().optional(),
    budget_snapshot: retryBudgetSnapshotSchema
  }),
  updated_at: z.string().datetime()
});

export function parseAdapterResultForInvocation(invocation: AdapterInvocation, result: AdapterResult): AdapterResult {
  const parsedInvocation = adapterInvocationSchema.parse(invocation);
  const parsedResult = adapterResultSchema.parse(result);
  const associations: Array<[string, string, string]> = [
    ["operation_id", parsedInvocation.operation_id, parsedResult.operation_id],
    ["attempt_id", parsedInvocation.attempt_id, parsedResult.attempt_id],
    ["node_run_id", parsedInvocation.node_run_id, parsedResult.node_run_id],
    ["adapter_id", parsedInvocation.adapter_id, parsedResult.provider_receipt.adapter_id],
    ["adapter_kind", parsedInvocation.adapter_kind, parsedResult.provider_receipt.adapter_kind],
    ["provider", parsedInvocation.provider, parsedResult.provider_receipt.provider]
  ];

  for (const [field, expected, actual] of associations) {
    if (expected !== actual) throw new Error(`AdapterResult ${field} does not match AdapterInvocation`);
  }
  return parsedResult;
}
