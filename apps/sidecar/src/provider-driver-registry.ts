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
    if (input.driver_id) {
      const driver = this.resolveByDriverId(input.driver_id);
      return driver && this.resolveByProvider(input.provider) === driver ? driver : undefined;
    }
    return this.resolveByProvider(input.provider);
  }

  registeredDriverIds() {
    return Array.from(this.byDriverId.keys()).sort();
  }

  registeredDriverBindings() {
    return Array.from(this.byProvider.entries())
      .map(([provider, driver]) => ({ driver_id: driver.id, provider }))
      .sort((left, right) => left.provider.localeCompare(right.provider));
  }
}

export function createProviderDriverRegistry() {
  return new ProviderDriverRegistry()
    .register({ driver: openAiCompatibleDriver, providers: ["fixture-compatible"] })
    .register({ driver: deepseekDriver, providers: ["deepseek"] })
    .register({ driver: kimiDriver, providers: ["kimi"] })
    .register({ driver: minimaxDriver, providers: ["minimax"] });
}
