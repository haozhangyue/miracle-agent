import { describe, expect, it } from "vitest";
import { createProviderDriverRegistry } from "../src/provider-driver-registry";
import { openAiCompatibleDriver } from "../src/provider-drivers/openai-compatible";

describe("ProviderDriverRegistry", () => {
  it("resolves fixture-compatible through the registered openai-compatible driver", () => {
    const registry = createProviderDriverRegistry();
    expect(registry.resolveByDriverId("openai-compatible")).toBe(openAiCompatibleDriver);
    expect(registry.resolveByProvider("fixture-compatible")).toBe(openAiCompatibleDriver);
  });

  it("does not silently fall back for an unregistered driver", () => {
    const registry = createProviderDriverRegistry();
    expect(registry.resolveByDriverId("not-registered")).toBeUndefined();
    expect(registry.resolveByProvider("not-registered")).toBeUndefined();
  });

  it.each([
    ["deepseek", "deepseek"],
    ["kimi", "kimi"],
    ["minimax", "minimax"]
  ])("registers %s with its own Driver", (provider, driverId) => {
    const registry = createProviderDriverRegistry();
    expect(registry.resolveByProvider(provider)?.id).toBe(driverId);
    expect(registry.resolveByDriverId(driverId)?.id).toBe(driverId);
  });
});
