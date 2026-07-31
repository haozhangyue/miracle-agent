import { describe, expect, it } from "vitest";
import { providerCatalogEntrySchema } from "../src/schemas";

const entry = {
  id: "fixture-compatible",
  display_name: "Fixture Compatible",
  driver_id: "openai-compatible",
  profile: {
    id: "fixture-compatible-default",
    provider: "fixture-compatible",
    model: "fixture-chat",
    base_url: "http://127.0.0.1:9999",
    api_path: "/v1/chat/completions",
    credential_ref: "MODEL_API_FIXTURE_CREDENTIAL",
    verification_status: "configured_unverified",
    verified_at: "2026-07-31T00:00:00.000Z",
    docs_url: "https://example.invalid/provider-docs"
  },
  credential: { key: "MODEL_API_FIXTURE_CREDENTIAL", source: "env" },
  documentation: {
    official_url: "https://example.invalid/provider-docs",
    verified_at: "2026-07-31T00:00:00.000Z"
  },
  capabilities: ["model.call"],
  cancellation: "http_abort"
};

describe("provider catalog contract", () => {
  it("accepts a credential-reference-only provider catalog entry", () => {
    const parsed = providerCatalogEntrySchema.parse(entry);
    expect(parsed.profile.credential_ref).toBe("MODEL_API_FIXTURE_CREDENTIAL");
    expect(JSON.stringify(parsed)).not.toContain("fixture-secret");
  });

  it("rejects a catalog entry whose credential key does not match its profile reference", () => {
    expect(() => providerCatalogEntrySchema.parse({
      ...entry,
      credential: { key: "UNRELATED_SECRET", source: "env" }
    })).toThrow(/credential/i);
  });
});
