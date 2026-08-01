type Attempt = Record<string, any>;
type RoutingDecision = Record<string, any>;

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function estimatedCost(value: unknown) {
  if (typeof value === "number") return number(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  return number((value as Record<string, unknown>).max);
}

function receiptFor(attempt: Attempt) {
  return attempt.provider_receipt && typeof attempt.provider_receipt === "object" ? attempt.provider_receipt : attempt;
}

export function runtimeBadge(attempt: Attempt) {
  const receipt = receiptFor(attempt);
  const adapterKind = receipt.adapter_kind ?? attempt.adapter_kind;
  return {
    runtime: adapterKind === "model-api" ? "Model API" : adapterKind === "codex" ? "Codex" : "Local Adapter",
    provider_profile: receipt.provider_profile_id ?? attempt.provider_profile_id ?? "-",
    model: receipt.model ?? attempt.model ?? "-"
  };
}

export function costSummary(attempts: Attempt[]) {
  const usage = attempts.reduce((total, attempt) => {
    const current = receiptFor(attempt).usage ?? {};
    const prompt = number(current.prompt_tokens ?? current.input_tokens);
    const completion = number(current.completion_tokens ?? current.output_tokens);
    total.prompt_tokens += prompt;
    total.completion_tokens += completion;
    total.total_tokens += number(current.total_tokens) || prompt + completion;
    return total;
  }, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  return {
    estimated: attempts.reduce((total, attempt) => total + estimatedCost(receiptFor(attempt).estimated_cost ?? attempt.estimated_cost), 0),
    actual: attempts.reduce((total, attempt) => total + number(receiptFor(attempt).cost ?? attempt.actual_cost), 0),
    currency: "USD",
    usage
  };
}

export function buildAttemptTimeline(attempts: Attempt[], routingDecisions: RoutingDecision[] = []) {
  const groups = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    const group = groups.get(attempt.operation_id) ?? [];
    group.push(attempt);
    groups.set(attempt.operation_id, group);
  }
  return Array.from(groups.entries()).map(([operation_id, operationAttempts]) => {
    const sortedAttempts = [...operationAttempts].sort((left, right) => number(left.attempt_number || 1) - number(right.attempt_number || 1));
    const routing = routingDecisions
      .filter((decision) => decision.operation_id === operation_id)
      .sort((left, right) => number(left.target_attempt_number) - number(right.target_attempt_number));
    const fallbackDecision = routing.at(-1);
    const first = sortedAttempts[0];
    const last = sortedAttempts.at(-1);
    const firstReceipt = first ? receiptFor(first) : {};
    const lastReceipt = last ? receiptFor(last) : {};
    return {
      operation_id,
      node_run_id: first?.node_run_id,
      attempts: sortedAttempts.map((attempt) => {
        const receipt = receiptFor(attempt);
        const rawEstimatedCost = receipt.estimated_cost ?? attempt.estimated_cost;
        return {
          attempt_id: attempt.attempt_id,
          attempt_number: attempt.attempt_number ?? 1,
          status: attempt.status,
          status_label: `NodeAttempt · ${attempt.status}`,
          adapter_kind: receipt.adapter_kind ?? attempt.adapter_kind,
          adapter_id: receipt.adapter_id ?? attempt.adapter_id,
          provider: receipt.provider ?? attempt.provider ?? "-",
          provider_profile: receipt.provider_profile_id ?? attempt.provider_profile_id ?? "-",
          model: receipt.model ?? "-",
          runtime: runtimeBadge(attempt).runtime,
          usage: receipt.usage,
          estimated_cost: rawEstimatedCost === undefined ? undefined : estimatedCost(rawEstimatedCost),
          actual_cost: receipt.cost ?? attempt.actual_cost,
          error_code: attempt.error?.code,
          created_at: attempt.created_at ?? attempt.dispatched_at
        };
      }),
      fallback: fallbackDecision ? {
        decision_id: fallbackDecision.decision_id,
        from_provider: firstReceipt.provider ?? "-",
        to_provider: lastReceipt.provider ?? fallbackDecision.selected_provider ?? "-",
        target_provider_profile_id: fallbackDecision.selected_provider_profile_id,
        current_adapter_kind: fallbackDecision.current_adapter_kind,
        selected_adapter_kind: fallbackDecision.selected_adapter_kind,
        reason_code: fallbackDecision.reason_code ?? fallbackDecision.reason_codes?.[0],
        requires_confirmation: fallbackDecision.requires_confirmation === true
      } : undefined,
      cost: costSummary(sortedAttempts)
    };
  });
}

export function recoveryActionLabel(action: string) {
  const labels: Record<string, string> = {
    inspect_retry_budget: "查看 retry budget",
    stop_auto_retry: "停止自动重试",
    confirm_fallback: "确认 fallback",
    open_credential_guide: "打开凭证配置说明",
    return_to_run: "返回 Run"
  };
  return labels[action];
}

export function availableRecoveryActions(input: {
  historical: boolean;
  hasRetrySchedule: boolean;
  hasFallback: boolean;
  credentialIssue: boolean;
}) {
  const actions: string[] = [];
  if (!input.historical && input.hasRetrySchedule) actions.push("inspect_retry_budget", "stop_auto_retry");
  if (!input.historical && input.hasFallback) actions.push("confirm_fallback");
  if (input.credentialIssue) actions.push("open_credential_guide");
  actions.push("return_to_run");
  return actions;
}
