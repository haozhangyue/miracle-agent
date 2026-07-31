import { describe, expect, it } from "vitest";
import type { AdapterManifest, ProviderProfile } from "@miracle/core";
import { authorizeProviderCredential } from "../src/model-api-authorization";

const profile: ProviderProfile = {
  id: "provider-a-default",
  provider: "provider-a",
  model: "fixture-chat",
  base_url: "https://provider.example",
  credential_ref: "MODEL_API_FIXTURE_CREDENTIAL",
  verification_status: "configured_unverified"
};

function manifest(requiredCredentials: AdapterManifest["required_credentials"]): AdapterManifest {
  return {
    id: "model-api-compatible-adapter",
    kind: "model-api",
    display_name: "Model API Compatible Adapter",
    version: "0.1.0",
    status: "experimental",
    description: "Fixture",
    execution_mode: "external",
    capabilities: ["model.call"],
    supported_providers: ["provider-a"],
    default_provider: "provider-a",
    required_credentials: requiredCredentials,
    provider_profiles: [profile],
    runtime: { local_executor: "external-api", can_execute: true }
  };
}

describe("authorizeProviderCredential", () => {
  it("rejects a missing credential requirement", () => {
    expect(authorizeProviderCredential(manifest([]), profile)).toEqual({ authorized: false });
  });

  it("rejects a non-env credential source", () => {
    expect(authorizeProviderCredential(manifest([{ key: profile.credential_ref, label: "Fixture", source: "keychain", required: true }]), profile)).toEqual({ authorized: false });
  });

  it("rejects a credential whose provider scope excludes the profile", () => {
    expect(authorizeProviderCredential(manifest([{ key: profile.credential_ref, label: "Fixture", source: "env", required: true, providers: ["provider-b"] }]), profile)).toEqual({ authorized: false });
  });

  it("accepts a declared env credential whose provider scope includes the profile", () => {
    expect(authorizeProviderCredential(manifest([{ key: profile.credential_ref, label: "Fixture", source: "env", required: true, providers: ["provider-a"] }]), profile)).toMatchObject({
      authorized: true,
      credential: { key: profile.credential_ref, source: "env" }
    });
  });
});
