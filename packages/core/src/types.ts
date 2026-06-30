export type NodeRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "reviewing"
  | "done"
  | "failed"
  | "skipped";

export type AttemptStatus = "succeeded" | "failed" | "timed_out" | "cancelled" | "aborted" | "unknown";
export type AdapterStatus = AttemptStatus;
export type GateStatus = "pending_review" | "decided" | "invalidated";
export type ArtifactReviewStatus = "none" | "pending_review" | "approved" | "rejected";
export type AttentionStatus = "open" | "acknowledged" | "snoozed" | "resolved";

export interface DomainPack {
  id: string;
  name: string;
  version: string;
  status: "draft" | "experimental" | "stable" | "deprecated" | "blocked";
  categories: string[];
  artifact_types: string[];
  role_profiles: string[];
  workflow_templates: string[];
  component_libraries: string[];
  default_views: Record<string, string>;
}

export interface RoleProfile {
  id: string;
  name: string;
  default_landing: string;
  visible_modules: string[];
  primary_objects: string[];
  default_filters: Record<string, unknown>;
  actions: string[];
}

export interface WorkflowTemplate {
  template_id: string;
  workflow_id: string;
  domain: string;
  name: string;
  version: string;
  status: "draft" | "experimental" | "stable" | "deprecated" | "blocked";
  source: "builtin_template" | "local_project" | "local_registry" | "github_repo";
  tags: string[];
}

export interface NodeSpec {
  id: string;
  name: string;
  type: "start" | "source" | "transform" | "agent" | "tool" | "mcp_tool" | "branch" | "loop" | "review_gate" | "artifact" | "subworkflow" | "end" | "terminate";
  domain_tags?: string[];
  capability_requirements: string[];
  recommended_libraries: string[];
  agent_candidates: string[];
  inputs: NodePortSpec[];
  outputs: NodePortSpec[];
  review_gate_ref?: string;
  failure_policy: {
    retry: number;
    on_missing_input: "blocked" | "failed";
    on_provider_failure: "blocked" | "failed";
  };
}

export interface NodePortSpec {
  id: string;
  kind: "artifact" | "parameter";
  artifact_type?: string;
  required: boolean;
  artifact_spec_ref?: string;
}

export interface EdgeSpec {
  from: string;
  to: string;
  required: boolean;
  artifact_selector?: {
    artifact_type?: string;
    review_status?: ArtifactReviewStatus;
  };
  join_policy: {
    wait_if_active: boolean;
    max_wait?: string;
    on_timeout: "continue_if_required_inputs_ready" | "blocked" | "failed" | "require_decision";
    on_no_qualified_artifact: "ignore_optional" | "block_downstream" | "require_decision";
  };
}

export interface ArtifactSpec {
  id: string;
  type: string;
  produced_by: string;
  review_policy: {
    mode: "none" | "auto" | "manual" | "conditional";
    gate_spec_id?: string;
  };
  required_for: string[];
  versioning: {
    immutable: boolean;
    compare_by: "hash" | "path" | "version";
  };
}

export interface GateSpec {
  id: string;
  name: string;
  target_artifact_ref: string;
  required_before: string[];
  actions: string[];
}

export interface WorkflowSpec {
  id: string;
  name: string;
  version: string;
  domain: string;
  category: string;
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  gates: GateSpec[];
  artifacts: ArtifactSpec[];
  provider_policy: {
    default_provider: string;
    allowed_providers: string[];
    required_credentials: string[];
    fallback_providers: string[];
  };
  layouts: {
    dag: Record<string, { x: number; y: number; stage?: string }>;
    canvas?: {
      zones: Array<{ id: string; name: string; node_ids: string[] }>;
    };
  };
  registry_meta: {
    source: string;
    status: string;
  };
}

export interface RunSpec {
  run_id: string;
  workflow_id: string;
  workflow_version: string;
  workflow_snapshot_id: string;
  status: "created" | "queued" | "running" | "paused" | "cancelling" | "cancelled" | "failed" | "completed" | "aborted";
  execution_policy: "auto" | "manual" | "hybrid";
  role_profile: string;
  resolved_components: string[];
  resolved_provider_policy: WorkflowSpec["provider_policy"];
  created_at: string;
}

export interface WorkflowSnapshot {
  snapshot_id: string;
  run_id: string;
  frozen_at: string;
  workflow: WorkflowSpec;
}

export interface NodeRun {
  node_run_id: string;
  run_id: string;
  node_id: string;
  status: NodeRunStatus;
  agent_id?: string;
  provider?: string;
  started_at?: string;
  updated_at: string;
  blocked_reason?: string;
  upstream_artifacts: string[];
  output_artifacts: string[];
}

export interface NodeAttempt {
  attempt_id: string;
  node_run_id: string;
  operation_id: string;
  status: AttemptStatus;
  provider_receipt?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
}

export interface AdapterInvocation {
  operation_id: string;
  run_id: string;
  node_run_id: string;
  node_id: string;
  adapter_kind: "mock-local" | "codex" | "hermes" | "openclaw" | "official-api";
  provider: string;
  capability_requirements: string[];
  input_artifacts: string[];
  expected_outputs: Array<{
    output_id: string;
    artifact_type: string;
    artifact_spec_ref?: string;
    required: boolean;
  }>;
  dispatched_at: string;
}

export interface AdapterArtifactDescriptor {
  artifact_id: string;
  output_id: string;
  artifact_spec_ref?: string;
  type: string;
  path: string;
  hash: string;
  status: ArtifactManifest["status"];
  review_status: ArtifactReviewStatus;
  content?: string;
}

export interface AdapterResult {
  operation_id: string;
  node_run_id: string;
  status: AdapterStatus;
  provider_receipt: {
    provider: string;
    adapter_kind: AdapterInvocation["adapter_kind"];
    model?: string;
    cost?: number;
    latency_ms?: number;
    raw_receipt_id?: string;
  };
  artifact_descriptors: AdapterArtifactDescriptor[];
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
  received_at: string;
}

export interface TraceEvent {
  event_id: string;
  run_id: string;
  type: string;
  subject: {
    type: string;
    id: string;
  };
  message: string;
  created_at: string;
}

export interface ArtifactManifest {
  artifact_id: string;
  run_id: string;
  node_run_id: string;
  type: string;
  version: number;
  path: string;
  hash: string;
  status: "created" | "pending" | "missing" | "hidden";
  review_status: ArtifactReviewStatus;
  producer: string;
  created_at: string;
}

export interface GateInstance {
  gate_instance_id: string;
  run_id: string;
  gate_spec_id: string;
  target: {
    type: "ArtifactManifest";
    id: string;
  };
  status: GateStatus;
  required_before: string[];
  decisions: GateDecision[];
}

export interface GateDecision {
  decision_id: string;
  actor: string;
  decision: "approve" | "reject" | "request_changes";
  comment: string;
  created_at: string;
}

export interface AgentHealthProjection {
  agent_id: string;
  name: string;
  status: "idle" | "queued" | "running" | "waiting" | "blocked" | "reviewing" | "done" | "failed";
  active_runs: string[];
  current_node_runs: string[];
  queued_node_runs: string[];
  blocked_reason?: string | null;
  waiting_for: string[];
  equipped_libraries: string[];
}

export interface AttentionItem {
  attention_id: string;
  root_cause_key: string;
  title: string;
  severity: "P0" | "P1" | "P2";
  status: AttentionStatus;
  related_objects: Array<{ type: string; id: string; label?: string }>;
  impact: {
    blocked_nodes: string[];
    waiting_agents: string[];
    unaffected_paths: string[];
  };
  safe_actions: string[];
}

export interface DryRunPlan {
  plan_id: string;
  workflow_id: string;
  valid: boolean;
  estimated_cost: {
    min: number;
    max: number;
    currency: string;
  };
  risks: Array<{
    severity: "P0" | "P1" | "P2";
    code: string;
    message: string;
    recovery_actions: string[];
  }>;
  nodes: Array<{ node_id: string; status: "ready" | "blocked" | "requires_review" }>;
}

export interface ValidationIssue {
  code: string;
  object_type: string;
  object_id: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  checked_at: string;
}

export interface CanvasLayout {
  workflow_id?: string;
  status?: "draft" | "published";
  updated_at?: string;
  objects: Array<{
    id: string;
    type: "task" | "agent" | "artifact" | "node" | "zone" | "version_branch";
    title?: string;
    ref_id?: string;
    zone_id?: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
  }>;
}

export interface SpecDiff {
  diff_id: string;
  workflow_id: string;
  operations: Array<{ op: "add" | "replace" | "remove"; path: string; value?: unknown }>;
}

export interface EvolutionCandidate {
  candidate_id: string;
  source_run_id: string;
  status: "draft" | "evaluating" | "approved" | "rejected";
  suggestion: string;
}

export interface DagProjection {
  nodes: Array<{
    id: string;
    node_run_id?: string;
    name: string;
    type: NodeSpec["type"];
    status: NodeRunStatus;
    agent_id?: string;
    provider?: string;
    position: { x: number; y: number; stage?: string };
    stage: string;
    input_artifacts: string[];
    output_artifacts: string[];
    review_gate_ref?: string;
  }>;
  edges: Array<{
    id: string;
    from: string;
    to: string;
    required: boolean;
    label: string;
    join_policy: EdgeSpec["join_policy"];
  }>;
}

export interface ArtifactPreview {
  artifact: ArtifactManifest;
  preview: {
    available: boolean;
    mode: "markdown" | "json" | "text" | "binary" | "missing";
    content?: string;
    truncated?: boolean;
    reason?: string;
  };
}

export interface GateDecisionProjection {
  gate_instance_id: string;
  current_status: GateStatus;
  target_artifact_id: string;
  projected_artifact_review_status: ArtifactReviewStatus;
  affected_node_runs: Array<{
    node_id: string;
    node_run_id?: string;
    current_status?: NodeRunStatus;
    projected_status: NodeRunStatus;
    reason: string;
  }>;
  event_types: string[];
  mutates_artifact: false;
}
