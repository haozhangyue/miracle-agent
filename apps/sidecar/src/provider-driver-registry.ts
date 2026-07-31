import type { ProviderDriver } from "@miracle/core";
import { deepseekDriver } from "./provider-drivers/deepseek";
import { kimiDriver } from "./provider-drivers/kimi";
import { minimaxDriver } from "./provider-drivers/minimax";
import { openAiCompatibleDriver } from "./provider-drivers/openai-compatible";

export interface ProviderDriverRegistration {
  driver: ProviderDriver;
  providers: string[];
}

export class ProviderDriverRegistry {
  private readonly byDriverId = new Map<string, ProviderDriver>();
  private readonly byProvider = new Map<string, ProviderDriver>();

  register(registration: ProviderDriverRegistration) {
    this.byDriverId.set(registration.driver.id, registration.driver);
    for (const provider of registration.providers) this.byProvider.set(provider, registration.driver);
    return this;
  }

  resolveByDriverId(driverId: string) {
    return this.byDriverId.get(driverId);
  }

  resolveByProvider(provider: string) {
    return this.byProvider.get(provider);
  }

  resolve(input: { driver_id?: string; provider: string }) {
    if (input.driver_id) return this.resolveByDriverId(input.driver_id);
    return this.resolveByProvider(input.provider);
  }

  registeredDriverIds() {
    return Array.from(this.byDriverId.keys()).sort();
  }
}

export function createProviderDriverRegistry() {
  return new ProviderDriverRegistry()
    .register({ driver: openAiCompatibleDriver, providers: ["fixture-compatible"] })
    .register({ driver: deepseekDriver, providers: ["deepseek"] })
    .register({ driver: kimiDriver, providers: ["kimi"] })
    .register({ driver: minimaxDriver, providers: ["minimax"] });
}
