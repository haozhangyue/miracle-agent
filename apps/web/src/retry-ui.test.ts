import { describe, expect, it } from "vitest";
import { canExecuteNode, retryBudgetLabel } from "./retry-ui";

describe("retry UI projection", () => {
  it("allows a due retry but keeps waiting retry and historical runs disabled", () => {
    const dueAndExecutable = { status: "failed", retryPhase: "due", executionDecision: "execute", historical: false };
    const dueButBlocked = { status: "failed", retryPhase: "due", executionDecision: "blocked", historical: false };
    expect(canExecuteNode(dueAndExecutable)).toBe(true);
    expect(canExecuteNode(dueButBlocked)).toBe(false);
    expect(canExecuteNode({ status: "failed", retryPhase: "waiting_for_retry", historical: false })).toBe(false);
    expect(canExecuteNode({ ...dueAndExecutable, historical: true })).toBe(false);
  });

  it("shows used and limit for attempt, time, and cost budgets", () => {
    expect(retryBudgetLabel({
      attempts_used: 1,
      max_attempts: 3,
      elapsed_ms: 1_250,
      total_time_budget_ms: 5_000,
      cost_used: 0.5,
      cost_budget: 5
    })).toBe("attempts 1 / 3 · time 1250 / 5000 ms · cost 0.5 / 5");
  });
});
