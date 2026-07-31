import { providerCatalogEntrySchema, type ProviderCatalogEntry } from "@miracle/core";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type ProviderHealthStatus = "missing_credential" | "configured_unverified" | "healthy" | "degraded" | "unavailable";

export interface ProviderHealthProjection {
  id: string;
  display_name: string;
  driver_id: string;
  driver_registered: boolean;
  profile: ProviderCatalogEntry["profile"];
  credential: {
    key: string;
    source: ProviderCatalogEntry["credential"]["source"];
    configured: boolean;
  };
  documentation: ProviderCatalogEntry["documentation"];
  capabilities: string[];
  cancellation: "http_abort";
  verification_status: ProviderCatalogEntry["profile"]["verification_status"];
  health_status: ProviderHealthStatus;
}

export async function readProviderCatalog(workspace: string): Promise<ProviderCatalogEntry[]> {
  const directory = path.join(workspace, "providers");
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name));
    return Promise.all(files.map(async (file) => providerCatalogEntrySchema.parse(JSON.parse(await readFile(path.join(directory, file.name), "utf8")) as unknown)));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export function buildProviderHealthProjection(
  entries: readonly ProviderCatalogEntry[],
  input: { credentialKeys: readonly string[]; registeredDriverIds: readonly string[] }
): ProviderHealthProjection[] {
  const credentials = new Set(input.credentialKeys);
  const drivers = new Set(input.registeredDriverIds);
  return entries.map((entry) => {
    const configured = entry.credential.source === "env" && credentials.has(entry.credential.key);
    return {
      id: entry.id,
      display_name: entry.display_name,
      driver_id: entry.driver_id,
      driver_registered: drivers.has(entry.driver_id),
      profile: entry.profile,
      credential: { ...entry.credential, configured },
      documentation: entry.documentation,
      capabilities: entry.capabilities,
      cancellation: entry.cancellation,
      verification_status: entry.profile.verification_status,
      health_status: configured ? entry.profile.verification_status : "missing_credential"
    };
  });
}
