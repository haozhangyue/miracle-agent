import { describe, expect, it } from "vitest";
import { selectProviderRoute } from "../src/provider-routing";

const baseInput = {
  operation_id: "op_route_1",
  capability_requirements: ["text.generate", "structured_output"],
  allowed_adapter_kinds: ["model-api" as const],
  current_adapter_kind: "model-api" as const,
  profiles: [
    {
      id: "kimi-premium",
      provider: "kimi",
      adapter_kind: "model-api" as const,
      capabilities: ["text.generate", "structured_output"],
      executable: true,
      credential_available: true,
      health_status: "healthy" as const,
      user_priority: 1,
      cost_tier: 2
    },
    {
      id: "deepseek-default",
      provider: "deepseek",
      adapter_kind: "model-api" as const,
      capabilities: ["text.generate", "structured_output"],
      executable: true,
      credential_available: true,
      health_status: "healthy" as const,
      user_priority: 1,
      cost_tier: 1
    }
  ],
  budget: { attempts_used: 1, max_attempts: 3, elapsed_ms: 10, total_time_budget_ms: 1_000, cost_used: 0, cost_budget: 5 },
  decided_at: "2026-08-01T00:00:00.000Z"
};

describe("Provider Router", () => {
  it("selects the lowest-cost healthy profile that satisfies every capability", () => {
    const decision = selectProviderRoute(baseInput);
    expect(decision).toMatchObject({
      selected_adapter_kind: "model-api",
      selected_provider_profile_id: "deepseek-default",
      requires_confirmation: false
    });
    expect(decision.rejected_candidates).toContainEqual({ profile_id: "kimi-premium", reason_code: "lower_route_rank" });
  });

  it("requires confirmation before replacing a Codex tool-capable node", () => {
    expect(selectProviderRoute({
      ...baseInput,
      operation_id: "op_codex_1",
      capability_requirements: ["text.generate", "workspace.write"],
      allowed_adapter_kinds: ["codex", "model-api"],
      current_adapter_kind: "codex",
      failure: { error_code: "adapter_process_error", status: "failed" },
      profiles: [{
        ...baseInput.profiles[0],
        capabilities: ["text.generate", "workspace.write"],
        adapter_kind: "model-api"
      }]
    })).toMatchObject({
      selected_adapter_kind: "model-api",
      requires_confirmation: true,
      reason_codes: expect.arrayContaining(["cross_kind_fallback_requires_confirmation"])
    });
  });

  it("rejects fallback when failure facts omit the current Adapter kind", () => {
    const decision = selectProviderRoute({
      ...baseInput,
      current_adapter_kind: undefined,
      failed_profile_id: "deepseek-default",
      failure: { error_code: "network_error", status: "failed" }
    });
    expect(decision.selected_provider_profile_id).toBeUndefined();
    expect(decision.reason_codes).toContain("fallback_current_adapter_kind_missing");
  });

  it("does not treat Adapter process errors as automatic Model API Provider fallback", () => {
    const decision = selectProviderRoute({
      ...baseInput,
      failed_profile_id: "deepseek-default",
      failure: { error_code: "adapter_process_error", status: "failed" }
    });
    expect(decision.selected_provider_profile_id).toBeUndefined();
    expect(decision.reason_codes).toContain("fallback_error_not_recoverable");
  });

  it("rejects Codex-to-Codex fallback candidates instead of selecting them automatically", () => {
    const decision = selectProviderRoute({
      ...baseInput,
      allowed_adapter_kinds: ["codex", "model-api"],
      current_adapter_kind: "codex",
      failure: { error_code: "adapter_process_error", status: "failed" },
      profiles: [{ ...baseInput.profiles[0], id: "codex-route", adapter_kind: "codex" }]
    });
    expect(decision.selected_provider_profile_id).toBeUndefined();
    expect(decision.rejected_candidates).toContainEqual({
      profile_id: "codex-route",
      reason_code: "codex_fallback_requires_model_api_target"
    });
  });

  it.each(["rate_limit", "provider_temporary_5xx", "network_error", "adapter_timeout"])(
    "permits same-kind fallback for recoverable %s failures",
    (error_code) => {
      expect(selectProviderRoute({
        ...baseInput,
        failed_profile_id: "deepseek-default",
        failure: { error_code, status: "failed" }
      })).toMatchObject({ selected_provider_profile_id: "kimi-premium", requires_confirmation: false });
    }
  );

  it.each(["authentication_failed", "permission_denied", "content_policy", "provider_request_invalid", "unknown", "operation_cancelled", "operation_aborted"])(
    "does not automatically fallback for %s",
    (error_code) => {
      const decision = selectProviderRoute({
        ...baseInput,
        failed_profile_id: "deepseek-default",
        failure: { error_code, status: "failed" }
      });
      expect(decision.selected_provider_profile_id).toBeUndefined();
      expect(decision.reason_codes).toContain("fallback_error_not_recoverable");
    }
  );

  it("rejects configured but unverified profiles as non-executable", () => {
    const decision = selectProviderRoute({
      ...baseInput,
      profiles: [{ ...baseInput.profiles[0], id: "unverified", health_status: "configured_unverified" }]
    });
    expect(decision.selected_provider_profile_id).toBeUndefined();
    expect(decision.rejected_candidates).toContainEqual({ profile_id: "unverified", reason_code: "provider_not_healthy" });
  });

  it("reports the first fixed-order rejection reason for every unselected candidate", () => {
    const selected = { ...baseInput.profiles[0], id: "selected", user_priority: 0 };
    const decision = selectProviderRoute({
      ...baseInput,
      profiles: [
        { ...selected, id: "kind", adapter_kind: "codex" },
        { ...selected, id: "capability", capabilities: ["text.generate"] },
        { ...selected, id: "executable", executable: false },
        { ...selected, id: "credential", credential_available: false },
        { ...selected, id: "health", health_status: "degraded" },
        selected
      ]
    });

    expect(decision.selected_provider_profile_id).toBe("selected");
    expect(decision.rejected_candidates).toEqual(expect.arrayContaining([
      { profile_id: "kind", reason_code: "adapter_kind_not_allowed" },
      { profile_id: "capability", reason_code: "capability_incomplete" },
      { profile_id: "executable", reason_code: "adapter_not_executable" },
      { profile_id: "credential", reason_code: "credential_missing" },
      { profile_id: "health", reason_code: "provider_not_healthy" }
    ]));
  });

  it("uses user priority before cost tier and profile id as deterministic tie breakers", () => {
    const decision = selectProviderRoute({
      ...baseInput,
      profiles: [
        { ...baseInput.profiles[0], id: "a-cheapest", user_priority: 2, cost_tier: 0 },
        { ...baseInput.profiles[0], id: "z-priority", user_priority: 1, cost_tier: 1 },
        { ...baseInput.profiles[0], id: "a-priority", user_priority: 1, cost_tier: 1 }
      ]
    });
    expect(decision.selected_provider_profile_id).toBe("a-priority");
  });

  it("rejects a candidate whose estimated maximum cost exceeds the remaining budget", () => {
    const decision = selectProviderRoute({
      ...baseInput,
      profiles: [{
        ...baseInput.profiles[0],
        id: "over-budget",
        estimated_cost: { currency: "USD", min: 0.5, max: 2 }
      }],
      budget: { ...baseInput.budget, cost_used: 4, cost_budget: 5 }
    });
    expect(decision.selected_provider_profile_id).toBeUndefined();
    expect(decision.rejected_candidates).toContainEqual({
      profile_id: "over-budget",
      reason_code: "estimated_cost_exceeds_budget"
    });
  });

  it("never crosses adapter kind automatically from model-api", () => {
    const decision = selectProviderRoute({
      ...baseInput,
      allowed_adapter_kinds: ["codex", "model-api"],
      failed_profile_id: "deepseek-default",
      failure: { error_code: "network_error", status: "failed" },
      profiles: [{ ...baseInput.profiles[0], id: "codex-route", adapter_kind: "codex" }]
    });
    expect(decision.selected_provider_profile_id).toBeUndefined();
    expect(decision.rejected_candidates).toContainEqual({
      profile_id: "codex-route",
      reason_code: "automatic_fallback_kind_mismatch"
    });
  });

  it.each(["cancelled", "aborted", "unknown"] as const)(
    "blocks automatic fallback when the Attempt status is %s even with a recoverable code",
    (status) => {
      const decision = selectProviderRoute({
        ...baseInput,
        failed_profile_id: "deepseek-default",
        failure: { error_code: "network_error", status }
      });
      expect(decision.selected_provider_profile_id).toBeUndefined();
      expect(decision.reason_codes).toContain("fallback_error_not_recoverable");
    }
  );
});
