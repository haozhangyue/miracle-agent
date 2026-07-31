export function canExecuteNode(input: {
  status: string;
  retryPhase?: string;
  executionDecision?: string;
  historical: boolean;
}) {
  if (input.historical) return false;
  if (input.retryPhase === "due") return input.executionDecision === "execute";
  return ["queued", "running"].includes(input.status)
    && (input.executionDecision === undefined || input.executionDecision === "execute");
}

export function retryBudgetLabel(snapshot?: {
  attempts_used?: number;
  max_attempts?: number;
  elapsed_ms?: number;
  total_time_budget_ms?: number;
  cost_used?: number;
  cost_budget?: number;
}) {
  const value = (item: number | undefined) => item ?? "-";
  return [
    `attempts ${value(snapshot?.attempts_used)} / ${value(snapshot?.max_attempts)}`,
    `time ${value(snapshot?.elapsed_ms)} / ${value(snapshot?.total_time_budget_ms)} ms`,
    `cost ${value(snapshot?.cost_used)} / ${value(snapshot?.cost_budget)}`
  ].join(" · ");
}
