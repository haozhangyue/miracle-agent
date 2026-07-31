import { describe, expect, it } from "vitest";
import { decideRetry, retryPolicySchema } from "../src";

const basePolicy = {
  max_attempts: 3,
  backoff: "fixed" as const,
  initial_delay_ms: 1_000,
  max_delay_ms: 8_000,
  retryable_error_codes: ["rate_limit", "network_error"],
  attempt_timeout_ms: 30_000,
  total_time_budget_ms: 60_000,
  cost_budget: 5
};

const rateLimitError = {
  code: "rate_limit",
  message: "Provider asked the caller to retry later.",
  recoverable: true
};

function failedAttempt(input: {
  attemptNumber: number;
  createdAt: string;
  dispatchedAt?: string;
  cost?: number;
  operationId?: string;
}) {
  return {
    attempt_id: `attempt_op_retry_${input.attemptNumber}`,
    node_run_id: "nr_retry",
    operation_id: input.operationId ?? "op_retry",
    attempt_number: input.attemptNumber,
    attempt_kind: "execute" as const,
    status: "failed" as const,
    provider_receipt: input.cost === undefined ? {} : { cost: input.cost },
    error: rateLimitError,
    started_at: input.dispatchedAt ?? input.createdAt,
    dispatched_at: input.dispatchedAt ?? input.createdAt,
    created_at: input.createdAt
  };
}

describe("RetryPolicy", () => {
  it("reuses the operation and creates a later attempt for a retryable error", () => {
    const attempts = [failedAttempt({ attemptNumber: 1, createdAt: "2026-07-31T00:00:00.000Z", cost: 0.25 })];

    expect(decideRetry({
      policy: basePolicy,
      error: rateLimitError,
      attempts,
      now: "2026-07-31T00:00:01.000Z"
    })).toMatchObject({
      action: "schedule_retry",
      reason_code: "retryable_error",
      operation_id: "op_retry",
      next_attempt_number: 2,
      delay_ms: 1_000,
      scheduled_for: "2026-07-31T00:00:02.000Z",
      budget_snapshot: expect.objectContaining({ cost_budget: 5 })
    });
  });

  it("uses capped exponential backoff from the next attempt number", () => {
    const attempts = [
      failedAttempt({ attemptNumber: 1, createdAt: "2026-07-31T00:00:00.000Z" }),
      failedAttempt({ attemptNumber: 2, createdAt: "2026-07-31T00:00:01.000Z" })
    ];

    expect(decideRetry({
      policy: { ...basePolicy, backoff: "exponential" },
      error: rateLimitError,
      attempts,
      now: "2026-07-31T00:00:02.000Z"
    })).toMatchObject({
      action: "schedule_retry",
      next_attempt_number: 3,
      delay_ms: 2_000,
      scheduled_for: "2026-07-31T00:00:04.000Z"
    });
  });

  it.each([
    {
      reason: "attempt_budget_exhausted",
      policy: { ...basePolicy, max_attempts: 1 },
      attempts: [failedAttempt({ attemptNumber: 1, createdAt: "2026-07-31T00:00:00.000Z" })],
      now: "2026-07-31T00:00:01.000Z"
    },
    {
      reason: "time_budget_exhausted",
      policy: { ...basePolicy, total_time_budget_ms: 1_500 },
      attempts: [failedAttempt({ attemptNumber: 1, createdAt: "2026-07-31T00:00:00.000Z" })],
      now: "2026-07-31T00:00:01.000Z"
    },
    {
      reason: "cost_budget_exhausted",
      policy: { ...basePolicy, cost_budget: 1 },
      attempts: [failedAttempt({ attemptNumber: 1, createdAt: "2026-07-31T00:00:00.000Z", cost: 1 })],
      now: "2026-07-31T00:00:01.000Z"
    }
  ])("pauses instead of retrying when $reason", ({ reason, policy, attempts, now }) => {
    expect(decideRetry({ policy, error: rateLimitError, attempts, now })).toMatchObject({
      action: "require_attention",
      reason_code: reason,
      operation_id: "op_retry"
    });
  });

  it("does not retry errors outside the explicit retryable classification", () => {
    const attempts = [failedAttempt({ attemptNumber: 1, createdAt: "2026-07-31T00:00:00.000Z" })];

    expect(decideRetry({
      policy: basePolicy,
      error: { code: "permission_denied", message: "No access.", recoverable: true },
      attempts,
      now: "2026-07-31T00:00:01.000Z"
    })).toMatchObject({
      action: "fail_terminal",
      reason_code: "error_not_retryable",
      operation_id: "op_retry"
    });
  });

  it("measures total time from the first real dispatch rather than the received result", () => {
    const attempts = [failedAttempt({
      attemptNumber: 1,
      dispatchedAt: "2026-07-31T00:00:00.000Z",
      createdAt: "2026-07-31T00:00:59.000Z"
    })];

    expect(decideRetry({
      policy: { ...basePolicy, total_time_budget_ms: 30_000 },
      error: rateLimitError,
      attempts,
      now: "2026-07-31T00:01:00.000Z"
    })).toMatchObject({
      action: "require_attention",
      reason_code: "time_budget_exhausted",
      budget_snapshot: {
        elapsed_ms: 60_000,
        cost_budget: 5
      }
    });
  });

  it("does not charge backoff twice when consuming an existing schedule", () => {
    const policy = { ...basePolicy, total_time_budget_ms: 1_500 };
    const attempts = [failedAttempt({
      attemptNumber: 1,
      dispatchedAt: "2026-07-31T00:00:00.000Z",
      createdAt: "2026-07-31T00:00:00.000Z"
    })];

    expect(decideRetry({
      policy,
      error: rateLimitError,
      attempts,
      now: "2026-07-31T00:00:00.000Z"
    })).toMatchObject({
      action: "schedule_retry",
      next_attempt_number: 2,
      scheduled_for: "2026-07-31T00:00:01.000Z"
    });
    expect(decideRetry({
      policy,
      error: rateLimitError,
      attempts,
      now: "2026-07-31T00:00:01.000Z",
      mode: "consume"
    })).toMatchObject({
      action: "schedule_retry",
      next_attempt_number: 2
    });
    expect(decideRetry({
      policy,
      error: rateLimitError,
      attempts,
      now: "2026-07-31T00:00:01.501Z",
      mode: "consume"
    })).toMatchObject({
      action: "require_attention",
      reason_code: "time_budget_exhausted"
    });
  });

  it("rejects a RetryPolicy without a finite cost budget", () => {
    const { cost_budget: _costBudget, ...withoutCostBudget } = basePolicy;
    expect(() => retryPolicySchema.parse(withoutCostBudget)).toThrow();
    expect(() => retryPolicySchema.parse({ ...basePolicy, cost_budget: Number.NaN })).toThrow();
    expect(() => retryPolicySchema.parse({ ...basePolicy, cost_budget: Number.POSITIVE_INFINITY })).toThrow();
  });

  it.each([
    { ...basePolicy, max_attempts: 4 },
    { ...basePolicy, max_attempts: Number.POSITIVE_INFINITY },
    { ...basePolicy, initial_delay_ms: -1 },
    { ...basePolicy, max_delay_ms: Number.NaN },
    { ...basePolicy, attempt_timeout_ms: -1 },
    { ...basePolicy, total_time_budget_ms: Number.POSITIVE_INFINITY },
    { ...basePolicy, cost_budget: -1 }
  ])("rejects negative, non-finite, or unbounded policy values", (policy) => {
    expect(() => retryPolicySchema.parse(policy)).toThrow();
  });
});
