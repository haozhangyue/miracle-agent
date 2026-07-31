import { describe, expect, it } from "vitest";
import { classifyAdapterOutcome, createNodeAttemptFromAdapterResult, type AdapterResult } from "../src";

function result(input: {
  status: AdapterResult["status"];
  code?: string;
  recoverable?: boolean;
}): AdapterResult {
  return {
    operation_id: "op_classifier",
    attempt_id: "attempt_op_classifier",
    node_run_id: "nr_classifier",
    status: input.status,
    provider_receipt: {
      provider: "codex-local",
      adapter_kind: "codex",
      adapter_id: "codex-cli-real",
      operation_id: "op_classifier"
    },
    artifact_descriptors: [],
    ...(input.code ? {
      error: {
        code: input.code,
        message: input.code,
        recoverable: input.recoverable ?? true
      }
    } : {}),
    received_at: "2026-07-31T00:00:01.000Z"
  };
}

describe("Adapter outcome classifier", () => {
  it.each([
    ["process_exit_nonzero", "adapter_process_error"],
    ["process_spawn_failed", "adapter_process_error"],
    ["invalid_adapter_output", "adapter_output_invalid"],
    ["provider_rate_limited", "rate_limit"],
    ["provider_unavailable", "provider_temporary_5xx"],
    ["provider_network_error", "network_error"],
    ["provider_timeout", "adapter_timeout"]
  ] as const)("normalizes failed adapter error %s as configurable retry error %s", (code, normalizedCode) => {
    const adapterResult = result({ status: "failed", code });
    expect(classifyAdapterOutcome(adapterResult)).toMatchObject({
      category: "retryable_failure",
      normalized_error: { code: normalizedCode, recoverable: true },
      attempt_status: "failed",
      node_run_status: "failed",
      retry_eligible: true,
      attention_required: false
    });
    expect(createNodeAttemptFromAdapterResult(adapterResult).error?.code).toBe(normalizedCode);
  });

  it("normalizes a confirmed process timeout and rejects status/code mismatches", () => {
    expect(classifyAdapterOutcome(result({ status: "timed_out", code: "process_timeout" }))).toMatchObject({
      category: "retryable_failure",
      normalized_error: { code: "adapter_timeout", recoverable: true },
      attempt_status: "timed_out",
      node_run_status: "failed",
      retry_eligible: true
    });
    expect(classifyAdapterOutcome(result({ status: "failed", code: "process_timeout" }))).toMatchObject({
      category: "terminal",
      retry_eligible: false
    });
    expect(classifyAdapterOutcome(result({ status: "timed_out", code: "process_exit_nonzero" }))).toMatchObject({
      category: "terminal",
      retry_eligible: false
    });
  });

  it.each([
    ["cancelled", "operation_cancelled"],
    ["aborted", "adapter_output_too_large"],
    ["unknown", "external_state_unknown"]
  ] as const)("never retries %s AdapterResult", (status, code) => {
    expect(classifyAdapterOutcome(result({ status, code }))).toMatchObject({
      category: "terminal",
      attempt_status: status,
      node_run_status: "failed",
      retry_eligible: false
    });
  });

  it.each([
    "credential_missing",
    "authentication_failed",
    "permission_denied",
    "required_input_missing",
    "artifact_missing"
  ])("classifies %s as blocked with Attention instead of retry", (code) => {
    expect(classifyAdapterOutcome(result({ status: "failed", code }))).toMatchObject({
      category: "blocked",
      normalized_error: { code, recoverable: false },
      attempt_status: "failed",
      node_run_status: "blocked",
      retry_eligible: false,
      attention_required: true
    });
  });
});
