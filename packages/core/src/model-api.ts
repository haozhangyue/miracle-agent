export type {
  AdapterError,
  ModelApiRequest,
  ModelApiUsage,
  NormalizedModelResponse,
  ProviderDriver,
  ProviderProfile,
  ProviderVerificationStatus
} from "./types";

export function isOriginRelativeApiPath(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  const origin = new URL("https://miracle.invalid");
  try {
    const resolved = new URL(value, origin);
    return resolved.origin === origin.origin && resolved.username.length === 0 && resolved.password.length === 0;
  } catch {
    return false;
  }
}
