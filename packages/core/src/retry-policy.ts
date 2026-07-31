import { retryPolicySchema } from "./schemas";
import type { NodeAttempt, NodeSpec, RetryBudgetSnapshot, RetryDecision, RetryPolicy } from "./types";

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  max_attempts: 3,
  backoff: "fixed",
  initial_delay_ms: 1_000,
  max_delay_ms: 30_000,
  retryable_error_codes: [
    "network_error",
    "rate_limit",
    "provider_temporary_5xx",
    "adapter_process_error",
    "adapter_timeout",
    "adapter_output_invalid",
    "mock_failure"
  ],
  attempt_timeout_ms: 1_800_000,
  total_time_budget_ms: 3_600_000,
  cost_budget: 5
};

export function resolveNodeRetryPolicy(node: NodeSpec): RetryPolicy {
  if (node.failure_policy.retry_policy) return retryPolicySchema.parse(node.failure_policy.retry_policy);
  return retryPolicySchema.parse({
    ...DEFAULT_RETRY_POLICY,
    max_attempts: Math.min(3, Math.max(1, node.failure_policy.retry + 1)),
    cost_budget: node.failure_policy.cost_budget ?? DEFAULT_RETRY_POLICY.cost_budget
  });
}

type RetryError = {
  code: string;
  message: string;
  recoverable: boolean;
};

function timestamp(value: string | undefined, field: string) {
  const parsed = Date.parse(value ?? "");
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a valid timestamp`);
  return parsed;
}

function receiptCost(attempt: NodeAttempt) {
  const cost = attempt.provider_receipt?.cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : 0;
}

function operationDispatchTimestamp(operationId: string) {
  const match = operationId.match(/_(\d+)$/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function attemptDispatchTimestamp(attempt: NodeAttempt) {
  const explicit = attempt.dispatched_at ?? attempt.started_at;
  if (explicit) return timestamp(explicit, "attempt.dispatched_at");
  const operationTimestamp = operationDispatchTimestamp(attempt.operation_id);
  if (operationTimestamp !== undefined) return operationTimestamp;
  throw new Error("Retry attempts require a real dispatch timestamp");
}

function backoffDelay(policy: RetryPolicy, nextAttemptNumber: number) {
  if (policy.backoff === "fixed") return Math.min(policy.initial_delay_ms, policy.max_delay_ms);
  const exponent = Math.max(0, nextAttemptNumber - 2);
  return Math.min(policy.initial_delay_ms * (2 ** exponent), policy.max_delay_ms);
}

function decision(input: {
  action: RetryDecision["action"];
  reasonCode: string;
  operationId: string;
  budgetSnapshot: RetryBudgetSnapshot;
}): RetryDecision {
  return {
    action: input.action,
    reason_code: input.reasonCode,
    operation_id: input.operationId,
    budget_snapshot: input.budgetSnapshot
  };
}

export function decideRetry(input: {
  policy: RetryPolicy;
  error: RetryError;
  attempts: NodeAttempt[];
  now: string;
  mode?: "schedule" | "consume";
}): RetryDecision {
  const policy = retryPolicySchema.parse(input.policy);
  const nowMs = timestamp(input.now, "now");
  if (input.attempts.length === 0) throw new Error("decideRetry requires an explicit failed NodeAttempt");
  const operationId = input.attempts[0]?.operation_id;
  if (!operationId || input.attempts.some((attempt) => attempt.operation_id !== operationId)) {
    throw new Error("Retry attempts must belong to one operation_id");
  }
  const latestAttempt = input.attempts.reduce((latest, attempt) => {
    const latestNumber = latest.attempt_number ?? 1;
    const attemptNumber = attempt.attempt_number ?? 1;
    return attemptNumber > latestNumber ? attempt : latest;
  });
  if (!["failed", "timed_out"].includes(latestAttempt.status)) {
    throw new Error("Only an explicit failed or confirmed timed_out NodeAttempt may be retried");
  }

  const attemptsUsed = Math.max(...input.attempts.map((attempt) => attempt.attempt_number ?? 1));
  const firstAttemptAt = Math.min(...input.attempts.map(attemptDispatchTimestamp));
  const elapsedMs = Math.max(0, nowMs - firstAttemptAt);
  const costUsed = input.attempts.reduce((total, attempt) => total + receiptCost(attempt), 0);
  const budgetSnapshot: RetryBudgetSnapshot = {
    attempts_used: attemptsUsed,
    elapsed_ms: elapsedMs,
    cost_used: costUsed,
    max_attempts: policy.max_attempts,
    total_time_budget_ms: policy.total_time_budget_ms,
    cost_budget: policy.cost_budget
  };

  if (!input.error.recoverable || !policy.retryable_error_codes.includes(input.error.code)) {
    return decision({
      action: "fail_terminal",
      reasonCode: "error_not_retryable",
      operationId,
      budgetSnapshot
    });
  }
  if (attemptsUsed >= policy.max_attempts) {
    return decision({
      action: "require_attention",
      reasonCode: "attempt_budget_exhausted",
      operationId,
      budgetSnapshot
    });
  }
  if (costUsed >= policy.cost_budget) {
    return decision({
      action: "require_attention",
      reasonCode: "cost_budget_exhausted",
      operationId,
      budgetSnapshot
    });
  }
  if (policy.manual_confirmation_after !== undefined && attemptsUsed >= policy.manual_confirmation_after) {
    return decision({
      action: "require_attention",
      reasonCode: "manual_confirmation_required",
      operationId,
      budgetSnapshot
    });
  }

  const nextAttemptNumber = attemptsUsed + 1;
  const delayMs = backoffDelay(policy, nextAttemptNumber);
  const projectedElapsedMs = input.mode === "consume" ? elapsedMs : elapsedMs + delayMs;
  const timeBudgetExhausted = input.mode === "consume"
    ? projectedElapsedMs >= policy.total_time_budget_ms
    : projectedElapsedMs > policy.total_time_budget_ms;
  if (timeBudgetExhausted) {
    return decision({
      action: "require_attention",
      reasonCode: "time_budget_exhausted",
      operationId,
      budgetSnapshot
    });
  }
  return {
    action: "schedule_retry",
    reason_code: "retryable_error",
    operation_id: operationId,
    next_attempt_number: nextAttemptNumber,
    delay_ms: delayMs,
    scheduled_for: new Date(nowMs + delayMs).toISOString(),
    budget_snapshot: budgetSnapshot
  };
}
