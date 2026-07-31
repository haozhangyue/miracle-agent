import { describe, expect, it } from "vitest";
import { availableRecoveryActions, buildAttemptTimeline, costSummary, recoveryActionLabel, runtimeBadge } from "./run-observability";

describe("run observability view model", () => {
  const attempts = [
    {
      attempt_id: "attempt_op_1",
      node_run_id: "nr_1",
      operation_id: "op_1",
      attempt_number: 1,
      status: "failed",
      error: { code: "rate_limit", message: "429", recoverable: true },
      provider_receipt: {
        adapter_kind: "model-api",
        adapter_id: "model-api-adapter",
        provider: "deepseek",
        provider_profile_id: "deepseek-default",
        model: "deepseek-chat",
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        estimated_cost: 0.01,
        cost: 0.012
      }
    },
    {
      attempt_id: "attempt_op_1_2",
      node_run_id: "nr_1",
      operation_id: "op_1",
      attempt_number: 2,
      status: "succeeded",
      provider_receipt: {
        adapter_kind: "model-api",
        adapter_id: "model-api-adapter",
        provider: "kimi",
        provider_profile_id: "kimi-default",
        model: "moonshot-v1-8k",
        usage: { prompt_tokens: 13, completion_tokens: 9, total_tokens: 22 },
        estimated_cost: 0.02,
        cost: 0.018
      }
    }
  ];

  it("groups retries and fallbacks under one operation without hiding attempts", () => {
    expect(buildAttemptTimeline(attempts, [{
      decision_id: "route_1",
      operation_id: "op_1",
      node_run_id: "nr_1",
      target_attempt_number: 2,
      selected_provider_profile_id: "kimi-default",
      selected_adapter_kind: "model-api",
      current_adapter_kind: "model-api",
      reason_code: "provider_rate_limit",
      requires_confirmation: false
    }])).toEqual([
      expect.objectContaining({
        operation_id: "op_1",
        attempts: [
          expect.objectContaining({ provider: "deepseek", status: "failed", status_label: "NodeAttempt · failed" }),
          expect.objectContaining({ provider: "kimi", status: "succeeded", status_label: "NodeAttempt · succeeded" })
        ],
        fallback: expect.objectContaining({ from_provider: "deepseek", to_provider: "kimi", reason_code: "provider_rate_limit" })
      })
    ]);
  });

  it("projects runtime, usage, and estimated versus actual cost", () => {
    expect(runtimeBadge(attempts[1])).toEqual({ runtime: "Model API", provider_profile: "kimi-default", model: "moonshot-v1-8k" });
    expect(costSummary(attempts)).toEqual({ estimated: 0.03, actual: 0.03, currency: "USD", usage: { prompt_tokens: 25, completion_tokens: 17, total_tokens: 42 } });
  });

  it("uses the upper bound when Sidecar exposes an estimated cost range", () => {
    expect(costSummary([{
      provider_receipt: {
        estimated_cost: { currency: "USD", min: 0.01, max: 0.02 }
      }
    }])).toMatchObject({ estimated: 0.02 });
  });

  it("counts a targeted routing estimate once across a fallback operation", () => {
    expect(costSummary([
      { attempt_number: 1 },
      { attempt_number: 2, estimated_cost: { currency: "USD", min: 0.01, max: 0.02 } }
    ])).toMatchObject({ estimated: 0.02 });
  });

  it("only labels recovery actions backed by an available API", () => {
    expect(recoveryActionLabel("inspect_retry_budget")).toBe("查看 retry budget");
    expect(recoveryActionLabel("stop_auto_retry")).toBe("停止自动重试");
    expect(recoveryActionLabel("confirm_fallback")).toBe("确认 fallback");
    expect(recoveryActionLabel("open_credential_guide")).toBe("打开凭证配置说明");
    expect(recoveryActionLabel("restart_provider")).toBeUndefined();
  });

  it("hides recovery mutations for historical runs while retaining read-only guidance", () => {
    expect(availableRecoveryActions({
      historical: true,
      hasRetrySchedule: true,
      hasFallback: true,
      credentialIssue: true
    })).toEqual(["open_credential_guide", "return_to_run"]);
  });
});
