export function canExecuteNode(input: {
  status: string;
  retryPhase?: string;
  historical: boolean;
}) {
  if (input.historical) return false;
  return ["queued", "running"].includes(input.status) || input.retryPhase === "due";
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
