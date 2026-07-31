import type { AdapterCredentialRequirement, AdapterManifest, ProviderProfile } from "@miracle/core";

export type ProviderCredentialAuthorization =
  | { authorized: false }
  | { authorized: true; credential: AdapterCredentialRequirement };

export function authorizeProviderCredential(manifest: AdapterManifest, profile: ProviderProfile): ProviderCredentialAuthorization {
  const credential = manifest.required_credentials.find((candidate) => candidate.key === profile.credential_ref);
  if (
    !credential
    || credential.source !== "env"
    || (credential.providers !== undefined && !credential.providers.includes(profile.provider))
  ) {
    return { authorized: false };
  }
  return { authorized: true, credential };
}
