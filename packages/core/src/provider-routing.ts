import { providerRoutingInputSchema } from "./schemas";
import type { ProviderRoutingCandidate, ProviderRoutingDecision, ProviderRoutingInput } from "./types";

const modelApiFallbackErrors = new Set(["rate_limit", "provider_temporary_5xx", "network_error", "adapter_timeout"]);
const codexCrossKindFallbackErrors = new Set(["adapter_process_error", "network_error", "adapter_timeout"]);

function rejectionReason(input: ProviderRoutingInput, candidate: ProviderRoutingCandidate) {
  if (!input.allowed_adapter_kinds.includes(candidate.adapter_kind)) return "adapter_kind_not_allowed";
  if (input.failure) {
    if (input.current_adapter_kind === "model-api" && candidate.adapter_kind !== "model-api") {
      return "automatic_fallback_kind_mismatch";
    }
    if (input.current_adapter_kind === "codex" && candidate.adapter_kind !== "model-api") {
      return "codex_fallback_requires_model_api_target";
    }
  }
  if (!input.capability_requirements.every((capability) => candidate.capabilities.includes(capability))) return "capability_incomplete";
  if (!candidate.executable) return "adapter_not_executable";
  if (!candidate.credential_available) return "credential_missing";
  if (candidate.health_status !== "healthy") return "provider_not_healthy";
  if (input.failed_profile_id === candidate.id) return "failed_profile_excluded";
  if (!input.failed_profile_id && input.failed_provider_id === candidate.provider) return "failed_provider_profile_unknown";
  if (candidate.estimated_cost && candidate.estimated_cost.max > input.budget.cost_budget - input.budget.cost_used) {
    return "estimated_cost_exceeds_budget";
  }
  return undefined;
}

function compareCandidates(left: ProviderRoutingCandidate, right: ProviderRoutingCandidate) {
  return left.user_priority - right.user_priority
    || left.cost_tier - right.cost_tier
    || left.id.localeCompare(right.id);
}

export function selectProviderRoute(input: ProviderRoutingInput): ProviderRoutingDecision {
  input = providerRoutingInputSchema.parse(input);
  const candidate_profile_ids = input.profiles.map((profile) => profile.id).sort((left, right) => left.localeCompare(right));
  const candidateReasons = new Map(input.profiles.map((candidate) => [candidate.id, rejectionReason(input, candidate)]));
  const rejected = (fallbackReason?: string) => input.profiles.map((candidate) => ({
    profile_id: candidate.id,
    reason_code: candidateReasons.get(candidate.id) ?? fallbackReason ?? "no_eligible_provider_profile"
  }));
  const base = {
    operation_id: input.operation_id,
    candidate_profile_ids,
    reason_codes: [] as string[],
    requires_confirmation: false,
    decided_at: input.decided_at
  };

  if (input.failure && !input.current_adapter_kind) {
    return {
      ...base,
      rejected_candidates: rejected("fallback_current_adapter_kind_missing"),
      reason_codes: ["fallback_current_adapter_kind_missing"]
    };
  }
  const permittedFallbackErrors = input.current_adapter_kind === "codex"
    ? codexCrossKindFallbackErrors
    : modelApiFallbackErrors;
  if (input.failure && !permittedFallbackErrors.has(input.failure.error_code)) {
    return { ...base, rejected_candidates: rejected("fallback_error_not_recoverable"), reason_codes: ["fallback_error_not_recoverable"] };
  }
  if (input.failure && input.failure.status !== "failed" && input.failure.status !== "timed_out") {
    return { ...base, rejected_candidates: rejected("fallback_error_not_recoverable"), reason_codes: ["fallback_error_not_recoverable"] };
  }
  if (input.budget.attempts_used >= input.budget.max_attempts) {
    return { ...base, rejected_candidates: rejected("attempt_budget_exhausted"), reason_codes: ["attempt_budget_exhausted"] };
  }
  if (input.budget.elapsed_ms >= input.budget.total_time_budget_ms) {
    return { ...base, rejected_candidates: rejected("time_budget_exhausted"), reason_codes: ["time_budget_exhausted"] };
  }
  if (input.budget.cost_used >= input.budget.cost_budget) {
    return { ...base, rejected_candidates: rejected("cost_budget_exhausted"), reason_codes: ["cost_budget_exhausted"] };
  }

  const selected = input.profiles.filter((candidate) => !rejectionReason(input, candidate)).sort(compareCandidates)[0];
  if (!selected) return { ...base, rejected_candidates: rejected(), reason_codes: ["no_eligible_provider_profile"] };

  const requires_confirmation = input.current_adapter_kind === "codex" && selected.adapter_kind === "model-api";
  return {
    ...base,
    rejected_candidates: rejected("lower_route_rank").filter((candidate) => candidate.profile_id !== selected.id),
    selected_adapter_kind: selected.adapter_kind,
    selected_provider_profile_id: selected.id,
    ...(selected.estimated_cost ? { estimated_cost: selected.estimated_cost } : {}),
    requires_confirmation,
    reason_codes: requires_confirmation ? ["cross_kind_fallback_requires_confirmation"] : ["provider_route_selected"]
  };
}
