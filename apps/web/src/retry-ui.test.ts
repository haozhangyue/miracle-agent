import { describe, expect, it } from "vitest";
import { canExecuteNode, retryBudgetLabel } from "./retry-ui";

describe("retry UI projection", () => {
  it("allows a due retry but keeps waiting retry and historical runs disabled", () => {
    expect(canExecuteNode({ status: "failed", retryPhase: "due", historical: false })).toBe(true);
    expect(canExecuteNode({ status: "failed", retryPhase: "waiting_for_retry", historical: false })).toBe(false);
    expect(canExecuteNode({ status: "failed", retryPhase: "due", historical: true })).toBe(false);
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
