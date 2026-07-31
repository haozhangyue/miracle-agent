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
    cost_budget?: number;
    retry_policy?: RetryPolicy;
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
  optional_path_id?: string;
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
    credential_scopes?: Array<{
      credential_ref: string;
      required_for_branch: string;
      blocking_scope: "required_path" | "optional_branch";
    }>;
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

export interface RunSpecBase {
  run_id: string;
  workflow_id: string;
  workflow_version: string;
  workflow_snapshot_id: string;
  status: "created" | "queued" | "running" | "paused" | "cancelling" | "cancelled" | "failed" | "completed" | "aborted";
  role_profile: string;
  resolved_components: string[];
  resolved_provider_policy: WorkflowSpec["provider_policy"];
  created_at: string;
}

export interface ExecutableRunSpec extends RunSpecBase {
  run_mode: "executable";
  execution_policy: "auto" | "manual" | "hybrid";
}

export interface HistoricalRunSpec extends RunSpecBase {
  run_mode: "historical_readonly";
  execution_policy: null;
  source_meta_path: string;
}

export type RunSpec = ExecutableRunSpec | HistoricalRunSpec;

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
  attempt_number?: number;
  attempt_kind?: "execute" | "rework";
  status: AttemptStatus;
  provider_receipt?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
  started_at?: string;
  dispatched_at?: string;
  created_at?: string;
}

export interface AdapterInvocation {
  operation_id: string;
  attempt_id: string;
  attempt_number?: number;
  run_id: string;
  node_run_id: string;
  node_id: string;
  adapter_kind: "mock-local" | "codex" | "hermes" | "openclaw" | "official-api" | "model-api";
  adapter_id: string;
  provider: string;
  capability_requirements: string[];
  input_artifacts: string[];
  resolved_inputs: ResolvedNodeInput[];
  expected_outputs: Array<{
    output_id: string;
    artifact_type: string;
    artifact_spec_ref?: string;
    required: boolean;
  }>;
  runtime_control: AdapterRuntimeControl;
  prompt_path: string;
  output_schema_path: string;
  dispatched_at: string;
}

export type ProviderVerificationStatus = "configured_unverified" | "healthy" | "degraded" | "unavailable";

export interface ProviderProfile {
  id: string;
  provider: string;
  model: string;
  base_url: string;
  api_path?: string;
  credential_ref: string;
  verification_status: ProviderVerificationStatus;
}

export interface AdapterError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface ModelApiRequest {
  invocation: AdapterInvocation;
  profile: ProviderProfile;
  credential: string;
  prompt?: string;
}

export interface ModelApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface NormalizedModelResponse {
  output_text?: string;
  usage?: ModelApiUsage;
  external_session_id?: string;
  raw_receipt_id?: string;
}

export interface ProviderDriver {
  id: string;
  buildRequest(input: ModelApiRequest): { url: string; init: RequestInit };
  parseResponse(input: { response: Response; body: unknown; profile: ProviderProfile }): NormalizedModelResponse;
  mapError(input: { response?: Response; error?: unknown }): AdapterError;
}

export interface AdapterRuntimeControl {
  timeout_ms: number;
  cancellation_token_id: string;
  attempt_workspace: string;
  sandbox: "read-only" | "workspace-write";
}

export type AdapterExecutionMode = "mock-compatible" | "external" | "shell";
export type AdapterCredentialSource = "env" | "keychain" | "workspace-secret";

export interface AdapterCredentialRequirement {
  key: string;
  label: string;
  source: AdapterCredentialSource;
  required: boolean;
  providers?: string[];
}

export interface AdapterManifest {
  id: string;
  kind: AdapterInvocation["adapter_kind"];
  display_name: string;
  version: string;
  status: "draft" | "experimental" | "stable" | "deprecated" | "blocked";
  description: string;
  execution_mode: AdapterExecutionMode;
  capabilities: string[];
  supported_providers: string[];
  default_provider: string;
  required_credentials: AdapterCredentialRequirement[];
  provider_profiles?: ProviderProfile[];
  runtime: {
    local_executor: "mock-runner" | "codex-cli" | "external-api" | "not-implemented";
    can_execute: boolean;
    entrypoint?: string;
  };
}

export interface AdapterCredentialStatus extends AdapterCredentialRequirement {
  configured: boolean;
}

export interface AdapterRegistryEntry extends AdapterManifest {
  credential_status: AdapterCredentialStatus[];
  executable: boolean;
  unavailable_reasons: string[];
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

export interface ProviderReceipt extends Record<string, unknown> {
  provider: string;
  adapter_kind: AdapterInvocation["adapter_kind"];
  adapter_id: string;
  model?: string;
  operation_id: string;
  external_session_id?: string;
  cost?: number;
  latency_ms?: number;
  raw_receipt_id?: string;
  usage?: ModelApiUsage;
}

export interface AdapterResult {
  operation_id: string;
  attempt_id: string;
  node_run_id: string;
  status: AdapterStatus;
  provider_receipt: ProviderReceipt;
  artifact_descriptors: AdapterArtifactDescriptor[];
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
  received_at: string;
}

export interface RetryPolicy {
  max_attempts: number;
  backoff: "fixed" | "exponential";
  initial_delay_ms: number;
  max_delay_ms: number;
  retryable_error_codes: string[];
  attempt_timeout_ms: number;
  total_time_budget_ms: number;
  cost_budget: number;
  manual_confirmation_after?: number;
}

export interface RetryBudgetSnapshot {
  attempts_used: number;
  elapsed_ms: number;
  cost_used: number;
  max_attempts: number;
  total_time_budget_ms: number;
  cost_budget: number;
}

export interface RetryDecision {
  action: "schedule_retry" | "require_attention" | "fail_terminal";
  phase?: "waiting_for_retry" | "due" | "exhausted" | "blocked";
  reason_code: string;
  operation_id: string;
  next_attempt_number?: number;
  delay_ms?: number;
  scheduled_for?: string;
  budget_snapshot: RetryBudgetSnapshot;
}

export interface RetryScheduleRecord {
  operation_id: string;
  node_run_id: string;
  attempt_number: number;
  reason_code: string;
  scheduled_for: string;
  budget_snapshot: RetryBudgetSnapshot;
}

interface RetryStateRecordBase {
  operation_id: string;
  node_run_id: string;
  attempt_id: string;
  attempt_number: number;
  reason_code: string;
  effects_committed: boolean;
  updated_at: string;
}

export type RetryStateRecord =
  | (RetryStateRecordBase & {
      phase: "waiting_for_retry" | "exhausted" | "blocked";
      decision: RetryDecision;
      error: {
        code: string;
        message: string;
        recoverable: boolean;
      };
    })
  | (RetryStateRecordBase & {
      phase: "completed";
      reason_code: "retry_completed";
      effects_committed: true;
      decision?: never;
      error?: never;
    });

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
  artifact_spec_ref?: string;
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
  supersedes_artifact_id?: string;
  rework_of_gate_instance_id?: string;
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

export type ExecutionDecision = "execute" | "wait" | "pause_for_gate" | "blocked" | "skip";

export interface ResolvedNodeInput {
  input_id: string;
  source_kind: "run_input" | "artifact" | "parameter";
  source_ref: string;
  artifact_id?: string;
  artifact_version?: number;
  artifact_hash?: string;
  media_type: string;
  required: boolean;
  resolved_at: string;
}

export interface NodeExecutionDecision {
  node_run_id: string;
  node_id: string;
  decision: ExecutionDecision;
  reason_code: string;
  gate_instance_id?: string;
  required_edge_status: Array<{
    edge_id: string;
    source_node_run_id: string;
    satisfied: boolean;
  }>;
  resolved_inputs: ResolvedNodeInput[];
  eligible_adapter_kinds: Array<"codex" | "model-api">;
  selected_provider_profile_id?: string;
}

export interface ExecutionPlan {
  run_id: string;
  workflow_snapshot_id: string;
  calculated_at: string;
  revision: number;
  decisions: NodeExecutionDecision[];
  ready_node_run_ids: string[];
  paused_node_run_ids: string[];
  blocked_node_run_ids: string[];
  terminal: boolean;
}

export interface ResolveNodeInputsInput {
  runId: string;
  workflow: WorkflowSpec;
  node: NodeSpec;
  nodeRuns: NodeRun[];
  artifacts: ArtifactManifest[];
  calculatedAt: string;
}

export interface CalculateExecutionPlanInput {
  runId: string;
  workflowSnapshotId: string;
  workflow: WorkflowSpec;
  nodeRuns: NodeRun[];
  artifacts: ArtifactManifest[];
  gates: GateInstance[];
  calculatedAt: string;
  revision?: number;
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

export interface CanvasNodeSpecDraft {
  draft_id: string;
  status: "draft" | "ready" | "invalid";
  created_from: "canvas";
  node_spec: NodeSpec;
  validation?: ValidationResult;
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
    node_spec_draft?: CanvasNodeSpecDraft;
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
  mutates_artifact: boolean;
}

export type EvidenceConfidence =
  | "observed_from_event"
  | "observed_from_trace"
  | "observed_from_status"
  | "observed_from_artifact"
  | "inferred"
  | "missing";

export interface HistoricalImportRequest {
  source_run_dir: string;
  workflow_id: string;
  sample_kind: "w24" | "w23";
}

export interface HistoricalGap {
  code: string;
  severity: "warning" | "error";
  message: string;
}

export interface HistoricalNodeEvidence {
  node_id: string;
  status: NodeRunStatus;
  confidence: EvidenceConfidence;
  source_paths: string[];
  updated_at?: string;
}

export interface HistoricalAttemptEvidence extends NodeAttempt {
  confidence: EvidenceConfidence;
  source_paths: string[];
}

export interface HistoricalArtifactEvidence {
  artifact_id: string;
  node_id: string;
  type: string;
  path: string;
  hash: string;
  status: ArtifactManifest["status"];
  review_status: ArtifactReviewStatus;
  producer: string;
  confidence: EvidenceConfidence;
  source_paths: string[];
  created_at?: string;
}

export interface HistoricalGateEvidence {
  gate_spec_id: string;
  target_artifact_id: string;
  status: GateStatus;
  decisions: GateDecision[];
  confidence: EvidenceConfidence;
  source_paths: string[];
}

export interface HistoricalSourceEvent {
  source_path: string;
  source_line: number;
  occurred_at: string;
  event_type: string;
  subject_type: string;
  subject_id: string;
  message: string;
}

export interface HistoricalProjectionInput {
  request: HistoricalImportRequest;
  workflow: WorkflowSpec;
  run_id: string;
  source_fingerprint: string;
  imported_at: string;
  source_files: string[];
  nodes: HistoricalNodeEvidence[];
  attempts: HistoricalAttemptEvidence[];
  artifacts: HistoricalArtifactEvidence[];
  gates: HistoricalGateEvidence[];
  source_events: HistoricalSourceEvent[];
  gaps: HistoricalGap[];
}

export interface HistoricalObjectSource {
  object_type: string;
  source_paths: string[];
  confidence: EvidenceConfidence;
  import_note: string;
}

export interface HistoricalSourceMeta {
  importer: "historical-run-importer";
  importer_version: "0.1.0";
  mode: "historical_readonly";
  source_run_dir: string;
  source_fingerprint: string;
  imported_at: string;
  objects: Record<string, HistoricalObjectSource>;
  gaps: HistoricalGap[];
}

export interface HistoricalTraceEvent extends TraceEvent {
  source?: {
    path: string;
    line: number;
    event_type: string;
    confidence: "observed_from_event";
  };
}

export interface HistoricalRunProjection {
  runSpec: HistoricalRunSpec;
  workflowSnapshot: WorkflowSnapshot;
  nodeRuns: NodeRun[];
  attempts: NodeAttempt[];
  artifacts: ArtifactManifest[];
  gates: GateInstance[];
  events: HistoricalTraceEvent[];
  attention: AttentionItem[];
  sourceMeta: HistoricalSourceMeta;
  manifest: Record<string, string>;
}

export interface HistoricalImportPreview {
  import_id: string;
  run_id: string;
  source_fingerprint: string;
  valid: boolean;
  files: Array<{ relative_path: string; exists: boolean; size?: number }>;
  gaps: HistoricalGap[];
  projected_counts: { nodes: number; artifacts: number; gates: number; events: number; attention: number };
}
