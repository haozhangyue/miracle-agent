import { adapterResultSchema } from "./schemas";
import type { AdapterResult, AttemptStatus, NodeRunStatus } from "./types";

export type AdapterOutcomeCategory = "succeeded" | "retryable_failure" | "blocked" | "terminal";

export interface AdapterOutcomeClassification {
  category: AdapterOutcomeCategory;
  attempt_status: AttemptStatus;
  node_run_status: Extract<NodeRunStatus, "done" | "failed" | "blocked">;
  normalized_error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
  retry_eligible: boolean;
  attention_required: boolean;
  reason_code: string;
}

const retryCodeAliases = new Map<string, string>([
  ["process_exit_nonzero", "adapter_process_error"],
  ["process_spawn_failed", "adapter_process_error"],
  ["invalid_adapter_output", "adapter_output_invalid"]
]);

const blockedCodes = new Set([
  "credential_missing",
  "authentication_failed",
  "permission_denied",
  "required_input_missing",
  "input_missing",
  "artifact_missing",
  "artifact_reference_invalid"
]);

function classifiedError(result: AdapterResult, code: string, recoverable: boolean) {
  return {
    code,
    message: result.error?.message ?? code,
    recoverable
  };
}

export function classifyAdapterOutcome(input: AdapterResult): AdapterOutcomeClassification {
  const result = adapterResultSchema.parse(input);
  if (result.status === "succeeded") {
    return {
      category: "succeeded",
      attempt_status: "succeeded",
      node_run_status: "done",
      retry_eligible: false,
      attention_required: false,
      reason_code: "adapter_succeeded"
    };
  }

  const errorCode = result.error?.code ?? `adapter_${result.status}`;
  if (result.status === "failed" && blockedCodes.has(errorCode)) {
    return {
      category: "blocked",
      attempt_status: "failed",
      node_run_status: "blocked",
      normalized_error: classifiedError(result, errorCode, false),
      retry_eligible: false,
      attention_required: true,
      reason_code: errorCode
    };
  }

  const retryAlias = result.status === "failed" ? retryCodeAliases.get(errorCode) : undefined;
  if (retryAlias) {
    return {
      category: "retryable_failure",
      attempt_status: "failed",
      node_run_status: "failed",
      normalized_error: classifiedError(result, retryAlias, true),
      retry_eligible: true,
      attention_required: false,
      reason_code: retryAlias
    };
  }

  if (result.status === "timed_out" && errorCode === "process_timeout") {
    return {
      category: "retryable_failure",
      attempt_status: "timed_out",
      node_run_status: "failed",
      normalized_error: classifiedError(result, "adapter_timeout", true),
      retry_eligible: true,
      attention_required: false,
      reason_code: "adapter_timeout"
    };
  }

  if (result.status === "timed_out" || errorCode === "process_timeout") {
    return {
      category: "terminal",
      attempt_status: result.status,
      node_run_status: "failed",
      normalized_error: classifiedError(result, errorCode, false),
      retry_eligible: false,
      attention_required: true,
      reason_code: "adapter_timeout_unconfirmed"
    };
  }

  if (result.status === "failed" && result.error?.recoverable) {
    return {
      category: "retryable_failure",
      attempt_status: "failed",
      node_run_status: "failed",
      normalized_error: classifiedError(result, errorCode, true),
      retry_eligible: true,
      attention_required: false,
      reason_code: errorCode
    };
  }

  return {
    category: "terminal",
    attempt_status: result.status,
    node_run_status: "failed",
    normalized_error: classifiedError(result, errorCode, false),
    retry_eligible: false,
    attention_required: result.status === "unknown",
    reason_code: errorCode
  };
}
