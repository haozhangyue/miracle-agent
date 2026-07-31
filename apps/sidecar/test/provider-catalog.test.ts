import { describe, expect, it } from "vitest";
import type { ProviderCatalogEntry } from "@miracle/core";
import { buildProviderHealthProjection } from "../src/provider-catalog";

const catalogEntry = {
  id: "fixture-compatible",
  display_name: "Fixture Compatible",
  driver_id: "not-registered",
  profile: {
    id: "fixture-compatible-default",
    provider: "fixture-compatible",
    model: "fixture-chat",
    base_url: "http://127.0.0.1:9999",
    credential_ref: "MODEL_API_FIXTURE_CREDENTIAL",
    verification_status: "configured_unverified"
  },
  credential: { key: "MODEL_API_FIXTURE_CREDENTIAL", source: "env" },
  documentation: { official_url: "https://example.invalid/docs", verified_at: "2026-07-31T00:00:00.000Z" },
  capabilities: ["model.call"],
  cancellation: "http_abort"
} satisfies ProviderCatalogEntry;

describe("provider catalog health projection", () => {
  it("keeps configured_unverified distinct from healthy and surfaces an unregistered driver", () => {
    const [projection] = buildProviderHealthProjection([catalogEntry], { credentialKeys: ["MODEL_API_FIXTURE_CREDENTIAL"], driverProviderBindings: [] });
    expect(projection).toMatchObject({
      id: "fixture-compatible",
      driver_registered: false,
      credential: { configured: true },
      verification_status: "configured_unverified",
      health_status: "driver_unregistered"
    });
  });

  it("reports missing_credential without exposing credential material", () => {
    const [projection] = buildProviderHealthProjection([catalogEntry], {
      credentialKeys: [],
      driverProviderBindings: [{ driver_id: "not-registered", provider: "fixture-compatible" }]
    });
    expect(projection).toMatchObject({
      credential: { configured: false },
      health_status: "missing_credential"
    });
    expect(JSON.stringify(projection)).not.toContain("fixture-secret");
  });

  it.each(["healthy", "degraded"] as const)("never projects %s as executable health without a registered Driver", (verificationStatus) => {
    const [projection] = buildProviderHealthProjection([
      { ...catalogEntry, profile: { ...catalogEntry.profile, verification_status: verificationStatus } }
    ], { credentialKeys: ["MODEL_API_FIXTURE_CREDENTIAL"], driverProviderBindings: [] });

    expect(projection).toMatchObject({
      driver_registered: false,
      verification_status: verificationStatus,
      health_status: "driver_unregistered"
    });
  });

  it("does not report a Driver as registered when its ID is bound to another provider", () => {
    const [projection] = buildProviderHealthProjection([{
      ...catalogEntry,
      driver_id: "minimax",
      profile: { ...catalogEntry.profile, provider: "deepseek" }
    }], {
      credentialKeys: ["MODEL_API_FIXTURE_CREDENTIAL"],
      driverProviderBindings: [{ driver_id: "minimax", provider: "minimax" }]
    });

    expect(projection).toMatchObject({
      driver_registered: false,
      health_status: "driver_unregistered"
    });
  });
});
